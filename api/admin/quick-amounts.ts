import {
  HttpError,
  parseBody,
  requireAdmin,
  sendError,
  serverClient,
  type ApiRequest,
  type ApiResponse,
} from '../_shared';

const MAX_AMOUNT_CENTS = 1_000_000;
const MAX_ITEMS = 12;

export default async function handler(request: ApiRequest, response: ApiResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'PUT') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const client = serverClient();
    const admin = await requireAdmin(request, client);
    if (request.method === 'GET') {
      response.status(200).json({ amounts: await listAmounts(client) });
      return;
    }

    const body = parseBody(request.body);
    const amounts = parseQuickAmounts(body.amounts);
    const { data, error } = await client.rpc('replace_quick_amounts', {
      p_amounts: amounts.map((amountCents) => ({ amount_cents: amountCents })),
      p_actor_id: admin.id,
    });
    if (error) throw error;
    response.status(200).json({ amounts: (data ?? []).map(toPublicAmount) });
  } catch (error) {
    sendAdminError(response, error);
  }
}

export function parseQuickAmounts(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ITEMS) {
    throw new HttpError(400, `amounts must contain between 1 and ${MAX_ITEMS} items`);
  }
  const result = value.map((item) => {
    const raw = typeof item === 'number' ? item
      : item && typeof item === 'object' && 'amountCents' in item ? (item as { amountCents?: unknown }).amountCents
      : item && typeof item === 'object' && 'amount_cents' in item ? (item as { amount_cents?: unknown }).amount_cents
      : undefined;
    const amount = typeof raw === 'number' ? raw
      : typeof raw === 'string' && /^[1-9]\d*$/.test(raw) ? Number(raw)
      : NaN;
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT_CENTS) {
      throw new HttpError(400, 'Each quick amount must be a positive integer up to 1000000 cents');
    }
    return amount;
  });
  if (new Set(result).size !== result.length) throw new HttpError(400, 'Quick amounts must be unique');
  return result;
}

async function listAmounts(client: ReturnType<typeof serverClient>): Promise<Record<string, unknown>[]> {
  const { data, error } = await client
    .from('quick_amounts')
    .select('id, amount_cents, sort_order')
    .eq('active', true)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(toPublicAmount);
}

function toPublicAmount(row: Record<string, unknown>): Record<string, unknown> {
  return { id: row.id, amountCents: row.amount_cents, sortOrder: row.sort_order };
}

function sendAdminError(response: ApiResponse, error: unknown): void {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code);
    if (code === 'P0001') {
      response.status(409).json({ error: 'No se pudo guardar la configuración administrativa.' });
      return;
    }
  }
  sendError(response, error);
}
