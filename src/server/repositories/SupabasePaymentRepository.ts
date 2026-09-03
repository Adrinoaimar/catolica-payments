import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaymentListFilters, PaymentRepository } from './PaymentRepository';
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
  async findByIdempotencyKey(idempotencyKey: string): Promise<Payment | null> { return this.findOne('idempotency_key', idempotencyKey); }

  async list(filters: PaymentListFilters = {}): Promise<Payment[]> {
    let query = this.client.from('payments').select('*').order('created_at', { ascending: false });
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.method === 'CASH') query = query.eq('provider', 'CASH');
    if (filters.method === 'DIGITAL') query = query.neq('provider', 'CASH');
    if (filters.provider) query = query.eq('provider', filters.provider);
    if (filters.createdBy) query = query.eq('created_by', filters.createdBy);
    if (filters.from) query = query.gte('created_at', filters.from);
    if (filters.to) query = query.lte('created_at', filters.to);
    if (filters.minAmountCents !== undefined) query = query.gte('amount_cents', filters.minAmountCents);
    if (filters.maxAmountCents !== undefined) query = query.lte('amount_cents', filters.maxAmountCents);
    query = query.limit(filters.limit ?? 100);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map((row: Row) => this.fromRow(row));
  }

  async findEventByProviderEventId(providerEventId: string, provider?: string): Promise<PaymentEvent | null> {
    let query = this.client.from('payment_events').select('*').eq('provider_event_id', providerEventId);
    if (provider) query = query.eq('provider', provider);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data ? this.eventFromRow(data) : null;
  }

  async attachProviderPayment(input: {
    paymentId: string;
    provider: string;
    providerPaymentId: string;
    providerData: Record<string, unknown>;
    expiresAt: string | null;
  }): Promise<Payment> {
    const { data, error } = await this.client.rpc('attach_payment_provider', {
      p_payment_id: input.paymentId,
      p_provider: input.provider,
      p_provider_payment_id: input.providerPaymentId,
      p_provider_data: input.providerData,
      p_expires_at: input.expiresAt,
    });
    if (error) throw error;
    const result = data as { payment?: Row } | null;
    if (!result?.payment) throw new Error('Supabase RPC returned no attached payment');
    return this.fromRow(result.payment);
  }

  async listPendingExpired(now: string): Promise<Payment[]> {
    const { data, error } = await this.client.from('payments').select('*').eq('status', 'PENDING').not('expires_at', 'is', null).lte('expires_at', now);
    if (error) throw error;
    return (data ?? []).map((row: Row) => this.fromRow(row));
  }

  async markPaidFromWebhook(input: {
    paymentId: string; provider: string; amountCents: number; currency: string; providerEventId: string; newStatus: PaymentStatus; payload: unknown; eventType: string; paidAt: string;
  }): Promise<{ payment: Payment; event: PaymentEvent | null; changed: boolean }> {
    const current = await this.findById(input.paymentId);
    if (!current) throw new Error('Payment not found');
    const { data, error } = await this.client.rpc('apply_payment_webhook', {
      p_provider: input.provider,
      p_provider_payment_id: current.providerPaymentId,
      p_reference: current.reference,
      p_amount_cents: input.amountCents,
      p_currency: input.currency,
      p_provider_event_id: input.providerEventId,
      p_event_type: input.eventType,
      p_new_status: input.newStatus,
      p_raw_payload: input.payload,
    });
    if (error) throw error;
    const result = data as { changed: boolean; payment: Row; event?: Row };
    if (!result?.payment) throw new Error('Supabase RPC returned no payment');
    return { payment: this.fromRow(result.payment), event: result.event ? this.eventFromRow(result.event) : null, changed: result.changed === true };
  }

  async markExpired(paymentId: string, at: string): Promise<{ payment: Payment; event: PaymentEvent | null; changed: boolean }> {
    const { data, error } = await this.client.rpc('expire_payment', { p_payment_id: paymentId, p_at: at });
    if (error) throw error;
    const result = data as { changed: boolean; payment: Row; event?: Row } | null;
    if (!result?.payment) throw new Error('Supabase RPC returned no payment');
    return { payment: this.fromRow(result.payment), event: result.event ? this.eventFromRow(result.event) : null, changed: result.changed === true };
  }

  async markCancelledByAdmin(input: {
    paymentId: string; provider: string; providerPaymentId: string; reference: string;
    providerEventId: string; eventId: string; actorId: string; reason?: string; cancelledAt: string;
  }): Promise<{ payment: Payment; event: PaymentEvent | null; changed: boolean }> {
    const { data, error } = await this.client.rpc('cancel_payment', {
      p_payment_id: input.paymentId,
      p_provider: input.provider,
      p_provider_payment_id: input.providerPaymentId,
      p_reference: input.reference,
      p_provider_event_id: input.providerEventId,
      p_event_id: input.eventId,
      p_actor_id: input.actorId,
      p_reason: input.reason ?? null,
      p_cancelled_at: input.cancelledAt,
    });
    if (error) throw error;
    const result = data as { changed: boolean; payment: Row; event?: Row } | null;
    if (!result?.payment) throw new Error('Supabase RPC returned no payment');
    return { payment: this.fromRow(result.payment), event: result.event ? this.eventFromRow(result.event) : null, changed: result.changed === true };
  }

  async insertCashPayment(payment: Payment, event: PaymentEvent): Promise<Payment> {
    const { data, error } = await this.client.rpc('record_cash_payment', {
      p_id: payment.id,
      p_reference: payment.reference,
      p_amount_cents: payment.amountCents,
      p_created_by: payment.createdBy,
      p_created_at: payment.createdAt,
      p_paid_at: payment.paidAt,
      p_provider_data: payment.providerData,
      p_event_id: event.id,
      p_event_provider_id: event.providerEventId,
      p_event_created_at: event.createdAt,
      p_idempotency_key: payment.idempotencyKey ?? null,
    });
    if (error) throw error;
    const result = data as { payment?: Row } | null;
    if (!result?.payment) throw new Error('Supabase RPC returned no cash payment');
    return this.fromRow(result.payment);
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
      idempotency_key: payment.idempotencyKey ?? null,
      created_by: payment.createdBy, created_at: payment.createdAt, expires_at: payment.expiresAt,
      paid_at: payment.paidAt, cancelled_at: payment.cancelledAt, provider_data: payment.providerData,
    };
  }

  private fromRow(row: Row): Payment {
    return {
      id: row.id, reference: row.reference, amountCents: row.amount_cents, currency: row.currency,
      provider: row.provider, providerPaymentId: row.provider_payment_id ?? null, status: row.status as PaymentStatus,
      idempotencyKey: row.idempotency_key ?? null,
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
