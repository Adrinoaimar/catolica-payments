import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

type Row = Record<string, any>;
type QueryResult = { data: any; error: Error | null };

const TABLES = new Set(['payments', 'payment_events', 'user_roles', 'quick_amounts', 'webhook_receipts', 'job_locks', 'api_rate_limits']);
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function tableName(value: string): string {
  if (!TABLES.has(value)) throw new Error(`Unsupported database table: ${value}`);
  return `public.${value}`;
}

function columnName(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`Unsupported database column: ${value}`);
  return `"${value}"`;
}

/** Small server-only adapter used by Vercel handlers. It intentionally exposes
 * only the operations the API needs; no credentials ever reach the browser. */
export class NeonDbClient {
  readonly sql: NeonQueryFunction<false, false>;
  constructor(connectionString = process.env.DATABASE_URL?.trim()) {
    if (!connectionString) throw new Error('DATABASE_URL is not configured');
    this.sql = neon(connectionString);
  }

  async query<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
    return this.sql.query(text, params) as unknown as Promise<T[]>;
  }

  async rpc(name: string, args: Record<string, unknown>): Promise<QueryResult> {
    if (!IDENTIFIER.test(name)) return { data: null, error: new Error('Invalid database function') };
    const keys = Object.keys(args);
    const jsonKeys = new Set(['p_provider_data', 'p_raw_payload', 'p_amounts']);
    const placeholders = keys.map((key, index) => jsonKeys.has(key) ? `$${index + 1}::jsonb` : `$${index + 1}`).join(', ');
    try {
      const values = keys.map((key) => jsonKeys.has(key) && typeof args[key] !== 'string' ? JSON.stringify(args[key]) : args[key]);
      const rows = await this.query<{ result: any }>(`select public.${name}(${placeholders}) as result`, values);
      const data = name === 'replace_quick_amounts' ? rows.map((row) => row.result) : (rows[0]?.result ?? null);
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  from(table: string): NeonTableQuery { return new NeonTableQuery(this, tableName(table)); }
}

class NeonTableQuery implements PromiseLike<QueryResult> {
  private operation: 'select' | 'insert' = 'select';
  private columns = '*';
  private values: Row | Row[] | null = null;
  private conditions: Array<{ sql: string; value?: unknown }> = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private rangeStart: number | null = null;
  private rangeEnd: number | null = null;
  private maxRows: number | null = null;
  private cardinality: 'many' | 'single' | 'maybeSingle' = 'many';

  constructor(private readonly client: NeonDbClient, private readonly table: string) {}
  select(columns = '*'): this { this.columns = columns; return this; }
  insert(values: Row | Row[]): this { this.operation = 'insert'; this.values = values; return this; }
  eq(column: string, value: unknown): this { this.conditions.push({ sql: `${columnName(column)} = $VALUE`, value }); return this; }
  neq(column: string, value: unknown): this { this.conditions.push({ sql: `${columnName(column)} <> $VALUE`, value }); return this; }
  gte(column: string, value: unknown): this { this.conditions.push({ sql: `${columnName(column)} >= $VALUE`, value }); return this; }
  lte(column: string, value: unknown): this { this.conditions.push({ sql: `${columnName(column)} <= $VALUE`, value }); return this; }
  not(column: string, operator: string, value: unknown): this {
    if (operator !== 'is') throw new Error(`Unsupported filter operator: ${operator}`);
    this.conditions.push({ sql: `${columnName(column)} IS NOT NULL`, value: undefined });
    return this;
  }
  order(column: string, options?: { ascending?: boolean }): this { this.orderBy = { column, ascending: options?.ascending !== false }; return this; }
  range(start: number, end: number): this { this.rangeStart = Math.max(0, start); this.rangeEnd = Math.max(start, end); return this; }
  limit(value: number): this { this.maxRows = Math.max(0, value); return this; }
  single(): this { this.cardinality = 'single'; return this; }
  maybeSingle(): this { this.cardinality = 'maybeSingle'; return this; }

  then<TResult1 = QueryResult, TResult2 = never>(onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<QueryResult> {
    try {
      const params: unknown[] = [];
      const bind = (value: unknown): string => { params.push(value); return `$${params.length}`; };
      let text: string;
      if (this.operation === 'insert') {
        const rows = Array.isArray(this.values) ? this.values : [this.values ?? {}];
        if (!rows.length) return { data: [], error: null };
        const keys = Object.keys(rows[0]);
        if (!keys.length || rows.some((row) => Object.keys(row).join(',') !== keys.join(','))) throw new Error('Insert rows must have the same columns');
        const tuples = rows.map((row) => `(${keys.map((key) => bind(row[key])).join(', ')})`).join(', ');
        text = `insert into ${this.table} (${keys.map(columnName).join(', ')}) values ${tuples} returning ${this.columns}`;
      } else {
        text = `select ${this.columns} from ${this.table}`;
        if (this.conditions.length) text += ` where ${this.conditions.map((item) => item.sql.replace('$VALUE', item.value === undefined ? 'NULL' : bind(item.value))).join(' and ')}`;
        if (this.orderBy) text += ` order by ${columnName(this.orderBy.column)} ${this.orderBy.ascending ? 'asc' : 'desc'}`;
        if (this.rangeStart !== null && this.rangeEnd !== null) {
          text += ` limit ${this.rangeEnd - this.rangeStart + 1} offset ${this.rangeStart}`;
        } else if (this.maxRows !== null) {
          text += ` limit ${this.maxRows}`;
        }
      }
      const rows = await this.client.query<Row>(text, params);
      if (this.cardinality === 'single') {
        if (rows.length !== 1) return { data: null, error: new Error('Expected exactly one row') };
        return { data: rows[0], error: null };
      }
      if (this.cardinality === 'maybeSingle') {
        if (rows.length > 1) return { data: null, error: new Error('Expected zero or one row') };
        return { data: rows[0] ?? null, error: null };
      }
      return { data: rows, error: null };
    } catch (error) {
      return { data: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }
}

export function neonClient(): NeonDbClient { return new NeonDbClient(); }
export type { QueryResult };
