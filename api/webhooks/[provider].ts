import { handleWebhook, PaymentService, SupabasePaymentRepository, type Payment } from '../../src/server';
import { MockPaymentProvider } from '../../src/server/providers/MockPaymentProvider';
import {
  HttpError,
  paymentContext,
  readRawBody,
  publicPayment,
  serverClient,
  sendError,
  type ApiRequest,
  type ApiResponse,
} from '../_shared';

export const config = { api: { bodyParser: false, sizeLimit: '256kb' } };
const REAL_PROVIDERS = new Set(['taypi', 'culqi', 'mercadopago']);

export default async function handler(request: ApiRequest & Partial<AsyncIterable<Uint8Array>>, response: ApiResponse): Promise<void> {
  if (request.method !== 'POST') { response.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  const providerName = singleQuery(request.query?.provider)?.toLowerCase() ?? '';
  try {
    const body = await readRawBody(request);
    const context = paymentContextForWebhook(providerName);
    const result = await handleWebhook({ rawBody: body, headers: request.headers }, context.provider, context.service);
    const responseBody = result.body.payment && typeof result.body.payment === 'object'
      ? { ...result.body, payment: publicPayment(result.body.payment as Payment) }
      : result.body;
    response.status(result.status).json(responseBody);
  } catch (error) {
    if (error instanceof HttpError) { response.status(error.statusCode).json({ ok: false, error: error.message }); return; }
    sendError(response, error);
  }
}

function paymentContextForWebhook(name: string) {
  if (!name) throw new HttpError(404, 'Webhook provider is required');
  if (name === 'mock') {
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') throw new HttpError(404, 'Not found');
    const client = serverClient();
    const provider = new MockPaymentProvider({ allowUnknownWebhook: true });
    const service = new PaymentService({ provider, repository: new SupabasePaymentRepository(client) });
    return { provider, service };
  }
  if (!REAL_PROVIDERS.has(name)) throw new HttpError(404, 'Webhook provider is not active');
  const client = serverClient();
  const context = paymentContext(client);
  if (context.provider.name !== name) throw new HttpError(404, 'Webhook provider is not active');
  return context;
}

function singleQuery(value: string | string[] | undefined): string | undefined {
  const result = Array.isArray(value) ? value[0] : value;
  return result?.trim() || undefined;
}
