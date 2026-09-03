import {
  cashPaymentContext,
  parseBody,
  parseRequestAmount,
  paymentContext,
  paymentRepository,
  publicPayment,
  publicProviderPayment,
  requireUser,
  sendError,
  serverClient,
  HttpError,
  type ApiRequest,
  type ApiResponse,
} from './_shared';
import { PaymentService, type PaymentStatus } from '../src/server';

const STATUSES: PaymentStatus[] = ['PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED'];
export const config = { api: { bodyParser: { sizeLimit: '64kb' } } };

export default async function handler(request: ApiRequest, response: ApiResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'POST') { response.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const client = serverClient();
    const user = await requireUser(request, client);
    if (request.method === 'GET') {
      const repository = paymentRepository(client);
      // Expiration is enforced server-side even when no scheduled job has run.
      await new PaymentService({ repository }).expirePayments();
      const filters = parseFilters(request.query, user.role);
      const payments = await repository.list(filters);
      response.status(200).json({ payments: payments.map(publicPayment), count: payments.length });
      return;
    }

    const body = parseBody(request.body);
    const amountCents = parseRequestAmount(body);
    const method = body.method === undefined ? 'DIGITAL' : String(body.method).toUpperCase();
    if (method !== 'DIGITAL' && method !== 'CASH') throw new HttpError(400, 'method must be DIGITAL or CASH');
    if (method === 'CASH') {
      const payment = await cashPaymentContext(client).createCashPayment({ amountCents, createdBy: user.id });
      response.status(201).json({ payment: publicPayment(payment) });
      return;
    }

    const { service } = paymentContext(client);
    const result = await service.createDigitalPayment({ amountCents, createdBy: user.id });
    response.status(201).json({ payment: publicPayment(result.payment), providerPayment: publicProviderPayment(result.providerPayment) });
  } catch (error) { sendError(response, error); }
}

function parseFilters(query: ApiRequest['query'], role: 'ADMIN' | 'CASHIER') {
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
  const rawLimit = optionalQuery(query, 'limit');
  const limit = rawLimit === undefined ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, 'limit must be between 1 and 200');
  return {
    ...(status ? { status: status as PaymentStatus } : {}),
    ...(method === 'CASH' ? { provider: 'CASH' } : provider ? { provider: provider.toUpperCase() === 'CASH' ? 'CASH' : provider.toLowerCase() } : {}),
    ...(createdBy ? { createdBy } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit,
  };
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
