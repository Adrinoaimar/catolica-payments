import { randomUUID } from 'node:crypto';
import type { PaymentListFilters, PaymentRepository } from './PaymentRepository';
import type { Payment, PaymentEvent, PaymentStatus } from '../payments/types';

/** Deterministic repository used by local mock mode and unit tests. */
export class InMemoryPaymentRepository implements PaymentRepository {
  readonly payments = new Map<string, Payment>();
  readonly events = new Map<string, PaymentEvent>();
  private readonly eventIds = new Map<string, PaymentEvent>();
  private readonly mutexes = new Map<string, Promise<void>>();

  async insert(payment: Payment): Promise<Payment> {
    if ([...this.payments.values()].some((item) => item.reference === payment.reference)) {
      throw new Error('Payment reference already exists');
    }
    if (payment.providerPaymentId && [...this.payments.values()].some((item) => item.providerPaymentId === payment.providerPaymentId)) {
      throw new Error('Provider payment ID already exists');
    }
    if (payment.idempotencyKey && [...this.payments.values()].some((item) => item.idempotencyKey === payment.idempotencyKey)) {
      throw new Error('Payment idempotency key already exists');
    }
    this.payments.set(payment.id, structuredClone(payment));
    return structuredClone(payment);
  }

  async findById(id: string): Promise<Payment | null> {
    const payment = this.payments.get(id);
    return payment ? structuredClone(payment) : null;
  }

  async findByReference(reference: string): Promise<Payment | null> {
    const payment = [...this.payments.values()].find((item) => item.reference === reference);
    return payment ? structuredClone(payment) : null;
  }

