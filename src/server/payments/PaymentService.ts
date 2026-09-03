import { randomUUID } from 'node:crypto';
import type { PaymentProvider } from '../providers/PaymentProvider';
import type { PaymentRepository } from '../repositories/PaymentRepository';
import type { Payment, PaymentEvent, VerifiedWebhook } from './types';
import { generateReference } from './reference';

export interface PaymentServiceOptions {
  repository: PaymentRepository;
  provider: PaymentProvider;
  now?: () => Date;
  reference?: () => string;
  expiryMinutes?: number;
  maxAmountCents?: number;
}

export interface CreatedPayment {
  payment: Payment;
  providerPayment: Awaited<ReturnType<PaymentProvider['createPayment']>>;
}

export class PaymentService {
  private readonly now: () => Date;
  private readonly makeReference: () => string;
  private readonly expiryMinutes: number;
  private readonly maxAmountCents: number;

  constructor(private readonly options: PaymentServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.makeReference = options.reference ?? (() => generateReference(this.now()));
    this.expiryMinutes = options.expiryMinutes ?? 15;
    this.maxAmountCents = options.maxAmountCents ?? 1_000_000;
  }

  async createDigitalPayment(input: { amountCents: number; createdBy?: string | null }): Promise<CreatedPayment> {
    this.validateAmount(input.amountCents);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.expiryMinutes * 60_000);
    const reference = this.makeReference();
    const providerPayment = await this.options.provider.createPayment({
      amountCents: input.amountCents, currency: 'PEN', reference,
      createdBy: input.createdBy ?? null, expiresAt: expiresAt.toISOString(),
    });
    const payment: Payment = {
      id: randomUUID(), reference, amountCents: input.amountCents, currency: 'PEN',
      provider: this.options.provider.name, providerPaymentId: providerPayment.providerPaymentId,
      status: 'PENDING', createdBy: input.createdBy ?? null, createdAt: createdAt.toISOString(),
      expiresAt: providerPayment.expiresAt ?? expiresAt.toISOString(), paidAt: null, cancelledAt: null,
      providerData: providerPayment.providerData ?? {},
    };
    await this.options.repository.insert(payment);
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
    if (!webhook.eventId || !webhook.providerPaymentId || !webhook.reference) throw new Error('Invalid webhook');
    this.validateAmount(webhook.amountCents);
    const payment = await this.options.repository.findByProviderPaymentId(webhook.providerPaymentId);
    if (!payment) throw new Error('Payment not found for provider payment ID');
    if (payment.reference !== webhook.reference) throw new Error('Webhook reference mismatch');
    if (payment.amountCents !== webhook.amountCents || payment.currency !== webhook.currency) throw new Error('Webhook amount mismatch');
    if (webhook.status !== 'PAID') throw new Error(`Webhook status is not payable: ${webhook.status}`);
    const result = await this.options.repository.markPaidFromWebhook({
      paymentId: payment.id, provider: this.options.provider.name, providerEventId: webhook.eventId,
      payload: webhook.payload, eventType: webhook.eventType, paidAt: this.now().toISOString(),
    });
    return { payment: result.payment, changed: result.changed };
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
}
