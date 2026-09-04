import { describe, expect, it } from 'vitest';
import { InMemoryPaymentRepository, MockPaymentProvider, PaymentService, centsToSoles, generateReference, solesToCents, type Payment, type PaymentProvider, type ProviderPayment } from '../src/server';

function setup() {
  const repository = new InMemoryPaymentRepository();
  const provider = new MockPaymentProvider();
  const service = new PaymentService({ repository, provider, now: () => new Date('2026-09-02T12:00:00.000Z') });
  return { repository, provider, service };
}

describe('payment domain', () => {
  it('converts soles to integer cents', () => {
    expect(solesToCents('30.50')).toBe(3050);
    expect(solesToCents('10')).toBe(1000);
    expect(centsToSoles(3050)).toBe('S/ 30.50');
    expect(() => solesToCents('1.234')).toThrow();
  });

  it('generates dated CAT reference', () => {
    expect(generateReference(new Date('2026-09-02T00:00:00Z'), () => 0)).toBe('CAT-20260902-AAAAAA');
  });

  it('creates pending digital payment and verifies mock webhook', async () => {
    const { service, provider, repository } = setup();
    const created = await service.createDigitalPayment({ amountCents: 3000, createdBy: 'cashier-1' });
    expect(created.payment.status).toBe('PENDING');
    expect(created.payment.reference).toMatch(/^CAT-20260902-[A-Z2-9]{6}$/);
    expect(created.providerPayment.qrCode).toMatch(/^data:image\/svg\+xml/);
    const raw = provider.simulateSuccessfulPayment(created.payment.providerPaymentId!);
    const webhook = await provider.verifyWebhook({ rawBody: raw, headers: {} });
    const paid = await service.processWebhook(webhook);
    expect(paid.changed).toBe(true);
    expect(paid.payment.status).toBe('PAID');
    expect((await repository.findById(created.payment.id))?.paidAt).toBe('2026-09-02T12:00:00.000Z');
  });

  it('is idempotent for duplicate provider event', async () => {
    const { service, provider, repository } = setup();
    const created = await service.createDigitalPayment({ amountCents: 3000 });
    const raw = provider.simulateSuccessfulPayment(created.payment.providerPaymentId!);
    const webhook = await provider.verifyWebhook({ rawBody: raw, headers: {} });
    expect((await service.processWebhook(webhook)).changed).toBe(true);
    expect((await service.processWebhook(webhook)).changed).toBe(false);
    expect(repository.events.size).toBe(1);
  });

  it('returns the same checkout for a compatible create retry', async () => {
    const { service, repository } = setup();
    const first = await service.createDigitalPayment({ amountCents: 3000, createdBy: 'cashier-1', idempotencyKey: 'request-key-20260902' });
    const second = await service.createDigitalPayment({ amountCents: 3000, createdBy: 'cashier-1', idempotencyKey: 'request-key-20260902' });
    expect(second.payment.id).toBe(first.payment.id);
    expect(second.payment.reference).toBe(first.payment.reference);
    expect(repository.payments.size).toBe(1);
    await expect(service.createDigitalPayment({ amountCents: 3500, createdBy: 'cashier-1', idempotencyKey: 'request-key-20260902' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('leaves a provisional intent recoverable after provider success and attach failure', async () => {
    const repository = new InMemoryPaymentRepository();
    const records = new Map<string, ProviderPayment>();
    let createCalls = 0;
    let failAttach = true;
    const attach = repository.attachProviderPayment.bind(repository);
    repository.attachProviderPayment = async (input) => {
      if (failAttach) {
        failAttach = false;
        throw new Error('database unavailable after provider success');
      }
      return attach(input);
    };
    const provider: PaymentProvider = {
      name: 'fixture',
      async createPayment(input) {
        createCalls += 1;
        const existing = records.get(input.reference);
        if (existing) return existing;
        const created: ProviderPayment = {
          providerPaymentId: 'fixture-provider-1', status: 'PENDING', amountCents: input.amountCents,
          currency: input.currency ?? 'PEN', reference: input.reference, qrCode: 'fixture-qr',
          providerData: { qrCode: 'fixture-qr' },
        };
        records.set(input.reference, created);
        return created;
      },
      async getPayment(providerPaymentId) {
        const payment = [...records.values()].find((item) => item.providerPaymentId === providerPaymentId);
        if (!payment) throw new Error('provider payment not found');
        return payment;
      },
      async verifyWebhook() { throw new Error('not used'); },
      async cancelPayment() { throw new Error('ambiguous checkout must not be cancelled'); },
    };
    const service = new PaymentService({ repository, provider, now: () => new Date('2026-09-02T12:00:00.000Z') });
    const input = { amountCents: 3000, createdBy: 'cashier-1', idempotencyKey: 'recoverable-request-20260902' };

    await expect(service.createDigitalPayment(input)).rejects.toThrow('database unavailable');
    const intent = await repository.findByIdempotencyKey(input.idempotencyKey);
    expect(intent).toMatchObject({ status: 'PENDING', providerPaymentId: null, reference: expect.stringMatching(/^CAT-/) });

    const recovered = await service.createDigitalPayment(input);
    expect(createCalls).toBe(2);
    expect(recovered.payment.id).toBe(intent?.id);
    expect(recovered.payment.providerPaymentId).toBe('fixture-provider-1');
    expect(recovered.providerPayment.qrCode).toBe('fixture-qr');
  });

  it('recovers a provisional intent from reconciliation before polling terminal state', async () => {
    const repository = new InMemoryPaymentRepository();
    const intent: Payment = {
      id: 'intent-reconcile-1', reference: 'CAT-20260902-ABCD23', amountCents: 3000, currency: 'PEN',
      provider: 'fixture', providerPaymentId: null, status: 'PENDING', createdBy: 'cashier-1',
      createdAt: '2026-09-02T12:00:00.000Z', expiresAt: '2026-09-02T12:15:00.000Z',
      paidAt: null, cancelledAt: null, providerData: {}, idempotencyKey: 'reconcile-request-20260902',
    };
    await repository.insert(intent);
    let createCalls = 0;
    const provider: PaymentProvider = {
      name: 'fixture',
      async createPayment(input) {
        createCalls += 1;
        return {
          providerPaymentId: 'fixture-recovered-1', status: 'PENDING', amountCents: input.amountCents,
          currency: input.currency ?? 'PEN', reference: input.reference, providerData: { qrCode: 'fixture-qr' },
        };
      },
      async getPayment(providerPaymentId) {
        return {
          providerPaymentId, status: 'PAID', amountCents: intent.amountCents, currency: intent.currency,
          reference: intent.reference, eventId: 'fixture-reconcile-event-1',
        };
      },
      async verifyWebhook() { throw new Error('not used'); },
      async cancelPayment() { throw new Error('not used'); },
    };
    const service = new PaymentService({ repository, provider, now: () => new Date('2026-09-02T12:05:00.000Z') });
    const result = await service.reconcilePendingPayments();
    const recovered = await repository.findById(intent.id);
    expect(createCalls).toBe(1);
    expect(result).toMatchObject({ inspected: 1, reconciled: 1, errors: 0 });
    expect(recovered).toMatchObject({ status: 'PAID', providerPaymentId: 'fixture-recovered-1' });
  });

  it('processes same provider payment ID only once even with a second event ID', async () => {
    const { service, provider, repository } = setup();
    const created = await service.createDigitalPayment({ amountCents: 3000 });
    const first = await provider.verifyWebhook({ rawBody: provider.simulateSuccessfulPayment(created.payment.providerPaymentId!), headers: {} });
    expect((await service.processWebhook(first)).changed).toBe(true);
    const second = { ...first, eventId: `${first.eventId}-retry` };
    expect((await service.processWebhook(second)).changed).toBe(false);
    expect(repository.events.size).toBe(1);
  });

  it('rejects a provider event ID reused for a different payment', async () => {
    const { service, provider } = setup();
    const first = await service.createDigitalPayment({ amountCents: 3000 });
    const second = await service.createDigitalPayment({ amountCents: 3000 });
    const firstWebhook = await provider.verifyWebhook({
      rawBody: provider.simulateSuccessfulPayment(first.payment.providerPaymentId!),
      headers: {},
    });
    await service.processWebhook(firstWebhook);
    await expect(service.processWebhook({
      ...firstWebhook,
      providerPaymentId: second.payment.providerPaymentId!,
      reference: second.payment.reference,
      eventId: firstWebhook.eventId,
    })).rejects.toMatchObject({ code: 'INVALID_WEBHOOK', statusCode: 400 });
  });

  it('rejects incorrect amount, reference and unknown payment', async () => {
    const { service, provider } = setup();
    const created = await service.createDigitalPayment({ amountCents: 3000 });
    const raw = provider.simulateSuccessfulPayment(created.payment.providerPaymentId!);
    const webhook = await provider.verifyWebhook({ rawBody: raw, headers: {} });
    await expect(service.processWebhook({ ...webhook, amountCents: 3100 })).rejects.toThrow('amount mismatch');
    await expect(service.processWebhook({ ...webhook, reference: 'CAT-20260902-XXXXXX' })).rejects.toThrow('reference mismatch');
    await expect(service.processWebhook({ ...webhook, providerPaymentId: 'mock_missing' })).rejects.toThrow('not found');
  });

  it('rejects malformed webhook before touching the ledger', async () => {
    const { provider, repository } = setup();
    await expect(provider.verifyWebhook({ rawBody: '{"status":"PAID"}', headers: {} })).rejects.toThrow('Invalid mock webhook');
    expect(repository.payments.size).toBe(0);
  });

  it('records a provider capture that races local expiry', async () => {
    const { service, provider, repository } = setup();
    const created = await service.createDigitalPayment({ amountCents: 1000 });
    await service.expirePayments(new Date('2026-09-02T12:16:00.000Z'));
    expect((await repository.findById(created.payment.id))?.status).toBe('EXPIRED');
    const raw = provider.simulateSuccessfulPayment(created.payment.providerPaymentId!);
    const webhook = await provider.verifyWebhook({ rawBody: raw, headers: {} });
    const result = await service.processWebhook(webhook);
    expect(result.changed).toBe(true);
    expect(result.payment.status).toBe('PAID');
    expect(Array.from(repository.events.values()).at(-1)?.previousStatus).toBe('EXPIRED');
  });

  it('records cash as PAID with CASH provider', async () => {
    const { service, repository } = setup();
    const cash = await service.createCashPayment({ amountCents: 2000, createdBy: 'cashier-1' });
    expect(cash.provider).toBe('CASH');
    expect(cash.status).toBe('PAID');
    expect((await repository.findById(cash.id))?.paidAt).toBe(cash.createdAt);
    expect(repository.events.size).toBe(1);
  });

  it('fails closed when a provider returns an inconsistent checkout', async () => {
    const repository = new InMemoryPaymentRepository();
    const provider: PaymentProvider = {
      name: 'fixture',
      async createPayment(input) {
        return {
          providerPaymentId: 'fixture-1', status: 'PENDING', amountCents: input.amountCents + 1,
          currency: 'PEN', reference: input.reference,
        };
      },
      async getPayment() { throw new Error('not used'); },
      async verifyWebhook() { throw new Error('not used'); },
      async cancelPayment() {},
    };
    const service = new PaymentService({ repository, provider, now: () => new Date('2026-09-02T12:00:00.000Z') });
    await expect(service.createDigitalPayment({ amountCents: 3000 })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    // The durable intent remains pending so a later idempotent retry can
    // recover an ambiguous external checkout instead of losing it.
    expect(repository.payments.size).toBe(1);
    expect([...repository.payments.values()][0].providerPaymentId).toBeNull();
  });
});
