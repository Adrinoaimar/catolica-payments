export const PAYMENT_STATUSES = [
  'PENDING',
  'PAID',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type PaymentMethod = 'DIGITAL' | 'CASH';

export interface Payment {
  id: string;
  reference: string;
  amountCents: number;
  currency: string;
  provider: string;
  providerPaymentId: string | null;
  status: PaymentStatus;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  paidAt: string | null;
  cancelledAt: string | null;
  providerData: Record<string, unknown>;
  /** Client-supplied key used to make a create request retry-safe. */
  idempotencyKey?: string | null;
}

export interface PaymentEvent {
  id: string;
  paymentId: string;
  eventType: string;
  previousStatus: PaymentStatus;
  newStatus: PaymentStatus;
  provider: string;
  providerEventId: string;
  rawPayload: unknown;
  createdAt: string;
}

export interface CreatePaymentInput {
  amountCents: number;
  currency?: string;
  reference: string;
  createdBy?: string | null;
  expiresAt?: string | null;
}

export interface ProviderPayment {
  providerPaymentId: string;
  /** Normalized provider state returned by getPayment for reconciliation. */
  status?: PaymentStatus;
  amountCents?: number;
  currency?: string;
  reference?: string;
  eventId?: string;
  paidAt?: string;
  checkoutUrl?: string;
  /** Opaque checkout token used by providers such as TAYPI. */
  checkoutToken?: string;
  qrCode?: string;
  expiresAt?: string;
  providerData?: Record<string, unknown>;
}

export interface VerifiedWebhook {
  eventId: string;
  eventType: string;
  providerPaymentId: string;
  reference: string;
  amountCents: number;
  currency: string;
  status: 'PAID' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
  /** Provider-confirmed capture time, when present in the signed payload. */
  paidAt?: string;
  payload: unknown;
}

export interface WebhookRequest {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}
