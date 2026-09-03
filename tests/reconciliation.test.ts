import { describe, expect, it, vi } from 'vitest';
import { assertCronSecret } from '../api/cron/reconcile-payments';
import { InMemoryPaymentRepository, MockPaymentProvider, PaymentService } from '../src/server';

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
});

describe('reconciliation cron authentication', () => {
  it('requires the configured CRON_SECRET', () => {
    vi.stubEnv('CRON_SECRET', 'cron-test-secret');
    expect(() => assertCronSecret({ method: 'GET', headers: { authorization: 'Bearer cron-test-secret' } })).not.toThrow();
    expect(() => assertCronSecret({ method: 'GET', headers: { authorization: 'Bearer wrong' } })).toThrow('Invalid cron secret');
    vi.unstubAllEnvs();
  });
});
