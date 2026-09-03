import { describe, expect, it, vi } from 'vitest';
import { assertCronSecret } from '../api/cron/reconcile-payments';
import { createPaymentProvider, InMemoryPaymentRepository, MockPaymentProvider, PaymentService, type Payment, type PaymentProvider } from '../src/server';

function setup() {
  const repository = new InMemoryPaymentRepository();
  const provider = new MockPaymentProvider();
  const service = new PaymentService({ repository, provider, now: () => new Date('2026-09-02T12:00:00.000Z') });
  return { repository, provider, service };
}

describe('payment reconciliation', () => {
  it('polls provider state and applies the same atomic PAID transition', async () => {
    const { service, provider, repository } = setup();
    const created = await service.createDigitalPayment({ amountCents: 3000 });
    provider.simulateSuccessfulPayment(created.payment.providerPaymentId!);

    const result = await service.reconcilePendingPayments();

    expect(result).toMatchObject({ inspected: 1, reconciled: 1, skipped: 0, errors: 0 });
    expect(result.payments[0]?.status).toBe('PAID');
    expect((await repository.findById(created.payment.id))?.status).toBe('PAID');
    expect(repository.events.size).toBe(1);
    expect((await service.reconcilePendingPayments()).inspected).toBe(0);
  });

  it('accepts each negative terminal webhook without marking it PAID', async () => {
    for (const status of ['FAILED', 'EXPIRED', 'CANCELLED'] as const) {
      const { service, repository } = setup();
      const created = await service.createDigitalPayment({ amountCents: 3000 });
      const result = await service.processWebhook({
        eventId: `evt-${status.toLowerCase()}`,
        eventType: `payment.${status.toLowerCase()}`,
        providerPaymentId: created.payment.providerPaymentId!,
        reference: created.payment.reference,
        amountCents: created.payment.amountCents,
        currency: created.payment.currency,
        status,
        payload: { status },
      });

      expect(result.changed).toBe(true);
      expect(result.payment.status).toBe(status);
      expect(result.payment.paidAt).toBeNull();
      expect(result.payment.cancelledAt).toBe(status === 'CANCELLED' ? '2026-09-02T12:00:00.000Z' : null);
      expect([...repository.events.values()][0]?.newStatus).toBe(status);
    }
  });

  it('does not let a later PAID event reopen a terminal payment', async () => {
    const { service, repository } = setup();
    const created = await service.createDigitalPayment({ amountCents: 3000 });
    const base = {
      eventType: 'payment.failed',
      providerPaymentId: created.payment.providerPaymentId!,
      reference: created.payment.reference,
      amountCents: created.payment.amountCents,
      currency: created.payment.currency,
      payload: {},
    } as const;
    await service.processWebhook({ ...base, eventId: 'evt-failed', status: 'FAILED' });
    const result = await service.processWebhook({ ...base, eventId: 'evt-paid', eventType: 'payment.paid', status: 'PAID' });
    expect(result.changed).toBe(false);
    expect(result.payment.status).toBe('FAILED');
    expect(repository.events.size).toBe(1);
  });

  it('lets a provider confirmation win over a late local expiry check', async () => {
    let now = new Date('2026-09-02T12:00:00.000Z');
    const repository = new InMemoryPaymentRepository();
    const provider = new MockPaymentProvider();
    const service = new PaymentService({ repository, provider, now: () => now, expiryMinutes: 1 });
    const created = await service.createDigitalPayment({ amountCents: 3000 });
    provider.simulateSuccessfulPayment(created.payment.providerPaymentId!);
    now = new Date('2026-09-02T12:02:00.000Z');

    const result = await service.reconcilePaymentByReference(created.payment.reference);

    expect(result.changed).toBe(false);
    expect(result.payment.status).toBe('PAID');
    expect(repository.events.size).toBe(1);
  });

  it('bounds expired-payment scans and provider concurrency', async () => {
    const repository = new InMemoryPaymentRepository();
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const provider: PaymentProvider = {
      name: 'fixture',
      async createPayment() { throw new Error('not used'); },
      async getPayment(providerPaymentId) {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        const payment = await repository.findByProviderPaymentId(providerPaymentId);
        if (!payment) throw new Error('missing fixture payment');
        return {
          providerPaymentId,
          reference: payment.reference,
          amountCents: payment.amountCents,
          currency: payment.currency,
          status: 'PENDING' as const,
        };
      },
      async verifyWebhook() { throw new Error('not used'); },
      async cancelPayment() { throw new Error('not used'); },
    };
    for (let index = 0; index < 5; index += 1) {
      const payment: Payment = {
        id: `expired-${index}`,
        reference: `CAT-20260902-AAAAA${index + 2}`,
        amountCents: 1000,
        currency: 'PEN',
        provider: provider.name,
        providerPaymentId: `provider-${index}`,
        status: 'PENDING',
        createdBy: null,
        createdAt: '2026-09-02T11:00:00.000Z',
        expiresAt: `2026-09-02T11:0${index}:00.000Z`,
        paidAt: null,
        cancelledAt: null,
        providerData: {},
        idempotencyKey: null,
      };
      await repository.insert(payment);
    }
    const service = new PaymentService({
      repository,
      provider,
      expireLimit: 3,
      expireConcurrency: 2,
    });

    const expired = await service.expirePayments(new Date('2026-09-02T12:00:00.000Z'));

    expect(calls).toBe(3);
    expect(maxActive).toBe(2);
    expect(expired.map((payment) => payment.id)).toEqual(['expired-0', 'expired-1', 'expired-2']);
    expect((await repository.list({ status: 'EXPIRED', limit: 10 })).length).toBe(3);
    expect((await repository.list({ status: 'PENDING', limit: 10 })).length).toBe(2);
  });

  it('retries an expired provisional intent before closing it', async () => {
    const repository = new InMemoryPaymentRepository();
    const intent: Payment = {
      id: 'intent-expired-recovery', reference: 'CAT-20260902-ABCD23', amountCents: 3000, currency: 'PEN',
      provider: 'fixture', providerPaymentId: null, status: 'PENDING', createdBy: 'cashier-1',
      createdAt: '2026-09-02T12:00:00.000Z', expiresAt: '2026-09-02T12:01:00.000Z',
      paidAt: null, cancelledAt: null, providerData: {}, idempotencyKey: 'expired-recovery-20260902',
    };
    await repository.insert(intent);
    let createCalls = 0;
    const provider: PaymentProvider = {
      name: 'fixture',
      async createPayment(input) {
        createCalls += 1;
        return {
          providerPaymentId: 'fixture-late-1', status: 'PENDING', amountCents: input.amountCents,
          currency: input.currency ?? 'PEN', reference: input.reference,
        };
      },
      async getPayment(providerPaymentId) {
        return {
          providerPaymentId, status: 'PAID', amountCents: intent.amountCents, currency: intent.currency,
          reference: intent.reference, eventId: 'fixture-late-event-1',
        };
      },
      async verifyWebhook() { throw new Error('not used'); },
      async cancelPayment() { throw new Error('not used'); },
    };
    const service = new PaymentService({
      repository,
      provider,
      now: () => new Date('2026-09-02T12:05:00.000Z'),
    });

    const result = await service.reconcilePendingPayments();

    expect(createCalls).toBe(1);
    expect(result).toMatchObject({ inspected: 1, reconciled: 1, errors: 0 });
    expect(await repository.findById(intent.id)).toMatchObject({ status: 'PAID', providerPaymentId: 'fixture-late-1' });
  });
});

