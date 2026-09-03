import type { Payment, PaymentEvent, PaymentStatus } from '../payments/types';

export interface PaymentListFilters {
  status?: PaymentStatus;
  provider?: string;
  createdBy?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface PaymentRepository {
  insert(payment: Payment): Promise<Payment>;
  findById(id: string): Promise<Payment | null>;
  findByReference(reference: string): Promise<Payment | null>;
  findByProviderPaymentId(providerPaymentId: string): Promise<Payment | null>;
  list(filters?: PaymentListFilters): Promise<Payment[]>;
  findEventByProviderEventId(providerEventId: string): Promise<PaymentEvent | null>;
  listPendingExpired(now: string): Promise<Payment[]>;
  /** Must lock/check status and write the audit event in one transaction. */
  markPaidFromWebhook(input: {
    paymentId: string;
    provider: string;
    amountCents: number;
    currency: string;
    providerEventId: string;
    payload: unknown;
    eventType: string;
    paidAt: string;
  }): Promise<{ payment: Payment; event: PaymentEvent | null; changed: boolean }>;
  markExpired(paymentId: string, at: string): Promise<{ payment: Payment; event: PaymentEvent | null; changed: boolean }>;
  insertCashPayment(payment: Payment, event: PaymentEvent): Promise<Payment>;
}
