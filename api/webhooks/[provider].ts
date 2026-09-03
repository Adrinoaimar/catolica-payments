import { handleWebhook, PaymentService, SupabasePaymentRepository } from '../../src/server';
import { MockPaymentProvider } from '../../src/server/providers/MockPaymentProvider';
import { paymentContext, serverClient, type ApiRequest, type ApiResponse } from '../_shared';

export const config = { api: { bodyParser: false } };

export default async function handler(request: ApiRequest & { query?: Record<string, string | string[] | undefined> }, response: ApiResponse): Promise<void> {
  if (request.method !== 'POST') { response.status(405).json({ error: 'Method not allowed' }); return; }
  const providerName = String(request.query?.provider ?? '');
  try {
    const body = await rawBody(request);
    const context = paymentContextForWebhook(providerName);
    const result = await handleWebhook({ rawBody: body, headers: request.headers }, context.provider, context.service);
    response.status(result.status).json(result.body);
  } catch (error) { response.status(500).json({ ok: false, error: 'Webhook configuration error' }); }
}

function paymentContextForWebhook(name: string) {
  if (name === 'mock') {
    // Mock endpoint is development-only and must not depend on per-process provider state.
    const provider = new MockPaymentProvider({ allowUnknownWebhook: process.env.NODE_ENV !== 'production' });
    const service = new PaymentService({ provider, repository: new SupabasePaymentRepository(serverClient()) });
    return { provider, service };
  }
  const context = paymentContext();
  if (context.provider.name !== name) throw new Error('Webhook provider is not active');
  return context;
}

async function rawBody(request: ApiRequest): Promise<string> {
  if (typeof request.body === 'string') return request.body;
  if (request.body instanceof Uint8Array) return new TextDecoder().decode(request.body);
  const stream = request as unknown as AsyncIterable<Uint8Array>;
  if (stream && stream[Symbol.asyncIterator]) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return new TextDecoder().decode(concat(chunks));
  }
  return JSON.stringify(request.body ?? {});
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}