describe('reconciliation cron authentication', () => {
  it('requires the configured CRON_SECRET', () => {
    vi.stubEnv('CRON_SECRET', 'cron-test-secret');
    expect(() => assertCronSecret({ method: 'GET', headers: { authorization: 'Bearer cron-test-secret' } })).not.toThrow();
    expect(() => assertCronSecret({ method: 'GET', headers: { authorization: 'Bearer wrong' } })).toThrow('Invalid cron secret');
    vi.unstubAllEnvs();
  });

  it('fails closed for provider adapters that are not implemented', () => {
    expect(() => createPaymentProvider({
      PAYMENT_PROVIDER: 'culqi',
      CULQI_SECRET_KEY: 'secret',
      CULQI_WEBHOOK_SECRET: 'webhook',
    })).toThrow('adapter is not implemented');
  });

  it('rejects Taypi sandbox configuration in production', () => {
    expect(() => createPaymentProvider({
      NODE_ENV: 'production',
      PAYMENT_PROVIDER: 'taypi',
      TAYPI_PUBLIC_KEY: 'taypi_pk_live_demo',
      TAYPI_SECRET_KEY: 'taypi_sk_live_demo',
      TAYPI_WEBHOOK_SECRET: 'webhook',
      TAYPI_SANDBOX: 'true',
    })).toThrow('not allowed in production');
  });
});
