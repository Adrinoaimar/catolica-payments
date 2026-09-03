import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { CreatePaymentInput, ProviderPayment, VerifiedWebhook, WebhookRequest } from '../payments/types';
import { solesToCents } from '../payments/money';
import { header } from '../utils/signature';
import { ProviderError, type PaymentProvider } from './PaymentProvider';

/**
 * TAYPI API client.
 *
 * TAYPI uses the public key for Bearer authentication and the secret key for
 * signing each API request. Keep this class server-only: the secret key must
 * never reach the browser.
 *
 * API references:
 * - POST /api/v1/payments
 * - GET /api/v1/payments/:payment_id
 * - POST /api/v1/payments/:payment_id/cancel
 */
export interface TaypiProviderConfig {
  publicKey: string;
  secretKey: string;
  webhookSecret?: string;
  /** https://sandbox.taypi.pe or https://app.taypi.pe. */
  baseUrl?: string;
  sandbox?: boolean;
  fetchImpl?: typeof fetch;
  /** Injectable clock for deterministic tests. Returns UNIX seconds. */
  now?: () => number;
  timeoutMs?: number;
  /** Maximum accepted age for a signed webhook delivery. */
  webhookToleranceSeconds?: number;
}

type TaypiPayment = Record<string, unknown>;

const DEFAULT_PRODUCTION_URL = 'https://app.taypi.pe';
const DEFAULT_SANDBOX_URL = 'https://sandbox.taypi.pe';
// TAYPI retries deliveries for roughly six minutes. Keep a small additional
// window for network delay while rejecting long-lived replayed webhooks.
const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 10 * 60;
const MAX_WEBHOOK_FUTURE_SKEW_SECONDS = 60;

export class TaypiProvider implements PaymentProvider {
  readonly name = 'taypi';

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly webhookToleranceSeconds: number;

  constructor(private readonly config: TaypiProviderConfig) {
    if (!config.publicKey.trim()) throw new ProviderError('Missing TAYPI_PUBLIC_KEY', 500, 'PROVIDER_NOT_CONFIGURED');
    if (!config.secretKey.trim()) throw new ProviderError('Missing TAYPI_SECRET_KEY', 500, 'PROVIDER_NOT_CONFIGURED');
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? (() => Math.floor(Date.now() / 1000));
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.baseUrl = resolveBaseUrl(config.baseUrl, config.publicKey, config.sandbox);
    this.webhookToleranceSeconds = normalizeWebhookTolerance(config.webhookToleranceSeconds);
  }

