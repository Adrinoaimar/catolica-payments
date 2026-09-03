import { describe, expect, it } from 'vitest';
import { InMemoryPaymentRepository, MockPaymentProvider, PaymentService, centsToSoles, generateReference, solesToCents } from '../src/server';

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

  it('processes same provider payment ID only once even with a second event ID', async () => {
    const { service, provider, repository } = setup();
    const created = await service.createDigitalPayment({ amountCents: 3000 });
    const first = await provider.verifyWebhook({ rawBody: provider.simulateSuccessfulPayment(created.payment.providerPaymentId!), headers: {} });
    expect((await service.processWebhook(first)).changed).toBe(true);
    const second = { ...first, eventId: `${first.eventId}-retry` };
    expect((await service.processWebhook(second)).changed).toBe(false);
    expect(repository.events.size).toBe(1);
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

  it('does not pay an already expired payment', async () => {
    const { service, provider, repository } = setup();
    const created = await service.createDigitalPayment({ amountCents: 1000 });
    await service.expirePayments(new Date('2026-09-02T12:16:00.000Z'));
    expect((await repository.findById(created.payment.id))?.status).toBe('EXPIRED');
    const raw = provider.simulateSuccessfulPayment(created.payment.providerPaymentId!);
    const webhook = await provider.verifyWebhook({ rawBody: raw, headers: {} });
    const result = await service.processWebhook(webhook);
    expect(result.changed).toBe(false);
    expect(result.payment.status).toBe('EXPIRED');
  });

  it('records cash as PAID with CASH provider', async () => {
    const { service, repository } = setup();
    const cash = await service.createCashPayment({ amountCents: 2000, createdBy: 'cashier-1' });
    expect(cash.provider).toBe('CASH');
    expect(cash.status).toBe('PAID');
    expect((await repository.findById(cash.id))?.paidAt).toBe(cash.createdAt);
    expect(repository.events.size).toBe(1);
  });
});