  async findByProviderPaymentId(providerPaymentId: string): Promise<Payment | null> {
    const payment = [...this.payments.values()].find((item) => item.providerPaymentId === providerPaymentId);
    return payment ? structuredClone(payment) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<Payment | null> {
    const payment = [...this.payments.values()].find((item) => item.idempotencyKey === idempotencyKey);
    return payment ? structuredClone(payment) : null;
  }

  async list(filters: PaymentListFilters = {}): Promise<Payment[]> {
    const from = filters.from ? new Date(filters.from).getTime() : Number.NEGATIVE_INFINITY;
    const to = filters.to ? new Date(filters.to).getTime() : Number.POSITIVE_INFINITY;
    const values = [...this.payments.values()]
      .filter((payment) => !filters.status || payment.status === filters.status)
      .filter((payment) => !filters.method || (filters.method === 'CASH' ? payment.provider === 'CASH' : payment.provider !== 'CASH'))
      .filter((payment) => !filters.provider || payment.provider === filters.provider)
      .filter((payment) => !filters.createdBy || payment.createdBy === filters.createdBy)
      .filter((payment) => filters.minAmountCents === undefined || payment.amountCents >= filters.minAmountCents)
      .filter((payment) => filters.maxAmountCents === undefined || payment.amountCents <= filters.maxAmountCents)
      .filter((payment) => { const time = new Date(payment.createdAt).getTime(); return time >= from && time <= to; })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = filters.offset ?? 0;
    return values.slice(offset, offset + (filters.limit ?? 100)).map((payment) => structuredClone(payment));
  }

  async findEventByProviderEventId(providerEventId: string, provider?: string): Promise<PaymentEvent | null> {
    const event = provider
      ? this.eventIds.get(eventKey(provider, providerEventId))
      : [...this.eventIds.values()].find((item) => item.providerEventId === providerEventId);
    return event ? structuredClone(event) : null;
  }

  async attachProviderPayment(input: {
    paymentId: string;
    provider: string;
    providerPaymentId: string;
    providerData: Record<string, unknown>;
    expiresAt: string | null;
  }): Promise<Payment> {
    return this.withLock(input.paymentId, async () => {
      const payment = this.payments.get(input.paymentId);
      if (!payment) throw new Error('Payment not found');
      if (payment.provider !== input.provider) throw new Error('Payment provider mismatch');
      if (payment.providerPaymentId) {
        if (payment.providerPaymentId !== input.providerPaymentId) throw new Error('Provider payment ID mismatch');
        return structuredClone(payment);
      }
      if (payment.status !== 'PENDING') throw new Error('Payment intent is not pending');
      const owner = [...this.payments.values()].find((item) => item.providerPaymentId === input.providerPaymentId);
      if (owner && owner.id !== payment.id) throw new Error('Provider payment ID already exists');
      const next: Payment = {
        ...payment,
        providerPaymentId: input.providerPaymentId,
        providerData: structuredClone(input.providerData),
        expiresAt: input.expiresAt ?? payment.expiresAt,
      };
      this.payments.set(payment.id, next);
      return structuredClone(next);
    });
  }

  async listPendingExpired(now: string, limit: number): Promise<Payment[]> {
    return [...this.payments.values()]
      .filter((payment) => payment.status === 'PENDING' && payment.expiresAt && payment.expiresAt <= now)
      .sort((a, b) => (a.expiresAt ?? '').localeCompare(b.expiresAt ?? ''))
      .slice(0, limit)
      .map((payment) => structuredClone(payment));
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutexes.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.mutexes.set(key, queued);
    await previous;
    try { return await operation(); } finally {
      release();
      if (this.mutexes.get(key) === queued) this.mutexes.delete(key);
    }
  }

  async markPaidFromWebhook(input: {
    paymentId: string;
    provider: string;
    amountCents: number;
    currency: string;
    providerEventId: string;
    newStatus: PaymentStatus;
    payload: unknown;
    eventType: string;
    paidAt: string;
  }): Promise<{ payment: Payment; event: PaymentEvent | null; changed: boolean }> {
    return this.withLock(input.paymentId, async () => {
      const payment = this.payments.get(input.paymentId);
      if (!payment) throw new Error('Payment not found');
      const duplicate = this.eventIds.get(eventKey(input.provider, input.providerEventId));
      if (duplicate) return { payment: structuredClone(payment), event: structuredClone(duplicate), changed: false };
      if (payment.status !== 'PENDING') return { payment: structuredClone(payment), event: null, changed: false };
      const event: PaymentEvent = {
        id: randomUUID(), paymentId: payment.id, eventType: input.eventType,
        previousStatus: payment.status, newStatus: input.newStatus, provider: input.provider,
        providerEventId: input.providerEventId, rawPayload: structuredClone(input.payload), createdAt: input.paidAt,
      };
      const next: Payment = {
        ...payment,
        status: input.newStatus,
        paidAt: input.newStatus === 'PAID' ? input.paidAt : null,
        cancelledAt: input.newStatus === 'CANCELLED' ? input.paidAt : payment.cancelledAt,
        provider: input.provider,
      };
      this.payments.set(payment.id, next);
      this.events.set(event.id, event);
      this.eventIds.set(eventKey(event.provider, event.providerEventId), event);
      return { payment: structuredClone(next), event: structuredClone(event), changed: true };
    });
  }

  async markExpired(paymentId: string, at: string): Promise<{ payment: Payment; event: PaymentEvent | null; changed: boolean }> {
    return this.withLock(paymentId, async () => {
      const payment = this.payments.get(paymentId);
      if (!payment) throw new Error('Payment not found');
      if (payment.status !== 'PENDING') return { payment: structuredClone(payment), event: null, changed: false };
      const event: PaymentEvent = {
        id: randomUUID(), paymentId, eventType: 'payment.expired', previousStatus: payment.status,
        newStatus: 'EXPIRED', provider: payment.provider, providerEventId: `expiry:${payment.id}:${at}`,
        rawPayload: { reason: 'expires_at reached' }, createdAt: at,
      };
      const next = { ...payment, status: 'EXPIRED' as const };
      this.payments.set(paymentId, next); this.events.set(event.id, event); this.eventIds.set(eventKey(event.provider, event.providerEventId), event);
      return { payment: structuredClone(next), event: structuredClone(event), changed: true };
    });
  }

  async markCancelledByAdmin(input: {
    paymentId: string;
    provider: string;
    providerPaymentId: string;
    reference: string;
    providerEventId: string;
    eventId: string;
    actorId: string;
    reason?: string;
    cancelledAt: string;
  }): Promise<{ payment: Payment; event: PaymentEvent | null; changed: boolean }> {
    return this.withLock(input.paymentId, async () => {
      const payment = this.payments.get(input.paymentId);
      if (!payment) throw new Error('Payment not found');
      const duplicate = this.eventIds.get(eventKey(input.provider, input.providerEventId));
      if (duplicate) return { payment: structuredClone(payment), event: structuredClone(duplicate), changed: false };
      if (payment.provider !== input.provider || payment.providerPaymentId !== input.providerPaymentId || payment.reference !== input.reference) {
        throw new Error('Payment identity mismatch');
      }
      if (payment.status !== 'PENDING') return { payment: structuredClone(payment), event: null, changed: false };
      const event: PaymentEvent = {
        id: input.eventId,
        paymentId: payment.id,
        eventType: 'payment.cancelled.admin',
        previousStatus: payment.status,
        newStatus: 'CANCELLED',
        provider: input.provider,
        providerEventId: input.providerEventId,
        rawPayload: {
          source: 'admin_cancel',
          actor_id: input.actorId,
          ...(input.reason ? { reason: input.reason } : {}),
        },
        createdAt: input.cancelledAt,
      };
      const next: Payment = { ...payment, status: 'CANCELLED', cancelledAt: input.cancelledAt };
      this.payments.set(payment.id, next);
      this.events.set(event.id, event);
      this.eventIds.set(eventKey(event.provider, event.providerEventId), event);
      return { payment: structuredClone(next), event: structuredClone(event), changed: true };
    });
  }

  async insertCashPayment(payment: Payment, event: PaymentEvent): Promise<Payment> {
    await this.insert(payment);
    this.events.set(event.id, structuredClone(event));
    this.eventIds.set(eventKey(event.provider, event.providerEventId), structuredClone(event));
    return structuredClone(payment);
  }
}

function eventKey(provider: string, providerEventId: string): string {
  return `${provider}:${providerEventId}`;
}
