import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PaymentService, SupabasePaymentRepository, createPaymentProvider, type PaymentProvider } from '../src/server';

export interface ApiRequest { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown; query?: Record<string, string | string[] | undefined>; }
export interface ApiResponse { status(code: number): ApiResponse; json(value: unknown): void; end(value?: unknown): void; }

export function serverClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase server environment is not configured');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function requireUser(request: ApiRequest, client: SupabaseClient): Promise<{ id: string; role: 'ADMIN' | 'CASHIER' }> {
  const authorization = request.headers.authorization ?? request.headers.Authorization;
  const token = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!token?.startsWith('Bearer ')) throw new HttpError(401, 'Authentication required');
  const { data, error } = await client.auth.getUser(token.slice(7));
  if (error || !data.user) throw new HttpError(401, 'Invalid session');
  const { data: roleRow, error: roleError } = await client.from('user_roles').select('role').eq('user_id', data.user.id).maybeSingle();
  if (roleError || !roleRow || !['ADMIN', 'CASHIER'].includes(roleRow.role)) throw new HttpError(403, 'Role not configured');
  return { id: data.user.id, role: roleRow.role as 'ADMIN' | 'CASHIER' };
}

export function paymentContext(): { service: PaymentService; provider: PaymentProvider } {
  const provider = createPaymentProvider(process.env);
  return { provider, service: new PaymentService({ provider, repository: new SupabasePaymentRepository(serverClient()) }) };
}

export class HttpError extends Error { constructor(readonly statusCode: number, message: string) { super(message); } }

export function parseBody(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') return JSON.parse(body) as Record<string, unknown>;
  if (body && typeof body === 'object') return body as Record<string, unknown>;
  return {};
}

export function sendError(response: ApiResponse, error: unknown): void {
  if (error instanceof HttpError) { response.status(error.statusCode).json({ error: error.message }); return; }
  console.error(error);
  response.status(500).json({ error: 'Internal server error' });
}
