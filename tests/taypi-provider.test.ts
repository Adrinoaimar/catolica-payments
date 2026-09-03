import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TaypiProvider } from '../src/server/providers/TaypiProvider';
import { HttpPaymentProvider } from '../src/server/providers/HttpPaymentProvider';
import type { WebhookRequest } from '../src/server/payments/types';

const publicKey = 'taypi_pk_test_fixture';
const secretKey = 'taypi_sk_test_fixture';
const webhookSecret = 'taypi_webhook_fixture';

describe('TaypiProvider', () => {
  it('sends the signed TAYPI payment request and maps QR response', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const provider = new TaypiProvider({
      publicKey,
      secretKey,
      now: () => 1_710_504_600,
      baseUrl: 'https://sandbox.taypi.pe',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({
          data: {
            payment_id: 'pay_fixture_1',
            status: 'pending',
            qr_image: 'PHN2ZyB4bWxucz0i',
            checkout_url: 'https://sandbox.taypi.pe/checkout/pay_fixture_1',
            checkout_token: 'checkout_token_fixture',
            amount: '30.50',
            currency: 'PEN',
            reference: 'CAT-TEST-001',
            expires_at: '2026-09-02T20:00:00-05:00',
          },
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      },
    });

    const payment = await provider.createPayment({ amountCents: 3_050, currency: 'PEN', reference: 'CAT-TEST-001' });
    expect(payment.providerPaymentId).toBe('pay_fixture_1');
    expect(payment.qrCode).toBe('data:image/svg+xml;base64,PHN2ZyB4bWxucz0i');
    expect(payment.checkoutUrl).toContain('/checkout/pay_fixture_1');
    expect(payment.checkoutToken).toBe('checkout_token_fixture');
    expect(requests).toHaveLength(1);

    const request = requests[0];
    const body = String(request.init.body);
    expect(request.url).toBe('https://sandbox.taypi.pe/api/v1/payments');
    expect(body).toBe('{"amount":"30.50","currency":"PEN","reference":"CAT-TEST-001"}');
    expect(request.init.headers).toMatchObject({
      Authorization: `Bearer ${publicKey}`,
      'Taypi-Timestamp': '1710504600',
      'Idempotency-Key': 'CAT-TEST-001',
    });
    const expectedSignature = createHmac('sha256', secretKey)
      .update(['1710504600', 'POST', '/api/v1/payments', body].join('\n'))
      .digest('hex');
    expect((request.init.headers as Record<string, string>)['Taypi-Signature']).toBe(expectedSignature);
  });

  it('retries transient Taypi responses with bounded backoff', async () => {
    let attempts = 0;
    const provider = new TaypiProvider({
      publicKey,
      secretKey,
      now: () => 1_710_504_600,
      baseUrl: 'https://sandbox.taypi.pe',
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) return new Response(JSON.stringify({ message: 'temporarily unavailable' }), { status: 503 });
        return new Response(JSON.stringify({ data: {
          payment_id: 'pay_fixture_retry', status: 'pending', amount: '10.00', currency: 'PEN', reference: 'CAT-TEST-002',
        } }), { status: 201 });
      },
    });
    await expect(provider.createPayment({ amountCents: 1_000, currency: 'PEN', reference: 'CAT-TEST-002' })).resolves.toMatchObject({ providerPaymentId: 'pay_fixture_retry' });
    expect(attempts).toBe(3);
  });

  it('verifies signed completed webhook and maps TAYPI fields', async () => {
    const rawBody = JSON.stringify({
      event: 'payment.completed',
      payment_id: 'pay_fixture_1',
      amount: '30.50',
      currency: 'PEN',
      status: 'completed',
      reference: 'CAT-TEST-001',
      paid_at: '2026-09-02T20:00:00-05:00',
    });
    const signature = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    const provider = new TaypiProvider({ publicKey, secretKey, webhookSecret, now: () => 1_788_350_400 });
    const webhook = await provider.verifyWebhook({
      rawBody,
      headers: {
        'Taypi-Signature': `sha256=${signature}`,
        'Taypi-Timestamp': '1788350400',
        'Taypi-Webhook-Id': 'wh_fixture_1',
      },
    });
    expect(webhook).toMatchObject({
      eventId: 'wh_fixture_1',
      eventType: 'payment.completed',
      providerPaymentId: 'pay_fixture_1',
      reference: 'CAT-TEST-001',
      amountCents: 3_050,
      currency: 'PEN',
      status: 'PAID',
    });
  });

  it('rejects an unsigned webhook', async () => {
    const provider = new TaypiProvider({ publicKey, secretKey, webhookSecret });
    await expect(provider.verifyWebhook({ rawBody: '{}', headers: {} })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE', statusCode: 401 });
  });

  it('rejects a signed webhook outside the replay tolerance window', async () => {
    const rawBody = JSON.stringify({
      event: 'payment.completed', payment_id: 'pay_fixture_1', amount: '30.50',
      currency: 'PEN', status: 'completed', reference: 'CAT-TEST-001',
    });
    const signature = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    const provider = new TaypiProvider({ publicKey, secretKey, webhookSecret, now: () => 1_788_350_400 });
    await expect(provider.verifyWebhook({
      rawBody,
      headers: { 'Taypi-Signature': signature, 'Taypi-Timestamp': '1788349200' },
    })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE', statusCode: 401 });
  });

  it('rejects a signed webhook with a future timestamp', async () => {
    const rawBody = JSON.stringify({
      event: 'payment.completed', payment_id: 'pay_fixture_1', amount: '30.50',
      currency: 'PEN', status: 'completed', reference: 'CAT-TEST-001',
    });
    const signature = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    const provider = new TaypiProvider({ publicKey, secretKey, webhookSecret, now: () => 1_788_350_400 });
    await expect(provider.verifyWebhook({
      rawBody,
      headers: { 'Taypi-Signature': signature, 'Taypi-Timestamp': '1788350461' },
    })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE', statusCode: 401 });
  });
});

describe('HttpPaymentProvider amount parsing', () => {
  class FixtureProvider extends HttpPaymentProvider {
    readonly name = 'fixture';
    protected signatureHeader(request: WebhookRequest) {
      const value = request.headers['x-webhook-signature'];
      return Array.isArray(value) ? value[0] : value;
    }
  }

  it('parses decimal webhook amounts without floating point arithmetic', async () => {
    const provider = new FixtureProvider({ baseUrl: 'https://payments.example.test', apiKey: 'fixture', webhookSecret: 'secret' });
    const body = JSON.stringify({ event_id: 'evt-1', provider_payment_id: 'pay-1', reference: 'CAT-TEST-001', amount: '30.50', currency: 'PEN', status: 'PAID' });
    const signature = createHmac('sha256', 'secret').update(body).digest('hex');
    const webhook = await provider.verifyWebhook({ rawBody: body, headers: { 'x-webhook-signature': signature } });
    expect(webhook.amountCents).toBe(3050);
  });

  it('rejects decimal precision beyond cents', async () => {
    const provider = new FixtureProvider({ baseUrl: 'https://payments.example.test', apiKey: 'fixture', webhookSecret: 'secret' });
    const body = JSON.stringify({ event_id: 'evt-1', provider_payment_id: 'pay-1', reference: 'CAT-TEST-001', amount: '30.505', currency: 'PEN', status: 'PAID' });
    const signature = createHmac('sha256', 'secret').update(body).digest('hex');
    await expect(provider.verifyWebhook({ rawBody: body, headers: { 'x-webhook-signature': signature } })).rejects.toMatchObject({ code: 'INVALID_WEBHOOK' });
  });
});
