import { describe, expect, it } from 'vitest';
import { requireAdmin } from '../api/_shared';
import { InMemoryPaymentRepository, MockPaymentProvider, PaymentService } from '../src/server';

function setup() {
  const repository = new InMemoryPaymentRepository();
  const provider = new MockPaymentProvider();
  const service = new PaymentService({ repository, provider, now: () => new Date('2026-09-02T12:00:00.000Z') });
  return { repository, provider, service };
}

describe('administrative payment cancellation', () => {
  it('cancels provider and ledger atomically from pending state', async () => {
    const { service, provider, repository } = setup();
    const created = await service.createDigitalPayment({ amountCents: 3000 });

    const result = await service.cancelPaymentByReference({
      reference: created.payment.reference,
      actorId: 'admin-1',
      reason: 'Cliente solicitó anulación',
    });

    expect(result).toMatchObject({ changed: true, payment: { status: 'CANCELLED', cancelledAt: '2026-09-02T12:00:00.000Z' } });
    expect((await provider.getPayment(created.payment.providerPaymentId!)).status).toBe('CANCELLED');
    expect((await repository.findById(created.payment.id))?.status).toBe('CANCELLED');
    expect([...repository.events.values()][0]).toMatchObject({
      eventType: 'payment.cancelled.admin', previousStatus: 'PENDING', newStatus: 'CANCELLED',
      rawPayload: { source: 'admin_cancel', actor_id: 'admin-1', reason: 'Cliente solicitó anulación' },
    });
  });

  it('is safe to retry and never cancels a provider payment already PAID', async () => {
    const { service, provider, repository } = setup();
    const created = await service.createDigitalPayment({ amountCents: 3000 });
    provider.simulateSuccessfulPayment(created.payment.providerPaymentId!);

    const result = await service.cancelPaymentByReference({ reference: created.payment.reference, actorId: 'admin-1' });
    expect(result.payment.status).toBe('PAID');
    expect((await provider.getPayment(created.payment.providerPaymentId!)).status).toBe('PAID');
    expect([...repository.events.values()].map((event) => event.eventType)).toEqual(['payment.paid']);
  });

  it('returns cancelled row without creating another event on retry', async () => {
    const { service, provider, repository } = setup();
    const created = await service.createDigitalPayment({ amountCents: 3000 });
    const first = await service.cancelPaymentByReference({ reference: created.payment.reference, actorId: 'admin-1' });
    const second = await service.cancelPaymentByReference({ reference: created.payment.reference, actorId: 'admin-2' });

    expect(first.changed).toBe(true);
    expect(second).toMatchObject({ changed: false, payment: { status: 'CANCELLED' } });
    expect(repository.events.size).toBe(1);
    expect((await provider.getPayment(created.payment.providerPaymentId!)).status).toBe('CANCELLED');
  });
});

describe('administrative cancellation authorization', () => {
  it('requires Bearer authentication and ADMIN role', async () => {
    const unauthorizedClient = {
      auth: { getUser: async () => ({ data: { user: null }, error: new Error('no token') }) },
      from: () => { throw new Error('role query must not run'); },
    } as never;
    await expect(requireAdmin({ method: 'POST', headers: {} }, unauthorizedClient)).rejects.toMatchObject({ statusCode: 401 });

    const cashierClient = {
      auth: { getUser: async () => ({ data: { user: { id: 'cashier-1' } }, error: null }) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: 'CASHIER' }, error: null }) }) }) }),
    } as never;
    await expect(requireAdmin({ method: 'POST', headers: { authorization: 'Bearer token' } }, cashierClient)).rejects.toMatchObject({ statusCode: 403 });

    const adminClient = {
      auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } }, error: null }) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: 'ADMIN' }, error: null }) }) }) }),
    } as never;
    await expect(requireAdmin({ method: 'POST', headers: { authorization: 'Bearer token' } }, adminClient)).resolves.toMatchObject({ id: 'admin-1', role: 'ADMIN' });
  });
});
