import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  PaymentService,
  SupabasePaymentRepository,
  createPaymentProvider,
  solesToCents,
  type Payment,
  type PaymentProvider,
  type ProviderPayment,
} from '../src/server';
import { ProviderError } from '../src/server/providers/PaymentProvider';

export interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
}

export interface ApiResponse {
  status(code: number): ApiResponse;
  json(value: unknown): void;
  end(value?: unknown): void;
  setHeader?(name: string, value: string): void;
}

const MAX_BODY_BYTES = 256 * 1024;
const REFERENCE_PATTERN = /^CAT-\d{8}-[A-Z2-9]{6}$/;

export function serverClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new HttpError(503, 'Supabase server environment is not configured');
  try {
    return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  } catch {
    throw new HttpError(503, 'Supabase server environment is invalid');
  }
}

export async function requireUser(request: ApiRequest, client: SupabaseClient): Promise<{ id: string; role: 'ADMIN' | 'CASHIER' }> {
  const authorization = header(request.headers, 'authorization');
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token || token.length > 8192) throw new HttpError(401, 'Authentication required');
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Invalid session');
  const { data: roleRow, error: roleError } = await client
    .from('user_roles')
    .select('role')
    .eq('user_id', data.user.id)
    .maybeSingle();
  if (roleError) throw new HttpError(503, 'Could not load user role');
  if (!roleRow || !['ADMIN', 'CASHIER'].includes(roleRow.role)) throw new HttpError(403, 'Role not configured');
  return { id: data.user.id, role: roleRow.role as 'ADMIN' | 'CASHIER' };
}

export async function requireAdmin(request: ApiRequest, client: SupabaseClient): Promise<{ id: string; role: 'ADMIN' }> {
  const user = await requireUser(request, client);
  if (user.role !== 'ADMIN') throw new HttpError(403, 'Only administrators can cancel payments');
  return { id: user.id, role: 'ADMIN' };
}

export function paymentRepository(client = serverClient()): SupabasePaymentRepository {
  return new SupabasePaymentRepository(client);
}

export function paymentContext(client = serverClient()): { service: PaymentService; provider: PaymentProvider } {
  const provider = createPaymentProvider(process.env);
  if (isHostedDeployment() && provider.name === 'mock') {
    throw new HttpError(503, 'Real payment provider is not configured for production');
  }
  return { provider, service: new PaymentService({ provider, repository: paymentRepository(client) }) };
}

/** Consume a durable PostgreSQL bucket; in-memory counters are not safe on
 * ephemeral serverless instances. */
export async function consumeRateLimit(
  client: SupabaseClient,
  bucketKey: string,
  limit: number,
  windowSeconds = 60,
): Promise<void> {
  const { data, error } = await client.rpc('consume_api_rate_limit', {
    p_bucket_key: bucketKey,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) throw new HttpError(503, 'Rate limit is not configured');
  if (data !== true) throw new HttpError(429, 'Too many requests; try again later');
}

/** Cash ledger writes do not depend on a digital provider being configured. */
export function cashPaymentContext(client = serverClient()): PaymentService {
  return new PaymentService({ repository: paymentRepository(client) });
}

/** Match the API's tenant boundary for single-reference reads and actions. */
export function assertPaymentVisibleToUser(payment: Payment, user: { role: 'ADMIN' | 'CASHIER' }): void {
  if (user.role === 'ADMIN') return;
  const createdAt = Date.parse(payment.createdAt);
  const { from, to } = limaTodayRange();
  if (!Number.isFinite(createdAt) || createdAt < Date.parse(from) || createdAt > Date.parse(to)) {
    throw new HttpError(404, 'Payment not found');
  }
}

export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); this.name = 'HttpError'; }
}

export function parseBody(body: unknown): Record<string, unknown> {
  let value = body;
  if (value instanceof Uint8Array) value = new TextDecoder().decode(value);
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).byteLength > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    try { value = JSON.parse(value); } catch { throw new HttpError(400, 'Invalid JSON body'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'JSON object body required');
  return value as Record<string, unknown>;
}

