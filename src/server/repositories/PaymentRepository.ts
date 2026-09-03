import type { Payment, PaymentEvent, PaymentMethod, PaymentStatus } from '../payments/types';

export interface PaymentListFilters {
  status?: PaymentStatus;
  method?: PaymentMethod;
  provider?: string;
  createdBy?: string;
  from?: string;
  to?: string;
  minAmountCents?: number;
  maxAmountCents?: number;
  limit?: number;
  offset?: number;
}

export interface PaymentRepository {
  insert(payment: Payment): Promise<Payment>;
  findById(id: string): Promise<Payment | null>;
  findByReference(reference: string): Promise<Payment | null>;
  findByProviderPaymentId(providerPaymentId: string): Promise<Payment | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<Payment | null>;
  list(filters?: PaymentListFilters): Promise<Payment[]>;
  findEventByProviderEventId(providerEventId: string, provider?: string): Promise<PaymentEvent | null>;
  /** Attach an external checkout to a previously persisted PENDING intent. */
  attachProviderPayment(input: {
    paymentId: string;
    provider: string;
    providerPaymentId: string;
    providerData: Record<string, unknown>;
    expiresAt: string | null;
  }): Promise<Payment>;
  /** Return a bounded batch ordered by earliest expiry first. */
  listPendingExpired(now: string, limit: number): Promise<Payment[]>;
  /** Must lock/check status and write the audit event in one transaction. */
  markPaidFromWebhook(input: {
    paymentId: string;
    provider: string;
    amountCents: number;
    currency: string;
    providerEventId: string;
    newStatus: PaymentStatus;
    payload: unknown;
    eventType: string;
    paidAt: string;
  }): Promise<{ payment: Payment; event: PaymentEvent | null; changed: boolean }>;
  /** Must lock/check status and write the administrative cancellation audit event in one transaction. */
  markCancelledByAdmin(input: {
    paymentId: string;
    provider: string;
    providerPaymentId: string;
    reference: string;
    providerEventId: string;
    eventId: string;
    actorId: string;
    reason?: string;
    cancelledAt: string;
  }): Promise<{ payment: Payment; event: PaymentEvent | null; changed: boolean }>;
  markExpired(paymentId: string, at: string): Promise<{ payment: Payment; event: PaymentEvent | null; changed: boolean }>;
  insertCashPayment(payment: Payment, event: PaymentEvent): Promise<Payment>;
}
