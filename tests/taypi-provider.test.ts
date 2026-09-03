import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TaypiProvider } from '../src/server/providers/TaypiProvider';

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
            expires_at: '2026-09-02T20:00:00-05:00',
          },
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      },
    });

    const payment = await provider.createPayment({ amountCents: 3_050, currency: 'PEN', reference: 'CAT-TEST-001' });
    expect(payment.providerPaymentId).toBe('pay_fixture_1');
    expect(payment.qrCode).toBe('data:image/svg+xml;base64,PHN2ZyB4bWxucz0i');
    expect(payment.checkoutUrl).toContain('/checkout/pay_fixture_1');
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
    const provider = new TaypiProvider({ publicKey, secretKey, webhookSecret });
    const webhook = await provider.verifyWebhook({
      rawBody,
      headers: { 'Taypi-Signature': `sha256=${signature}`, 'Taypi-Webhook-Id': 'wh_fixture_1' },
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
});