  async createPayment(input: CreatePaymentInput): Promise<ProviderPayment> {
    // TAYPI's amount is a decimal string, while our domain stores integer cents.
    const body = JSON.stringify({
      amount: centsToTaypiAmount(input.amountCents),
      currency: input.currency ?? 'PEN',
      reference: input.reference,
    });
    const data = await this.request('/api/v1/payments', 'POST', body, input.reference);
    return this.mapPayment(data, input.expiresAt ?? undefined);
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPayment> {
    const path = `/api/v1/payments/${encodeURIComponent(providerPaymentId)}`;
    const data = await this.request(path, 'GET');
    return this.mapPayment(data);
  }

  async cancelPayment(providerPaymentId: string): Promise<void> {
    const path = `/api/v1/payments/${encodeURIComponent(providerPaymentId)}/cancel`;
    await this.request(path, 'POST', '{}', `cancel:${providerPaymentId}`);
  }

  async verifyWebhook(request: WebhookRequest): Promise<VerifiedWebhook> {
    const secret = this.config.webhookSecret?.trim();
    if (!secret) throw new ProviderError('TAYPI webhook secret is not configured', 500, 'PROVIDER_NOT_CONFIGURED');

    const signature = header(request.headers, 'taypi-signature');
    if (!signature || !verifyWebhookSignature(secret, request.rawBody, signature)) {
      throw new ProviderError('Invalid taypi webhook signature', 401, 'INVALID_SIGNATURE');
    }
    const timestamp = parseWebhookTimestamp(header(request.headers, 'taypi-timestamp'));
    const now = this.now();
    if (timestamp === null
      || timestamp > now + MAX_WEBHOOK_FUTURE_SKEW_SECONDS
      || now - timestamp > this.webhookToleranceSeconds) {
      throw new ProviderError('Expired or invalid taypi webhook timestamp', 401, 'INVALID_SIGNATURE');
    }

    let payload: TaypiPayment;
    try {
      const parsed: unknown = JSON.parse(request.rawBody);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
      payload = parsed as TaypiPayment;
    } catch {
      throw new ProviderError('Invalid webhook JSON', 400, 'INVALID_WEBHOOK');
    }

    const eventType = stringValue(payload.event);
    const paymentId = stringValue(payload.payment_id);
    const reference = stringValue(payload.reference);
    const currency = stringValue(payload.currency).toUpperCase();
    const amountCents = parseTaypiAmount(payload.amount);
    const rawStatus = stringValue(payload.status).toLowerCase();
    const status = mapWebhookStatus(rawStatus, eventType);

    if (!paymentId || !reference || !currency || amountCents === null || !status) {
      throw new ProviderError('Invalid taypi webhook payload', 400, 'INVALID_WEBHOOK');
    }
    if (currency !== 'PEN') throw new ProviderError('Unsupported taypi webhook currency', 400, 'INVALID_WEBHOOK');

    // TAYPI sends delivery ID in a header. Hash fallback preserves idempotency
    // for valid deliveries from older accounts that omit that header.
    const eventId = header(request.headers, 'taypi-webhook-id')
      || stringValue(payload.event_id)
      || `taypi:${createHash('sha256').update(request.rawBody, 'utf8').digest('hex')}`;

    return {
      eventId,
      eventType: eventType || `payment.${rawStatus}`,
      providerPaymentId: paymentId,
      reference,
      amountCents,
      currency,
      status,
      payload,
    };
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body = '',
    idempotencyKey?: string,
  ): Promise<TaypiPayment> {
    const timestamp = String(this.now());
    const signaturePayload = [timestamp, method, path, body].join('\n');
    const signature = createHmac('sha256', this.config.secretKey).update(signaturePayload, 'utf8').digest('hex');
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.config.publicKey}`,
      'Taypi-Signature': signature,
      'Taypi-Timestamp': timestamp,
    };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      headers['Idempotency-Key'] = idempotencyKey ?? `catolica:${createHash('sha256').update(signaturePayload).digest('hex')}`;
    }

    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const controller = typeof AbortController === 'undefined' ? undefined : new AbortController();
      const timeout = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
      try {
        let response: Response;
        try {
          response = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method,
            headers,
            ...(method === 'POST' ? { body } : {}),
            ...(controller ? { signal: controller.signal } : {}),
          });
        } catch (error) {
          if (attempt < maxAttempts - 1) {
            await waitBeforeRetry(undefined, attempt);
            continue;
          }
          const message = error instanceof Error && error.name === 'AbortError' ? 'request timed out' : error instanceof Error ? error.message : 'unknown error';
          throw new ProviderError(`Taypi request failed: ${message}`, 502, 'PROVIDER_UNAVAILABLE');
        }

        const responseBody = await response.text();
        let parsed: unknown;
        try {
          parsed = responseBody ? JSON.parse(responseBody) : {};
        } catch {
          throw new ProviderError('Taypi API returned invalid JSON', response.status || 502, 'PROVIDER_INVALID_RESPONSE');
        }

        if (!response.ok) {
          if (isRetryableStatus(response.status) && attempt < maxAttempts - 1) {
            await waitBeforeRetry(response, attempt);
            continue;
          }
          const errorBody = parsed && typeof parsed === 'object' ? parsed as TaypiPayment : {};
          const code = stringValue(errorBody.code) || 'PROVIDER_HTTP_ERROR';
          const message = stringValue(errorBody.message) || `Taypi API error (${response.status})`;
          throw new ProviderError(`Taypi API error: ${message}`, response.status, code);
        }

        const envelope = parsed && typeof parsed === 'object' ? parsed as TaypiPayment : {};
        const data = envelope.data;
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          throw new ProviderError('Taypi API response missing data', response.status || 502, 'PROVIDER_INVALID_RESPONSE');
        }
        return data as TaypiPayment;
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }
    throw new ProviderError('Taypi request failed after retries', 502, 'PROVIDER_UNAVAILABLE');
  }

  private mapPayment(data: TaypiPayment, fallbackExpiresAt?: string): ProviderPayment {
    const providerPaymentId = stringValue(data.payment_id) || stringValue(data.provider_payment_id) || stringValue(data.id);
    if (!providerPaymentId) throw new ProviderError('Taypi response missing payment ID', 502, 'PROVIDER_INVALID_RESPONSE');

    const qrImage = normalizeQrImage(data.qr_image ?? data.qr_code);
    const checkoutUrl = stringValue(data.checkout_url) || undefined;
    const checkoutToken = stringValue(data.checkout_token) || stringValue(data.checkoutToken) || undefined;
    const expiresAt = stringValue(data.expires_at) || fallbackExpiresAt;
    const rawStatus = stringValue(data.status).toLowerCase();
    const status = mapPaymentStatus(rawStatus, stringValue(data.event));
    const amountCents = parseTaypiAmount(data.amount);
    const currency = stringValue(data.currency).toUpperCase() || undefined;
    const reference = stringValue(data.reference) || undefined;
    return {
      providerPaymentId,
      status,
      amountCents: amountCents ?? undefined,
      currency,
      reference,
      eventId: stringValue(data.event_id) || undefined,
      paidAt: stringValue(data.paid_at) || undefined,
      checkoutUrl,
      checkoutToken,
      qrCode: qrImage,
      expiresAt,
      providerData: data,
    };
  }
}

function mapPaymentStatus(status: string, eventType: string): ProviderPayment['status'] {
  const candidate = status || eventType.replace(/^payment\./, '').toLowerCase();
  if (candidate === 'pending' || candidate === 'processing' || candidate === 'in_progress') return 'PENDING';
  return mapWebhookStatus(candidate, eventType) ?? undefined;
}

function resolveBaseUrl(configuredUrl: string | undefined, publicKey: string, sandbox = false): string {
  const fallback = sandbox || publicKey.includes('_test_') ? DEFAULT_SANDBOX_URL : DEFAULT_PRODUCTION_URL;
  const candidate = (configuredUrl?.trim() || fallback).replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ProviderError('Invalid TAYPI_API_URL', 500, 'PROVIDER_NOT_CONFIGURED');
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new ProviderError('TAYPI_API_URL must use HTTPS', 500, 'PROVIDER_NOT_CONFIGURED');
  }
  return candidate;
}

function centsToTaypiAmount(amountCents: number): string {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new ProviderError('Invalid payment amount', 400, 'INVALID_AMOUNT');
  return `${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, '0')}`;
}

function parseTaypiAmount(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    const text = String(value);
    return /^\d+(?:\.\d{1,2})?$/.test(text) ? solesToCents(text) : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function mapWebhookStatus(status: string, eventType: string): VerifiedWebhook['status'] | null {
  const candidate = status || eventType.replace(/^payment\./, '').toLowerCase();
  switch (candidate) {
    case 'completed':
    case 'paid':
      return 'PAID';
    case 'expired':
      return 'EXPIRED';
    case 'cancelled':
    case 'canceled':
      return 'CANCELLED';
    case 'failed':
    case 'rejected':
      return 'FAILED';
    default:
      return null;
  }
}

function normalizeQrImage(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  if (/^data:/i.test(text) || /^https?:\/\//i.test(text)) return text;
  if (/^<svg[\s>]/i.test(text)) return `data:image/svg+xml,${encodeURIComponent(text)}`;
  // TAYPI documents qr_image as a base64 encoded SVG image.
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return `data:image/svg+xml;base64,${text}`;
  return text;
}

function verifyWebhookSignature(secret: string, body: string, supplied: string): boolean {
  const normalized = supplied.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) return false;
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  const suppliedBytes = Buffer.from(normalized, 'hex');
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function parseWebhookTimestamp(value: string | undefined): number | null {
  const text = value?.trim() ?? '';
  if (!/^\d{10}$/.test(text)) return null;
  const timestamp = Number(text);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}

function normalizeWebhookTolerance(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  if (!Number.isSafeInteger(value) || value < 60 || value > 24 * 60 * 60) {
    throw new ProviderError('Invalid webhook tolerance', 500, 'PROVIDER_NOT_CONFIGURED');
  }
  return value;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function waitBeforeRetry(response: Response | undefined, attempt: number): Promise<void> {
  const retryAfter = response?.headers?.get('retry-after');
  const retryAfterMs = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)
    ? Math.min(5_000, Math.max(0, Number(retryAfter) * 1_000))
    : Math.min(2_000, 250 * (2 ** attempt));
  if (retryAfterMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, retryAfterMs));
}
