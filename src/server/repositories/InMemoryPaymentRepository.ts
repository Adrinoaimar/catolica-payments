import { randomUUID } from 'node:crypto';
import type { PaymentRepository } from './PaymentRepository';
import type { Payment, PaymentEvent } from '../payments/types';

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

  async findEventByProviderEventId(providerEventId: string): Promise<PaymentEvent | null> {
    const event = this.eventIds.get(providerEventId);
    return event ? structuredClone(event) : null;
  }

  async listPendingExpired(now: string): Promise<Payment[]> {
    return [...this.payments.values()]
      .filter((payment) => payment.status === 'PENDING' && payment.expiresAt && payment.expiresAt <= now)
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
    providerEventId: string;
    payload: unknown;
    eventType: string;
    paidAt: string;
  }): Promise<{ payment: Payment; event: PaymentEvent | null; changed: boolean }> {
    return this.withLock(input.paymentId, async () => {
      const payment = this.payments.get(input.paymentId);
      if (!payment) throw new Error('Payment not found');
      const duplicate = this.eventIds.get(input.providerEventId);
      if (duplicate) return { payment: structuredClone(payment), event: structuredClone(duplicate), changed: false };
      if (payment.status !== 'PENDING') return { payment: structuredClone(payment), event: null, changed: false };
      const event: PaymentEvent = {
        id: randomUUID(), paymentId: payment.id, eventType: input.eventType,
        previousStatus: payment.status, newStatus: 'PAID', provider: input.provider,
        providerEventId: input.providerEventId, rawPayload: structuredClone(input.payload), createdAt: input.paidAt,
      };
      const next = { ...payment, status: 'PAID' as const, paidAt: input.paidAt, provider: input.provider };
      this.payments.set(payment.id, next);
      this.events.set(event.id, event);
      this.eventIds.set(event.providerEventId, event);
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
      this.payments.set(paymentId, next); this.events.set(event.id, event); this.eventIds.set(event.providerEventId, event);
      return { payment: structuredClone(next), event: structuredClone(event), changed: true };
    });
  }

  async insertCashPayment(payment: Payment, event: PaymentEvent): Promise<Payment> {
    await this.insert(payment);
    this.events.set(event.id, structuredClone(event));
    this.eventIds.set(event.providerEventId, structuredClone(event));
    return structuredClone(payment);
  }
}
