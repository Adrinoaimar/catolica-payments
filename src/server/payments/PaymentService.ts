import { randomUUID } from 'node:crypto';
import type { PaymentProvider } from '../providers/PaymentProvider';
import type { PaymentRepository } from '../repositories/PaymentRepository';
import type { Payment, PaymentEvent, VerifiedWebhook } from './types';
import { generateReference } from './reference';

export interface PaymentServiceOptions {
  repository: PaymentRepository;
  /** Provider is required for digital payments, optional for cash-only routes. */
  provider?: PaymentProvider;
  now?: () => Date;
  reference?: () => string;
  expiryMinutes?: number;
  maxAmountCents?: number;
  /** Maximum pending rows inspected by one reconciliation pass. */
  reconcileLimit?: number;
}

export interface CreatedPayment {
  payment: Payment;
  providerPayment: Awaited<ReturnType<PaymentProvider['createPayment']>>;
}

export class PaymentOperationError extends Error {
  constructor(readonly statusCode: 404 | 409, message: string) {
    super(message);
    this.name = 'PaymentOperationError';
  }
}

export class PaymentService {
  private readonly now: () => Date;
  private readonly makeReference: () => string;
  private readonly expiryMinutes: number;
  private readonly maxAmountCents: number;
  private readonly reconcileLimit: number;

  constructor(private readonly options: PaymentServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.makeReference = options.reference ?? (() => generateReference(this.now()));
    this.expiryMinutes = options.expiryMinutes ?? 15;
    this.maxAmountCents = options.maxAmountCents ?? 1_000_000;
    this.reconcileLimit = options.reconcileLimit ?? 200;
  }

