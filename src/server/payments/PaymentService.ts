import { randomUUID } from 'node:crypto';
import { ProviderError, type PaymentProvider } from '../providers/PaymentProvider';
import type { ProviderPayment } from './types';
import type { PaymentRepository } from '../repositories/PaymentRepository';
import type { Payment, PaymentEvent, VerifiedWebhook } from './types';
import { generateIdempotentReference, generateReference } from './reference';

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
  /** Bounded provider concurrency for one reconciliation pass. */
  reconcileConcurrency?: number;
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
  private readonly reconcileConcurrency: number;

  constructor(private readonly options: PaymentServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.makeReference = options.reference ?? (() => generateReference(this.now()));
    this.expiryMinutes = options.expiryMinutes ?? 15;
    this.maxAmountCents = options.maxAmountCents ?? 1_000_000;
    // Keep one scheduled pass bounded. A later pass continues with the
    // remaining rows, while idempotent RPCs make overlapping passes safe.
    this.reconcileLimit = options.reconcileLimit ?? 25;
    this.reconcileConcurrency = Math.min(8, Math.max(1, options.reconcileConcurrency ?? 4));
  }

  async createDigitalPayment(input: { amountCents: number; createdBy?: string | null; idempotencyKey?: string | null }): Promise<CreatedPayment> {
    this.validateAmount(input.amountCents);
    const provider = this.digitalProvider();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.expiryMinutes * 60_000);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const existing = idempotencyKey ? await this.options.repository.findByIdempotencyKey(idempotencyKey) : null;
    if (existing) {
      assertRetryCompatible(existing, { amountCents: input.amountCents, createdBy: input.createdBy ?? null, provider: provider.name });
      return { payment: existing, providerPayment: this.providerPaymentFromPayment(existing) };
    }
    const reference = idempotencyKey ? generateIdempotentReference(createdAt, idempotencyKey) : this.makeReference();
    const providerPayment = await provider.createPayment({
      amountCents: input.amountCents, currency: 'PEN', reference,
      createdBy: input.createdBy ?? null, expiresAt: expiresAt.toISOString(),
    });
    let payment: Payment;
    let cancelOrphan = true;
    try {
      validateCreatedProviderPayment(providerPayment, {
        provider: provider.name,
        reference,
        amountCents: input.amountCents,
        currency: 'PEN',
      });
      payment = {
        id: randomUUID(), reference, amountCents: input.amountCents, currency: 'PEN',
        provider: provider.name, providerPaymentId: providerPayment.providerPaymentId,
        status: 'PENDING', createdBy: input.createdBy ?? null, createdAt: createdAt.toISOString(),
        expiresAt: providerPayment.expiresAt ?? expiresAt.toISOString(), paidAt: null, cancelledAt: null,
        providerData: providerPayment.providerData ?? {}, idempotencyKey,
      };
      try {
        await this.options.repository.insert(payment);
      } catch (insertError) {
        // Two retries can reach the provider concurrently. If the first one
        // won the ledger insert, return its row rather than cancelling the
        // shared provider checkout.
        if (idempotencyKey) {
          const committed = await this.options.repository.findByIdempotencyKey(idempotencyKey);
          if (committed) {
            assertRetryCompatible(committed, { amountCents: input.amountCents, createdBy: input.createdBy ?? null, provider: provider.name });
            return { payment: committed, providerPayment: this.providerPaymentFromPayment(committed) };
          }
          // The first concurrent request may still be committing. TAYPI's
          // provider idempotency key makes the checkout recoverable on retry;
          // cancelling here could cancel the sibling request's checkout.
          cancelOrphan = false;
        }
        throw insertError;
      }
    } catch (error) {
      // External checkout already exists. Best-effort cancellation prevents an
      // orphaned QR when the ledger insert fails (for example, a duplicate
      // reference or a transient database error).
      if (cancelOrphan) {
        try { await provider.cancelPayment(providerPayment.providerPaymentId); } catch (cancelError) {
          console.error('Could not cancel orphaned provider payment', cancelError);
        }
      }
      throw error;
    }
    return { payment, providerPayment };
  }

  async createCashPayment(input: { amountCents: number; createdBy?: string | null; idempotencyKey?: string | null }): Promise<Payment> {
    this.validateAmount(input.amountCents);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const existing = idempotencyKey ? await this.options.repository.findByIdempotencyKey(idempotencyKey) : null;
    if (existing) {
      assertRetryCompatible(existing, { amountCents: input.amountCents, createdBy: input.createdBy ?? null, provider: 'CASH' });
      return existing;
    }
    const now = this.now().toISOString();
    const payment: Payment = {
      id: randomUUID(), reference: this.makeReference(), amountCents: input.amountCents,
      currency: 'PEN', provider: 'CASH', providerPaymentId: null, status: 'PAID',
      createdBy: input.createdBy ?? null, createdAt: now, expiresAt: null, paidAt: now,
      cancelledAt: null, providerData: { method: 'cash' }, idempotencyKey,
    };
    const event: PaymentEvent = {
      id: randomUUID(), paymentId: payment.id, eventType: 'cash.recorded', previousStatus: 'PENDING',
      newStatus: 'PAID', provider: 'CASH', providerEventId: `cash:${payment.id}`, rawPayload: {}, createdAt: now,
    };
    try {
      await this.options.repository.insertCashPayment(payment, event);
    } catch (insertError) {
      if (idempotencyKey) {
        const committed = await this.options.repository.findByIdempotencyKey(idempotencyKey);
        if (committed) {
          assertRetryCompatible(committed, { amountCents: input.amountCents, createdBy: input.createdBy ?? null, provider: 'CASH' });
          return committed;
        }
      }
      throw insertError;
    }
    return payment;
  }

  private providerPaymentFromPayment(payment: Payment): ProviderPayment {
    const data = payment.providerData ?? {};
    const stringValue = (...values: unknown[]) => values.find((value): value is string => typeof value === 'string' && value.length > 0);
    return {
      providerPaymentId: payment.providerPaymentId ?? '', status: payment.status,
      amountCents: payment.amountCents, currency: payment.currency, reference: payment.reference,
      expiresAt: payment.expiresAt ?? undefined,
      qrCode: stringValue(data.qrCode, data.qr_code, data.qr_image),
      checkoutUrl: stringValue(data.checkoutUrl, data.checkout_url),
      checkoutToken: stringValue(data.checkoutToken, data.checkout_token),
      providerData: data,
    };
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
    const reconcileOne = async (payment: Payment): Promise<{ kind: 'reconciled' | 'skipped' | 'error'; payment?: Payment }> => {
      if (!payment.providerPaymentId) return { kind: 'skipped' };
      try {
        const state = await provider.getPayment(payment.providerPaymentId);
        if (state.providerPaymentId !== payment.providerPaymentId || !state.reference || state.reference !== payment.reference) {
          return { kind: 'skipped' };
        }
        if (!Number.isSafeInteger(state.amountCents) || state.amountCents !== payment.amountCents || state.currency !== payment.currency) {
          return { kind: 'skipped' };
        }
        if (!isTerminalStatus(state.status)) {
          return { kind: 'skipped' };
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
        return result.changed ? { kind: 'reconciled', payment: result.payment } : { kind: 'skipped' };
      } catch (error) {
        console.error('Payment reconciliation failed', payment.id, error instanceof Error ? error.message : 'unknown error');
        return { kind: 'error' };
      }
    };
    for (let offset = 0; offset < pending.length; offset += this.reconcileConcurrency) {
      const outcomes = await Promise.all(pending.slice(offset, offset + this.reconcileConcurrency).map(reconcileOne));
      for (const outcome of outcomes) {
        if (outcome.kind === 'reconciled' && outcome.payment) { summary.reconciled += 1; summary.payments.push(outcome.payment); }
        else if (outcome.kind === 'error') summary.errors += 1;
        else summary.skipped += 1;
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

function validateCreatedProviderPayment(
  providerPayment: Awaited<ReturnType<PaymentProvider['createPayment']>>,
  expected: { provider: string; reference: string; amountCents: number; currency: string },
): void {
  if (!providerPayment || typeof providerPayment.providerPaymentId !== 'string' || !providerPayment.providerPaymentId.trim()) {
    throw new ProviderError(`${expected.provider} response missing payment ID`, 502, 'PROVIDER_INVALID_RESPONSE');
  }
  if (providerPayment.amountCents !== expected.amountCents) {
    throw new ProviderError(`${expected.provider} response amount mismatch`, 502, 'PROVIDER_INVALID_RESPONSE');
  }
  if (providerPayment.currency?.toUpperCase() !== expected.currency) {
    throw new ProviderError(`${expected.provider} response currency mismatch`, 502, 'PROVIDER_INVALID_RESPONSE');
  }
  if (providerPayment.reference !== expected.reference) {
    throw new ProviderError(`${expected.provider} response reference mismatch`, 502, 'PROVIDER_INVALID_RESPONSE');
  }
  if (providerPayment.status && providerPayment.status !== 'PENDING') {
    throw new ProviderError(`${expected.provider} returned an unexpected creation status`, 502, 'PROVIDER_INVALID_RESPONSE');
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

function normalizeIdempotencyKey(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  const normalized = value.trim();
  if (normalized.length < 16 || normalized.length > 200 || /[^\x21-\x7e]/.test(normalized)) {
    throw new PaymentOperationError(409, 'Idempotency-Key must contain 16 to 200 printable characters');
  }
  return normalized;
}

function assertRetryCompatible(
  payment: Payment,
  expected: { amountCents: number; createdBy: string | null; provider: string },
): void {
  if (payment.amountCents !== expected.amountCents || payment.createdBy !== expected.createdBy || payment.provider !== expected.provider) {
    throw new PaymentOperationError(409, 'Idempotency-Key was already used with different payment data');
  }
}
