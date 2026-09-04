import {
  cashPaymentContext,
  consumeRateLimit,
  parseBody,
  parseRequestAmount,
  paymentContext,
  paymentRepository,
  publicPayment,
  publicProviderPayment,
  parseIdempotencyKey,
  requireUser,
  sendError,
  serverClient,
  HttpError,
  type ApiRequest,
  type ApiResponse,
} from './_shared';
import type { PaymentMethod, PaymentStatus } from '../src/server';

const STATUSES: PaymentStatus[] = ['PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED'];
export const config = { api: { bodyParser: { sizeLimit: '64kb' } } };

export default async function handler(request: ApiRequest, response: ApiResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'POST') { response.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const client = serverClient();
    const user = await requireUser(request, client);
    if (request.method === 'GET') {
      const repository = paymentRepository(client);
      // Expiry/reconciliation runs on the scheduler. Listing must not fan out
      // to TAYPI once per dashboard request.
      await consumeRateLimit(client, `payment:list:user:${user.id}`, 120, 60);
      const filters = restrictFiltersForRole(parseFilters(request.query, user.role), user.role);
      const payments = await repository.list(filters);
      response.status(200).json({
        payments: payments.map(publicPayment),
        count: payments.length,
        offset: filters.offset ?? 0,
        hasMore: payments.length === filters.limit,
      });
      return;
    }

    await consumeRateLimit(client, `payment:create:user:${user.id}`, 30, 60);
    const body = parseBody(request.body);
    const amountCents = parseRequestAmount(body);
    const idempotencyKey = parseIdempotencyKey(request);
    const method = body.method === undefined ? 'DIGITAL' : String(body.method).toUpperCase();
    if (method !== 'DIGITAL' && method !== 'CASH') throw new HttpError(400, 'method must be DIGITAL or CASH');
    if (method === 'DIGITAL' && !idempotencyKey) {
      throw new HttpError(400, 'Idempotency-Key is required for digital payments');
    }
    if (method === 'CASH') {
      const payment = await cashPaymentContext(client).createCashPayment({ amountCents, createdBy: user.id, idempotencyKey });
      response.status(201).json({ payment: publicPayment(payment) });
      return;
    }

    const { service } = paymentContext(client);
    const result = await service.createDigitalPayment({ amountCents, createdBy: user.id, idempotencyKey });
    response.status(201).json({ payment: publicPayment(result.payment), providerPayment: publicProviderPayment(result.providerPayment) });
  } catch (error) { sendError(response, error); }
}

export function parseFilters(query: ApiRequest['query'], role: 'ADMIN' | 'CASHIER') {
  const status = optionalQuery(query, 'status')?.toUpperCase();
  if (status && !STATUSES.includes(status as PaymentStatus)) throw new HttpError(400, 'Invalid status filter');
  const method = optionalQuery(query, 'method')?.toUpperCase();
  if (method && method !== 'DIGITAL' && method !== 'CASH') throw new HttpError(400, 'Invalid method filter');
  const provider = optionalQuery(query, 'provider');
  if (provider && !/^[a-z][a-z0-9_-]{1,31}$/i.test(provider)) throw new HttpError(400, 'Invalid provider filter');
  const createdBy = optionalQuery(query, 'createdBy');
  if (createdBy && role !== 'ADMIN') throw new HttpError(403, 'Only administrators can filter by cashier');
  const from = optionalDate(query, 'from');
  const to = optionalDate(query, 'to');
  if (from && to && from > to) throw new HttpError(400, 'Invalid date range');
  const minAmountCents = optionalAmountFilter(query, 'minAmountCents');
  const maxAmountCents = optionalAmountFilter(query, 'maxAmountCents');
  if (minAmountCents !== undefined && maxAmountCents !== undefined && minAmountCents > maxAmountCents) {
    throw new HttpError(400, 'Invalid amount range');
  }
  const rawLimit = optionalQuery(query, 'limit');
  const limit = rawLimit === undefined ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, 'limit must be between 1 and 200');
  const rawOffset = optionalQuery(query, 'offset');
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);
  if (!Number.isInteger(offset) || offset < 0 || offset > 50_000) throw new HttpError(400, 'offset must be between 0 and 50000');
  return {
    ...(status ? { status: status as PaymentStatus } : {}),
    ...(method ? { method: method as PaymentMethod } : {}),
    ...(method === 'CASH' ? { provider: 'CASH' } : provider ? { provider: provider.toUpperCase() === 'CASH' ? 'CASH' : provider.toLowerCase() } : {}),
    ...(createdBy ? { createdBy } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(minAmountCents !== undefined ? { minAmountCents } : {}),
    ...(maxAmountCents !== undefined ? { maxAmountCents } : {}),
    limit,
    ...(rawOffset === undefined ? {} : { offset }),
  };
}

/** Cashiers are limited to the institution's current Lima calendar day. */
export function restrictFiltersForRole<T extends ReturnType<typeof parseFilters>>(filters: T, role: 'ADMIN' | 'CASHIER'): T {
  if (role === 'ADMIN') return filters;
  const { from: todayFrom, to: todayTo } = limaTodayRange();
  const from = filters.from && filters.from > todayFrom ? filters.from : todayFrom;
  const to = filters.to && filters.to < todayTo ? filters.to : todayTo;
  return { ...filters, from, to };
}

function limaTodayRange(now = new Date()): { from: string; to: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  // Peru uses UTC-05:00. Constructing in UTC at 05:00 avoids server-local
  // timezone dependence while preserving the Lima calendar boundaries.
  const start = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), 5, 0, 0, 0));
  const end = new Date(start.getTime() + 24 * 60 * 60_000 - 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function optionalQuery(query: ApiRequest['query'], key: string): string | undefined {
  const raw = query?.[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalDate(query: ApiRequest['query'], key: string): string | undefined {
  const value = optionalQuery(query, key);
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new HttpError(400, `Invalid ${key} date`);
  return date.toISOString();
}

function optionalAmountFilter(query: ApiRequest['query'], key: string): number | undefined {
  const value = optionalQuery(query, key);
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) throw new HttpError(400, `${key} must be a non-negative integer`);
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new HttpError(400, `${key} is too large`);
  return amount;
}
