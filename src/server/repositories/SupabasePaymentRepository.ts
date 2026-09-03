import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaymentRepository } from './PaymentRepository';
import type { Payment, PaymentEvent, PaymentStatus } from '../payments/types';

type Row = Record<string, any>;

/** Supabase adapter. Webhook state transition is delegated to SECURITY DEFINER RPC for one DB transaction. */
export class SupabasePaymentRepository implements PaymentRepository {
  constructor(private readonly client: SupabaseClient) {}

  async insert(payment: Payment): Promise<Payment> {
    const { data, error } = await this.client.from('payments').insert(this.toRow(payment)).select().single();
    if (error) throw error;
    return this.fromRow(data);
  }

  async findById(id: string): Promise<Payment | null> { return this.findOne('id', id); }
  async findByReference(reference: string): Promise<Payment | null> { return this.findOne('reference', reference); }
  async findByProviderPaymentId(providerPaymentId: string): Promise<Payment | null> { return this.findOne('provider_payment_id', providerPaymentId); }

  async findEventByProviderEventId(providerEventId: string): Promise<PaymentEvent | null> {
    const { data, error } = await this.client.from('payment_events').select('*').eq('provider_event_id', providerEventId).maybeSingle();
    if (error) throw error;
    return data ? this.eventFromRow(data) : null;
  }

  async listPendingExpired(now: string): Promise<Payment[]> {
    const { data, error } = await this.client.from('payments').select('*').eq('status', 'PENDING').not('expires_at', 'is', null).lte('expires_at', now);
    if (error) throw error;
    return (data ?? []).map((row: Row) => this.fromRow(row));
  }

  async markPaidFromWebhook(input: {
    paymentId: string; provider: string; providerEventId: string; payload: unknown; eventType: string; paidAt: string;
  }): Promise<{ payment: Payment; event: PaymentEvent | null; changed: boolean }> {
    const current = await this.findById(input.paymentId);
    if (!current) throw new Error('Payment not found');
    const { data, error } = await this.client.rpc('apply_payment_webhook', {
      p_provider: input.provider,
      p_provider_payment_id: current.providerPaymentId,
      p_reference: current.reference,
      p_amount_cents: current.amountCents,
      p_currency: current.currency,
      p_provider_event_id: input.providerEventId,
      p_event_type: input.eventType,
      p_raw_payload: input.payload,
    });
    if (error) throw error;
    const result = data as { changed: boolean; payment: Row; event?: Row };
    if (!result?.payment) throw new Error('Supabase RPC returned no payment');
    return { payment: this.fromRow(result.payment), event: result.event ? this.eventFromRow(result.event) : null, changed: result.changed === true };
  }

  async markExpired(paymentId: string, at: string): Promise<{ payment: Payment; event: PaymentEvent | null; changed: boolean }> {
    const payment = await this.findById(paymentId);
    if (!payment) throw new Error('Payment not found');
    if (payment.status !== 'PENDING') return { payment, event: null, changed: false };
    const { data, error } = await this.client.from('payments').update({ status: 'EXPIRED' }).eq('id', paymentId).eq('status', 'PENDING').select().single();
    if (error) throw error;
    const next = this.fromRow(data);
    const { data: eventRow, error: eventError } = await this.client.from('payment_events').insert({
      payment_id: paymentId, event_type: 'payment.expired', previous_status: 'PENDING', new_status: 'EXPIRED', provider: payment.provider,
      provider_event_id: `expiry:${paymentId}:${at}`, raw_payload: { reason: 'expires_at reached' }, created_at: at,
    }).select().single();
    if (eventError) throw eventError;
    return { payment: next, event: this.eventFromRow(eventRow), changed: true };
  }

  async insertCashPayment(payment: Payment, event: PaymentEvent): Promise<Payment> {
    const { error: paymentError } = await this.client.from('payments').insert(this.toRow(payment));
    if (paymentError) throw paymentError;
    const { error: eventError } = await this.client.from('payment_events').insert(this.eventToRow(event));
    if (eventError) throw eventError;
    return payment;
  }

  private async findOne(column: string, value: string): Promise<Payment | null> {
    const { data, error } = await this.client.from('payments').select('*').eq(column, value).maybeSingle();
    if (error) throw error;
    return data ? this.fromRow(data) : null;
  }

  private toRow(payment: Payment): Row {
    return {
      id: payment.id, reference: payment.reference, amount_cents: payment.amountCents, currency: payment.currency,
      provider: payment.provider, provider_payment_id: payment.providerPaymentId, status: payment.status,
      created_by: payment.createdBy, created_at: payment.createdAt, expires_at: payment.expiresAt,
      paid_at: payment.paidAt, cancelled_at: payment.cancelledAt, provider_data: payment.providerData,
    };
  }

  private fromRow(row: Row): Payment {
    return {
      id: row.id, reference: row.reference, amountCents: row.amount_cents, currency: row.currency,
      provider: row.provider, providerPaymentId: row.provider_payment_id ?? null, status: row.status as PaymentStatus,
      createdBy: row.created_by ?? null, createdAt: row.created_at, expiresAt: row.expires_at ?? null,
      paidAt: row.paid_at ?? null, cancelledAt: row.cancelled_at ?? null, providerData: row.provider_data ?? {},
    };
  }

  private eventToRow(event: PaymentEvent): Row {
    return { id: event.id, payment_id: event.paymentId, event_type: event.eventType, previous_status: event.previousStatus, new_status: event.newStatus, provider: event.provider, provider_event_id: event.providerEventId, raw_payload: event.rawPayload, created_at: event.createdAt };
  }

  private eventFromRow(row: Row): PaymentEvent {
    return { id: row.id, paymentId: row.payment_id, eventType: row.event_type, previousStatus: row.previous_status as PaymentStatus, newStatus: row.new_status as PaymentStatus, provider: row.provider, providerEventId: row.provider_event_id, rawPayload: row.raw_payload, createdAt: row.created_at };
  }
}
