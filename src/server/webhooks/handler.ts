import type { PaymentProvider } from '../providers/PaymentProvider';
import { ProviderError } from '../providers/PaymentProvider';
import type { WebhookRequest } from '../payments/types';
import { PaymentService } from '../payments/PaymentService';

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Framework-neutral webhook handler for /api/webhooks/{provider}. */
export async function handleWebhook(
  request: WebhookRequest,
  provider: PaymentProvider,
  service: PaymentService,
): Promise<WebhookResponse> {
  try {
    const webhook = await provider.verifyWebhook(request);
    const result = await service.processWebhook(webhook);
    return { status: 200, body: { ok: true, changed: result.changed, payment: result.payment } };
  } catch (error) {
    if (error instanceof ProviderError) return { status: error.statusCode, body: { ok: false, code: error.code, error: error.message } };
    if (error instanceof Error && /not found/i.test(error.message)) return { status: 404, body: { ok: false, code: 'NOT_FOUND', error: error.message } };
    if (error instanceof Error && /mismatch|invalid|payable/i.test(error.message)) return { status: 400, body: { ok: false, code: 'INVALID_WEBHOOK', error: error.message } };
    return { status: 500, body: { ok: false, code: 'WEBHOOK_ERROR', error: 'Webhook could not be processed' } };
  }
}
