import { randomUUID } from 'node:crypto';
import { handleWebhook, MockPaymentProvider, PaymentService, SupabasePaymentRepository } from '../../../src/server';
import { serverClient, type ApiRequest, type ApiResponse } from '../../_shared';

/** Development-only simulator. It routes through identical webhook validation/transition code. */
export default async function handler(request: ApiRequest & { query?: Record<string, string | string[] | undefined> }, response: ApiResponse): Promise<void> {
  if (isProduction()) { response.status(404).json({ error: 'Not found' }); return; }
  if (request.method !== 'POST') { response.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const reference = String(request.query?.reference ?? '');
    const client = serverClient();
    const { data: payment, error } = await client.from('payments').select('reference, provider, provider_payment_id, amount_cents, currency').eq('reference', reference).maybeSingle();
    if (error) throw error;
    if (!payment || payment.provider !== 'mock' || !payment.provider_payment_id) { response.status(404).json({ error: 'Payment not found' }); return; }
    const provider = new MockPaymentProvider({ allowUnknownWebhook: true });
    const service = new PaymentService({ provider, repository: new SupabasePaymentRepository(client) });
    const rawBody = JSON.stringify({
      event_id: `mock_evt_${randomUUID()}`, event_type: 'payment.paid', status: 'PAID',
      provider_payment_id: payment.provider_payment_id, reference: payment.reference,
      amount_cents: payment.amount_cents, currency: payment.currency,
    });
    const result = await handleWebhook({ rawBody, headers: {} }, provider, service);
    response.status(result.status).json(result.body);
  } catch { response.status(500).json({ error: 'Mock payment could not be processed' }); }
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
}
