import type { CreatePaymentInput, ProviderPayment, VerifiedWebhook, WebhookRequest } from '../payments/types';
import { solesToCents } from '../payments/money';
import { header, verifyHmacSha256 } from '../utils/signature';
import { ProviderError, type PaymentProvider } from './PaymentProvider';

export interface HttpPaymentProviderConfig {
  baseUrl: string;
  apiKey: string;
  webhookSecret?: string;
  /** Public/secret pair used by providers that sign outbound requests (TAYPI). */
  publicKey?: string;
  secretKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Shared defensive HTTP implementation. Provider-specific payload mapping stays isolated in subclasses. */
export abstract class HttpPaymentProvider implements PaymentProvider {
  abstract readonly name: string;
  protected readonly fetchImpl: typeof fetch;

  constructor(protected readonly config: HttpPaymentProviderConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async createPayment(input: CreatePaymentInput): Promise<ProviderPayment> {
    const response = await this.request('/payments', {
      method: 'POST', headers: { 'idempotency-key': input.reference }, body: JSON.stringify({
        reference: input.reference, amount_cents: input.amountCents,
        currency: input.currency ?? 'PEN', expires_at: input.expiresAt,
      }),
    });
    const data = response as Record<string, unknown>;
    const providerPaymentId = String(data.provider_payment_id ?? data.id ?? '');
    if (!providerPaymentId) throw new ProviderError(`${this.name} response missing payment ID`);
    return {
      providerPaymentId,
      status: providerStatus(data.status ?? data.payment_status),
      amountCents: data.amount_cents !== undefined ? providerCents(data.amount_cents) : providerAmount(data.amount),
      currency: providerString(data.currency) || input.currency || 'PEN',
      reference: providerString(data.reference ?? data.external_reference) || input.reference,
      eventId: providerString(data.event_id ?? data.payment_event_id),
      paidAt: providerString(data.paid_at),
      checkoutUrl: typeof data.checkout_url === 'string' ? data.checkout_url : undefined,
      checkoutToken: typeof data.checkout_token === 'string' ? data.checkout_token : undefined,
      qrCode: typeof data.qr_code === 'string' ? data.qr_code : undefined,
      ...(typeof data.qr_image === 'string' ? { qrCode: data.qr_image } : {}),
      expiresAt: typeof data.expires_at === 'string' ? data.expires_at : input.expiresAt ?? undefined,
      providerData: data,
    };
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPayment> {
    const data = await this.request(`/payments/${encodeURIComponent(providerPaymentId)}`, { method: 'GET' });
    const body = data as Record<string, unknown>;
    const normalizedId = String(body.provider_payment_id ?? body.id ?? providerPaymentId);
    return {
      providerPaymentId: normalizedId,
      status: providerStatus(body.status ?? body.payment_status),
      amountCents: body.amount_cents !== undefined ? providerCents(body.amount_cents) : providerAmount(body.amount),
      currency: providerString(body.currency) || undefined,
      reference: providerString(body.reference ?? body.external_reference) || undefined,
      eventId: providerString(body.event_id ?? body.payment_event_id),
      paidAt: providerString(body.paid_at),
      checkoutUrl: typeof body.checkout_url === 'string' ? body.checkout_url : undefined,
      checkoutToken: typeof body.checkout_token === 'string' ? body.checkout_token : undefined,
      qrCode: typeof body.qr_code === 'string' ? body.qr_code : undefined,
      ...(typeof body.qr_image === 'string' ? { qrCode: body.qr_image } : {}),
      expiresAt: typeof body.expires_at === 'string' ? body.expires_at : undefined,
      providerData: body,
    };
  }

  async cancelPayment(providerPaymentId: string): Promise<void> {
    await this.request(`/payments/${encodeURIComponent(providerPaymentId)}/cancel`, {
      method: 'POST', headers: { 'idempotency-key': `cancel:${providerPaymentId}` }, body: '{}',
    });
  }

  async verifyWebhook(request: WebhookRequest): Promise<VerifiedWebhook> {
    if (!this.config.webhookSecret) throw new ProviderError(`${this.name} webhook secret is not configured`, 500, 'PROVIDER_NOT_CONFIGURED');
    const signature = this.signatureHeader(request);
    if (!verifyHmacSha256(this.config.webhookSecret, request.rawBody, signature)) {
      throw new ProviderError(`Invalid ${this.name} webhook signature`, 401, 'INVALID_SIGNATURE');
    }
    let data: Record<string, unknown>;
    try { data = JSON.parse(request.rawBody) as Record<string, unknown>; } catch { throw new ProviderError('Invalid webhook JSON', 400, 'INVALID_WEBHOOK'); }
    const providerPaymentId = String(data.provider_payment_id ?? data.payment_id ?? data.id ?? '');
    const reference = String(data.reference ?? data.external_reference ?? '');
    const eventId = String(data.event_id ?? data.idempotency_key ?? data.id ?? '');
    const amountCents = data.amount_cents !== undefined
      ? providerCents(data.amount_cents) ?? NaN
      : providerAmount(data.amount) ?? NaN;
    const currency = String(data.currency ?? 'PEN');
    const status = String(data.status ?? '').toUpperCase();
    const eventType = String(data.event_type ?? `payment.${status.toLowerCase()}`);
    if (!isSafeWebhookField(providerPaymentId) || !isSafeWebhookField(reference)
      || !isSafeWebhookField(eventId) || !isSafeWebhookField(eventType)
      || !Number.isSafeInteger(amountCents) || !['PAID', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(status)) {
      throw new ProviderError('Invalid webhook payload', 400, 'INVALID_WEBHOOK');
    }
    return { eventId, eventType, providerPaymentId, reference, amountCents, currency, status: status as VerifiedWebhook['status'], payload: data };
  }

  protected abstract signatureHeader(request: WebhookRequest): string | undefined;

  private async request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      const timeout = this.config.timeoutMs ?? 15_000;
      response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(timeout),
        headers: {
          authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      throw new ProviderError(`${this.name} request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    const body = await response.text();
    let data: unknown = {};
    try { data = body ? JSON.parse(body) : {}; } catch { data = { message: body }; }
    if (!response.ok) throw new ProviderError(`${this.name} API error`, response.status, 'PROVIDER_HTTP_ERROR');
    return data;
  }
}

function isSafeWebhookField(value: string, maxLength = 200): boolean {
  return value.trim().length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

function providerString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function providerAmount(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  try { return solesToCents(String(value)); } catch { return undefined; }
}

function providerCents(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
      ? Number(value) : undefined;
}

function providerStatus(value: unknown): ProviderPayment['status'] {
  const status = providerString(value).toUpperCase();
  if (status === 'COMPLETED' || status === 'SUCCESS' || status === 'SUCCEEDED') return 'PAID';
  if (status === 'PAID') return 'PAID';
  if (status === 'FAILED' || status === 'REJECTED') return 'FAILED';
  if (status === 'EXPIRED') return 'EXPIRED';
  if (status === 'CANCELLED' || status === 'CANCELED') return 'CANCELLED';
  if (status === 'PENDING' || status === 'PROCESSING' || status === 'IN_PROGRESS') return 'PENDING';
  return undefined;
}

export class CulqiProvider extends HttpPaymentProvider {
  readonly name = 'culqi';
  protected signatureHeader(request: WebhookRequest): string | undefined { return header(request.headers, 'x-culqi-signature') ?? header(request.headers, 'x-webhook-signature'); }
}

export class MercadoPagoProvider extends HttpPaymentProvider {
  readonly name = 'mercadopago';
  protected signatureHeader(request: WebhookRequest): string | undefined { return header(request.headers, 'x-mercadopago-signature') ?? header(request.headers, 'x-webhook-signature'); }
}