  async createDigitalPayment(input: { amountCents: number; createdBy?: string | null }): Promise<CreatedPayment> {
    this.validateAmount(input.amountCents);
    const provider = this.digitalProvider();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.expiryMinutes * 60_000);
    const reference = this.makeReference();
    const providerPayment = await provider.createPayment({
      amountCents: input.amountCents, currency: 'PEN', reference,
      createdBy: input.createdBy ?? null, expiresAt: expiresAt.toISOString(),
    });
    const payment: Payment = {
      id: randomUUID(), reference, amountCents: input.amountCents, currency: 'PEN',
      provider: provider.name, providerPaymentId: providerPayment.providerPaymentId,
      status: 'PENDING', createdBy: input.createdBy ?? null, createdAt: createdAt.toISOString(),
      expiresAt: providerPayment.expiresAt ?? expiresAt.toISOString(), paidAt: null, cancelledAt: null,
      providerData: providerPayment.providerData ?? {},
    };
    try {
      await this.options.repository.insert(payment);
    } catch (error) {
      // External checkout already exists. Best-effort cancellation prevents an
      // orphaned QR when the ledger insert fails (for example, a duplicate
      // reference or a transient database error).
      try { await provider.cancelPayment(providerPayment.providerPaymentId); } catch (cancelError) {
        console.error('Could not cancel orphaned provider payment', cancelError);
      }
      throw error;
    }
    return { payment, providerPayment };
  }

  async createCashPayment(input: { amountCents: number; createdBy?: string | null }): Promise<Payment> {
    this.validateAmount(input.amountCents);
    const now = this.now().toISOString();
    const payment: Payment = {
      id: randomUUID(), reference: this.makeReference(), amountCents: input.amountCents,
      currency: 'PEN', provider: 'CASH', providerPaymentId: null, status: 'PAID',
      createdBy: input.createdBy ?? null, createdAt: now, expiresAt: null, paidAt: now,
      cancelledAt: null, providerData: { method: 'cash' },
    };
    const event: PaymentEvent = {
      id: randomUUID(), paymentId: payment.id, eventType: 'cash.recorded', previousStatus: 'PENDING',
      newStatus: 'PAID', provider: 'CASH', providerEventId: `cash:${payment.id}`, rawPayload: {}, createdAt: now,
    };
    await this.options.repository.insertCashPayment(payment, event);
    return payment;
  }

  async processWebhook(webhook: VerifiedWebhook): Promise<{ payment: Payment; changed: boolean }> {
    const provider = this.digitalProvider();
    if (!webhook.eventId || !webhook.providerPaymentId || !webhook.reference || !webhook.eventType) throw new Error('Invalid webhook');
    if (!isTerminalStatus(webhook.status)) throw new Error('Invalid webhook status');
    if (webhook.currency !== 'PEN') throw new Error('Unsupported webhook currency');
    this.validateAmount(webhook.amountCents);
    const payment = await this.options.repository.findByProviderPaymentId(webhook.providerPaymentId);
    if (!payment) throw new Error('Payment not found for provider payment ID');
    if (payment.reference !== webhook.reference) throw new Error('Webhook reference mismatch');
    if (payment.amountCents !== webhook.amountCents || payment.currency !== webhook.currency) throw new Error('Webhook amount mismatch');
    const result = await this.options.repository.markPaidFromWebhook({
      paymentId: payment.id, provider: provider.name, amountCents: webhook.amountCents, currency: webhook.currency,
      providerEventId: webhook.eventId, newStatus: webhook.status,
      payload: webhook.payload, eventType: webhook.eventType, paidAt: this.now().toISOString(),
    });
    return { payment: result.payment, changed: result.changed };
  }

  /**
   * Reconcile pending payments when a provider webhook was delayed or lost.
   * Provider response is treated as untrusted until identity, amount, currency
   * and terminal status are checked, then the same atomic ledger transition as
   * webhook processing is used. No frontend signal participates.
   */
  async reconcilePendingPayments(): Promise<ReconciliationSummary> {
    const provider = this.digitalProvider();
    // A local expiry wins before polling. This prevents a late provider result
    // from paying an operation whose QR already expired in our ledger.
    await this.expirePayments(this.now());
    const pending = await this.options.repository.list({ status: 'PENDING', provider: provider.name, limit: this.reconcileLimit });
    const summary: ReconciliationSummary = { inspected: pending.length, reconciled: 0, skipped: 0, errors: 0, payments: [] };
    for (const payment of pending) {
      if (!payment.providerPaymentId) { summary.skipped += 1; continue; }
      try {
        const state = await provider.getPayment(payment.providerPaymentId);
        if (state.providerPaymentId !== payment.providerPaymentId || !state.reference || state.reference !== payment.reference) {
          summary.skipped += 1; continue;
        }
        if (!Number.isSafeInteger(state.amountCents) || state.amountCents !== payment.amountCents || state.currency !== payment.currency) {
          summary.skipped += 1; continue;
        }
        if (!isTerminalStatus(state.status)) {
          summary.skipped += 1; continue;
        }
        const eventId = normalizeReconciliationEventId(state.eventId, provider.name, state.providerPaymentId);
        const result = await this.processWebhook({
          eventId,
          eventType: `payment.${state.status.toLowerCase()}`,
          providerPaymentId: state.providerPaymentId,
          reference: state.reference,
          amountCents: state.amountCents,
          currency: state.currency,
          status: state.status,
          payload: {
            source: 'server_reconciliation',
            event_id: eventId,
            provider_payment_id: state.providerPaymentId,
            reference: state.reference,
            amount_cents: state.amountCents,
            currency: state.currency,
            status: state.status,
          },
        });
        if (result.changed) { summary.reconciled += 1; summary.payments.push(result.payment); }
        else summary.skipped += 1;
      } catch (error) {
        summary.errors += 1;
        console.error('Payment reconciliation failed', payment.id, error instanceof Error ? error.message : 'unknown error');
      }
    }
    return summary;
  }

  /** Reconcile one operation on demand. This is a bounded fallback for a
   * cashier's open payment screen when a scheduled job is not available. */
  async reconcilePaymentByReference(reference: string): Promise<{ payment: Payment; changed: boolean }> {
    const provider = this.digitalProvider();
    // Apply the same local-expiry rule as the scheduled pass before asking the
    // provider. A late result must never reopen a ledger row already expired.
    const payment = await this.findPaymentByReference(reference);
    if (!payment) throw new Error('Payment not found');
    if (payment.status !== 'PENDING' || payment.provider !== provider.name || !payment.providerPaymentId) {
      return { payment, changed: false };
    }
    const state = await provider.getPayment(payment.providerPaymentId);
    if (state.providerPaymentId !== payment.providerPaymentId
      || state.reference !== payment.reference
      || !Number.isSafeInteger(state.amountCents) || state.amountCents !== payment.amountCents
      || state.currency !== payment.currency
      || !isTerminalStatus(state.status)) {
      return { payment, changed: false };
    }
    const eventId = normalizeReconciliationEventId(state.eventId, provider.name, state.providerPaymentId);
    return this.processWebhook({
      eventId,
      eventType: `payment.${state.status.toLowerCase()}`,
      providerPaymentId: state.providerPaymentId,
      reference: state.reference,
      amountCents: state.amountCents,
      currency: state.currency,
      status: state.status,
      payload: {
        source: 'server_reconciliation', event_id: eventId,
        provider_payment_id: state.providerPaymentId, reference: state.reference,
        amount_cents: state.amountCents, currency: state.currency, status: state.status,
      },
    });
  }

  /**
   * Cancel one pending digital payment from an authenticated administrative
   * action. Provider state is checked before cancellation so a stale ledger
   * cannot cancel an already paid provider operation. Ledger transition and
   * audit event are atomic after provider cancellation succeeds.
   */
  async cancelPaymentByReference(input: {
    reference: string;
    actorId: string;
    reason?: string;
  }): Promise<{ payment: Payment; changed: boolean }> {
    const actorId = input.actorId.trim();
    if (!actorId) throw new PaymentOperationError(409, 'Administrator identity is required');
    const reason = input.reason?.trim();
    if (reason && reason.length > 500) throw new PaymentOperationError(409, 'Cancellation reason is too long');

    const payment = await this.findPaymentByReference(input.reference);
    if (!payment) throw new PaymentOperationError(404, 'Payment not found');
    if (payment.status !== 'PENDING') return { payment, changed: false };

    const provider = this.digitalProvider();
    if (payment.provider !== provider.name || !payment.providerPaymentId) {
      throw new PaymentOperationError(409, 'Only pending digital payments can be cancelled');
    }

    // Provider state is untrusted until identity, amount and currency match.
    // Terminal provider state is reconciled through same atomic webhook path;
    // no cancellation request is sent for PAID or other terminal states.
    const state = await provider.getPayment(payment.providerPaymentId);
    if (state.providerPaymentId !== payment.providerPaymentId
      || state.reference !== payment.reference
      || !Number.isSafeInteger(state.amountCents) || state.amountCents !== payment.amountCents
      || state.currency !== payment.currency) {
      throw new PaymentOperationError(409, 'Provider payment identity or amount mismatch');
    }
    if (state.status !== 'PENDING') {
      if (isTerminalStatus(state.status)) {
        return this.reconcilePaymentByReference(payment.reference);
      }
      throw new PaymentOperationError(409, 'Provider payment state cannot be cancelled');
    }

    // Idempotent provider adapters make retry safe. If this call fails, keep
    // ledger PENDING; never claim cancellation without provider confirmation.
    await provider.cancelPayment(payment.providerPaymentId);
    const cancelledAt = this.now().toISOString();
    const result = await this.options.repository.markCancelledByAdmin({
      paymentId: payment.id,
      provider: provider.name,
      providerPaymentId: payment.providerPaymentId,
      reference: payment.reference,
      providerEventId: `admin_cancel:${payment.id}`,
      eventId: randomUUID(),
      actorId,
      ...(reason ? { reason } : {}),
      cancelledAt,
    });
    return { payment: result.payment, changed: result.changed };
  }

  /** Read ledger state and expire an overdue pending payment transactionally. */
  async findPaymentByReference(reference: string): Promise<Payment | null> {
    const payment = await this.options.repository.findByReference(reference);
    if (!payment) return null;
    if (payment.status === 'PENDING' && payment.expiresAt && new Date(payment.expiresAt).getTime() <= this.now().getTime()) {
      return (await this.options.repository.markExpired(payment.id, this.now().toISOString())).payment;
    }
    return payment;
  }

  async expirePayments(now = this.now()): Promise<Payment[]> {
    const expired = await this.options.repository.listPendingExpired(now.toISOString());
    const result: Payment[] = [];
    for (const payment of expired) {
      const item = await this.options.repository.markExpired(payment.id, now.toISOString());
      result.push(item.payment);
    }
    return result;
  }

  private validateAmount(amountCents: number): void {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('Amount must be greater than zero');
    if (amountCents > this.maxAmountCents) throw new Error('Amount exceeds maximum');
  }

  private digitalProvider(): PaymentProvider {
    if (!this.options.provider) throw new Error('Digital payment provider is not configured');
    return this.options.provider;
  }
}

export interface ReconciliationSummary {
  inspected: number;
  reconciled: number;
  skipped: number;
  errors: number;
  payments: Payment[];
}

function normalizeReconciliationEventId(eventId: string | undefined, provider: string, providerPaymentId: string): string {
  const value = typeof eventId === 'string' ? eventId.trim() : '';
  if (value && value.length <= 200) return value;
  return `reconcile:${provider}:${providerPaymentId}:terminal`;
}

function isTerminalStatus(status: Payment['status'] | undefined): status is Exclude<Payment['status'], 'PENDING'> {
  return status === 'PAID' || status === 'FAILED' || status === 'EXPIRED' || status === 'CANCELLED';
}