export function parseRequestAmount(body: Record<string, unknown>): number {
  const rawCents = body.amount_cents ?? body.amountCents;
  if (rawCents !== undefined) {
    if (typeof rawCents === 'number' && Number.isSafeInteger(rawCents) && rawCents > 0) return rawCents;
    if (typeof rawCents === 'string' && /^[1-9]\d*$/.test(rawCents) && Number.isSafeInteger(Number(rawCents))) return Number(rawCents);
    throw new HttpError(400, 'amount_cents must be a positive integer');
  }
  const rawSoles = body.amount;
  if (typeof rawSoles !== 'string' && typeof rawSoles !== 'number') throw new HttpError(400, 'Amount is required');
  try { return solesToCents(rawSoles); } catch { throw new HttpError(400, 'Amount must use soles with up to two decimals'); }
}

export function parseReference(value: unknown): string {
  const reference = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!REFERENCE_PATTERN.test(reference)) throw new HttpError(400, 'Invalid reference');
  return reference;
}

export async function readRawBody(request: ApiRequest & Partial<AsyncIterable<Uint8Array>>): Promise<string> {
  if (typeof request.body === 'string') {
    if (new TextEncoder().encode(request.body).byteLength > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    return request.body;
  }
  if (request.body instanceof Uint8Array) {
    if (request.body.byteLength > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    return new TextDecoder().decode(request.body);
  }
  const stream = request as unknown as AsyncIterable<Uint8Array>;
  if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
      chunks.push(chunk);
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(output);
  }
  // This fallback is only for test adapters. Vercel production disables its
  // body parser for webhook routes, so signatures always use raw bytes.
  return JSON.stringify(parseBody(request.body));
}

export function publicPayment(payment: Payment): Record<string, unknown> {
  const providerData = payment.providerData ?? {};
  const qrCodeRaw = typeof providerData.qrCode === 'string' ? providerData.qrCode
    : typeof providerData.qr_code === 'string' ? providerData.qr_code
    : typeof providerData.qr_image === 'string' ? providerData.qr_image : undefined;
  const qrCode = qrCodeRaw ? normalizeQrCode(qrCodeRaw) : undefined;
  const checkoutUrl = typeof providerData.checkoutUrl === 'string' ? providerData.checkoutUrl
    : typeof providerData.checkout_url === 'string' ? providerData.checkout_url : undefined;
  const checkoutToken = typeof providerData.checkoutToken === 'string' ? providerData.checkoutToken
    : typeof providerData.checkout_token === 'string' ? providerData.checkout_token : undefined;
  return {
    id: payment.id,
    reference: payment.reference,
    amountCents: payment.amountCents,
    currency: payment.currency,
    provider: payment.provider.toUpperCase() === 'CASH' ? 'cash' : payment.provider.toLowerCase(),
    method: payment.provider.toUpperCase() === 'CASH' ? 'CASH' : 'DIGITAL',
    providerPaymentId: payment.providerPaymentId,
    status: payment.status,
    createdBy: payment.createdBy,
    createdAt: payment.createdAt,
    expiresAt: payment.expiresAt,
    paidAt: payment.paidAt,
    cancelledAt: payment.cancelledAt,
    ...(qrCode ? { qrCode } : {}),
    ...(checkoutUrl ? { checkoutUrl } : {}),
    ...(checkoutToken ? { checkoutToken } : {}),
  };
}

export function publicProviderPayment(payment: ProviderPayment): Record<string, unknown> {
  return {
    providerPaymentId: payment.providerPaymentId,
    checkoutUrl: payment.checkoutUrl,
    checkoutToken: payment.checkoutToken,
    qrCode: payment.qrCode,
    expiresAt: payment.expiresAt,
  };
}

export function sendError(response: ApiResponse, error: unknown): void {
  if (error instanceof HttpError) {
    if (error.statusCode === 429) response.setHeader?.('Retry-After', '60');
    response.status(error.statusCode).json({ error: error.message });
    return;
  }
  if (error instanceof ProviderError) { response.status(error.statusCode).json({ error: error.message, code: error.code }); return; }
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
  if (code === 'P0002') { response.status(404).json({ error: 'Payment not found' }); return; }
  if (code === '23505') { response.status(409).json({ error: 'Payment already exists' }); return; }
  if (code === '23514' || code === '22023') { response.status(400).json({ error: 'Invalid payment data' }); return; }
  if (error instanceof Error && /^Digital payment provider/i.test(error.message)) {
    response.status(503).json({ error: 'Digital payment provider is not configured' }); return;
  }
  if (error instanceof Error && /^(Amount|Invalid amount)/i.test(error.message)) {
    response.status(400).json({ error: error.message }); return;
  }
  console.error('API request failed', error instanceof Error ? error.message : 'unknown error');
  response.status(500).json({ error: 'Internal server error' });
}

export function header(headers: Record<string, string | string[] | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

export function parseIdempotencyKey(request: ApiRequest): string | undefined {
  const value = header(request.headers, 'idempotency-key')?.trim();
  if (value === undefined || value === '') return undefined;
  if (value.length < 16 || value.length > 200 || /[^\x21-\x7e]/.test(value)) {
    throw new HttpError(400, 'Idempotency-Key must contain 16 to 200 printable characters');
  }
  return value;
}

export type WebhookReceiptOutcome = 'ACCEPTED' | 'DUPLICATE' | 'REJECTED' | 'ERROR';

/**
 * Persist delivery metadata without storing another copy of a provider body.
 * Receipt failures never block the financial transition or the provider retry
 * path; payment_events remains the authoritative audit trail.
 */
export async function recordWebhookReceipt(
  client: SupabaseClient,
  input: {
    provider: string;
    providerEventId: string;
    rawBody: string;
    outcome: WebhookReceiptOutcome;
    errorCode?: string;
  },
): Promise<void> {
  const provider = input.provider.trim().toLowerCase();
  const providerEventId = input.providerEventId.trim().slice(0, 200);
  if (!provider || !providerEventId) return;
  const bodySha256 = createHash('sha256').update(input.rawBody, 'utf8').digest('hex');
  const { error } = await client.from('webhook_receipts').insert({
    provider,
    provider_event_id: providerEventId,
    body_sha256: bodySha256,
    outcome: input.outcome,
    error_code: input.errorCode?.trim().slice(0, 100) || null,
    processed_at: input.outcome === 'ACCEPTED' || input.outcome === 'DUPLICATE' ? new Date().toISOString() : null,
  });
  // A delivery receipt is append-once evidence. A repeated event ID is a
  // normal provider retry and must not overwrite the first body hash/outcome.
  if (error && error.code !== '23505') console.error('Could not persist webhook receipt', error.message);
}

export function fallbackWebhookEventId(request: ApiRequest, rawBody: string): string {
  const candidate = header(request.headers, 'taypi-webhook-id')
    ?? header(request.headers, 'x-webhook-id')
    ?? header(request.headers, 'x-event-id');
  return candidate?.trim().slice(0, 200) || `body:${createHash('sha256').update(rawBody, 'utf8').digest('hex')}`;
}

function isHostedDeployment(): boolean {
  const vercelEnvironment = process.env.VERCEL_ENV?.trim().toLowerCase();
  return process.env.NODE_ENV === 'production' || vercelEnvironment === 'production' || vercelEnvironment === 'preview';
}

function normalizeQrCode(value: string): string {
  if (/^data:/i.test(value) || /^https?:\/\//i.test(value)) return value;
  if (/^<svg[\s>]/i.test(value)) return `data:image/svg+xml,${encodeURIComponent(value)}`;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return `data:image/svg+xml;base64,${value}`;
  return value;
}

function limaTodayRange(now = new Date()): { from: string; to: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const start = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), 5, 0, 0, 0));
  return { from: start.toISOString(), to: new Date(start.getTime() + 24 * 60 * 60_000 - 1).toISOString() };
}
