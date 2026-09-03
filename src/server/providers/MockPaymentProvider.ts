import { randomUUID } from 'node:crypto';
import type { CreatePaymentInput, ProviderPayment, VerifiedWebhook, WebhookRequest } from '../payments/types';
import { ProviderError, type PaymentProvider } from './PaymentProvider';

interface MockRecord extends ProviderPayment {
  input: CreatePaymentInput;
  status: 'PENDING' | 'PAID' | 'CANCELLED';
}

/** Zero-cost provider. Simulator emits same webhook shape as a real provider. */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  private readonly records = new Map<string, MockRecord>();

  constructor(private readonly options: { allowUnknownWebhook?: boolean } = {}) {}

  async createPayment(input: CreatePaymentInput): Promise<ProviderPayment> {
    const providerPaymentId = `mock_${randomUUID()}`;
    const expiresAt = input.expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString();
    const destination = `mock://pay/${encodeURIComponent(input.reference)}?amount=${input.amountCents}`;
    // SVG keeps local mode dependency-free. Production provider returns real QR payload.
    const qrCode = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640"><rect width="640" height="640" fill="white"/><rect x="26" y="26" width="588" height="588" fill="none" stroke="#102a43" stroke-width="8"/><text x="320" y="290" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="34" fill="#102a43">MOCK QR</text><text x="320" y="345" text-anchor="middle" font-family="monospace" font-size="24" fill="#102a43">${input.reference}</text><text x="320" y="390" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#334e68">S/ ${(input.amountCents / 100).toFixed(2)}</text></svg>`)}`;
    const record: MockRecord = { providerPaymentId, checkoutUrl: destination, qrCode, expiresAt, providerData: { destination }, input, status: 'PENDING' };
    record.amountCents = input.amountCents;
    record.currency = input.currency ?? 'PEN';
    record.reference = input.reference;
    this.records.set(providerPaymentId, record);
    return this.publicRecord(record);
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPayment> {
    const record = this.records.get(providerPaymentId);
    if (!record) throw new ProviderError('Mock payment not found', 404, 'NOT_FOUND');
    return this.publicRecord(record);
  }

  async verifyWebhook(request: WebhookRequest): Promise<VerifiedWebhook> {
    let data: Record<string, unknown>;
    try { data = JSON.parse(request.rawBody) as Record<string, unknown>; } catch { throw new ProviderError('Invalid webhook JSON', 400, 'INVALID_WEBHOOK'); }
    const required = ['event_id', 'provider_payment_id', 'reference', 'amount_cents', 'currency', 'status'];
    if (required.some((key) => !data[key])) throw new ProviderError('Invalid mock webhook payload', 400, 'INVALID_WEBHOOK');
    const id = String(data.provider_payment_id);
    const record = this.records.get(id);
    if (!record && !this.options.allowUnknownWebhook) throw new ProviderError('Unknown mock payment', 404, 'NOT_FOUND');
    if (record && record.input.reference !== data.reference) throw new ProviderError('Unknown mock payment', 404, 'NOT_FOUND');
    if (!Number.isSafeInteger(data.amount_cents) || (record && Number(data.amount_cents) !== record.input.amountCents)) throw new ProviderError('Mock webhook amount mismatch', 400, 'AMOUNT_MISMATCH');
    if (record && data.currency !== (record.input.currency ?? 'PEN')) throw new ProviderError('Mock webhook currency mismatch', 400, 'AMOUNT_MISMATCH');
    const status = String(data.status).toUpperCase();
    if (!['PAID', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(status)) throw new ProviderError('Invalid webhook status', 400, 'INVALID_WEBHOOK');
    return {
      eventId: String(data.event_id), eventType: String(data.event_type ?? 'payment.paid'), providerPaymentId: id,
      reference: String(data.reference), amountCents: Number(data.amount_cents), currency: String(data.currency),
      status: status as VerifiedWebhook['status'], payload: data,
    };
  }

  async cancelPayment(providerPaymentId: string): Promise<void> {
    const record = this.records.get(providerPaymentId);
    if (!record) throw new ProviderError('Mock payment not found', 404, 'NOT_FOUND');
    if (record.status === 'PAID') throw new ProviderError('Mock payment is already paid', 409, 'ALREADY_PAID');
    if (record.status === 'CANCELLED') return;
    record.status = 'CANCELLED';
  }

  /** Internal development endpoint calls this, then sends resulting event to webhook handler. */
  simulateSuccessfulPayment(providerPaymentId: string): string {
    const record = this.records.get(providerPaymentId);
    if (!record) throw new ProviderError('Mock payment not found', 404, 'NOT_FOUND');
    if (record.status === 'CANCELLED') throw new ProviderError('Mock payment is already cancelled', 409, 'ALREADY_CANCELLED');
    record.status = 'PAID';
    const eventId = `mock_evt_${randomUUID()}`;
    record.eventId = eventId;
    return JSON.stringify({
      event_id: eventId, event_type: 'payment.paid', status: 'PAID',
      provider_payment_id: record.providerPaymentId, reference: record.input.reference,
      amount_cents: record.input.amountCents, currency: record.input.currency ?? 'PEN',
    });
  }

  private publicRecord(record: MockRecord): ProviderPayment {
    const { input: _input, ...publicValue } = record;
    return publicValue;
  }
}
