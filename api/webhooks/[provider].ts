import { PaymentService, NeonPaymentRepository, type Payment } from '../../src/server';
import type { NeonDbClient } from '../../src/server/neon';
import { MockPaymentProvider } from '../../src/server/providers/MockPaymentProvider';
import { ProviderError } from '../../src/server/providers/PaymentProvider';
import {
  HttpError,
  consumeRateLimit,
  paymentContext,
  readRawBody,
  publicPayment,
  fallbackWebhookEventId,
  recordWebhookReceipt,
  serverClient,
  sendError,
  type ApiRequest,
  type ApiResponse,
} from '../_shared';

export const config = { api: { bodyParser: false, sizeLimit: '256kb' } };
const REAL_PROVIDERS = new Set(['taypi', 'culqi', 'mercadopago']);

export default async function handler(request: ApiRequest & Partial<AsyncIterable<Uint8Array>>, response: ApiResponse): Promise<void> {
  if (request.method !== 'POST') { response.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  let rawBody = '';
  let client: NeonDbClient | undefined;
  let receiptEventId = '';
  const providerName = singleQuery(request.query?.provider)?.toLowerCase() ?? '';
  try {
    rawBody = await readRawBody(request);
    const context = paymentContextForWebhook(providerName);
    client = context.client;
    receiptEventId = fallbackWebhookEventId(request, rawBody);
    const verified = await context.provider.verifyWebhook({ rawBody, headers: request.headers });
    await consumeRateLimit(client, `webhook:${providerName}`, 120, 60);
    receiptEventId = verified.eventId;
    const result = await context.service.processWebhook(verified);
    await recordWebhookReceipt(client, {
      provider: providerName,
      providerEventId: receiptEventId,
      rawBody,
      outcome: result.changed ? 'ACCEPTED' : 'DUPLICATE',
    });
    response.status(200).json({ ok: true, changed: result.changed, payment: publicPayment(result.payment as Payment) });
  } catch (error) {
    // Do not let unauthenticated traffic turn the audit table into a write
    // amplification target. Only deliveries that passed provider signature
    // and timestamp verification are eligible for a durable receipt.
    if (client && rawBody && receiptEventId && !isSignatureFailure(error)) {
      const errorCode = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : 'WEBHOOK_ERROR';
      await recordWebhookReceipt(client, {
        provider: providerName,
        providerEventId: receiptEventId,
        rawBody,
        outcome: isReceiptRejection(error) ? 'REJECTED' : 'ERROR',
        errorCode,
      });
    }
    if (error instanceof HttpError) { response.status(error.statusCode).json({ ok: false, error: error.message }); return; }
    if (error instanceof ProviderError) { response.status(error.statusCode).json({ ok: false, code: error.code, error: error.message }); return; }
    // Preserve the framework-neutral webhook contract: provider/payment
    // identity misses are not server faults and should be retry-classified by
    // the provider separately from malformed or mismatched events.
    if (error instanceof Error && /not found/i.test(error.message)) {
      response.status(404).json({ ok: false, code: 'NOT_FOUND', error: error.message });
      return;
    }
    if (error instanceof Error && /mismatch|invalid|payable/i.test(error.message)) {
      response.status(400).json({ ok: false, code: 'INVALID_WEBHOOK', error: error.message });
      return;
    }
    sendError(response, error);
  }
}

function paymentContextForWebhook(name: string) {
  if (!name) throw new HttpError(404, 'Webhook provider is required');
  if (name === 'mock') {
    if (isHostedDeployment()) throw new HttpError(404, 'Not found');
    const client = serverClient();
    const provider = new MockPaymentProvider({ allowUnknownWebhook: true });
    const service = new PaymentService({ provider, repository: new NeonPaymentRepository(client) });
    return { provider, service, client };
  }
  if (!REAL_PROVIDERS.has(name)) throw new HttpError(404, 'Webhook provider is not active');
  const client = serverClient();
  const context = paymentContext(client);
  if (context.provider.name !== name) throw new HttpError(404, 'Webhook provider is not active');
  return { ...context, client };
}

function singleQuery(value: string | string[] | undefined): string | undefined {
  const result = Array.isArray(value) ? value[0] : value;
  return result?.trim() || undefined;
}

function isHostedDeployment(): boolean {
  const vercelEnvironment = process.env.VERCEL_ENV?.trim().toLowerCase();
  return process.env.NODE_ENV === 'production' || vercelEnvironment === 'production' || vercelEnvironment === 'preview';
}

function isReceiptRejection(error: unknown): boolean {
  if (error instanceof HttpError) return error.statusCode < 500;
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  if (['INVALID_SIGNATURE', 'INVALID_WEBHOOK', 'P0002', '22023'].includes(code)) return true;
  return error instanceof Error && /not found|mismatch|invalid|payable/i.test(error.message);
}

function isSignatureFailure(error: unknown): boolean {
  if (error instanceof ProviderError && error.code === 'INVALID_SIGNATURE') return true;
  return error instanceof Error && /signature|timestamp/i.test(error.message);
}
