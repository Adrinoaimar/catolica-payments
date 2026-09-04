import type { NeonDbClient } from '../neon';
import type { PaymentListFilters, PaymentRepository } from './PaymentRepository';
import type { Payment, PaymentEvent, PaymentStatus } from '../payments/types';

type Row = Record<string, any>;

/** PostgreSQL adapter for Neon. All money transitions use the SQL functions in
 * database/migrations, so webhooks and retries remain atomic. */
export class NeonPaymentRepository implements PaymentRepository {
  constructor(private readonly client: NeonDbClient) {}

  async insert(payment: Payment): Promise<Payment> {
    const result = await this.client.from('payments').insert(this.toRow(payment)).select('*').single();
    if (result.error) throw result.error;
    return this.fromRow(result.data);
  }

  async findById(id: string): Promise<Payment | null> { return this.findOne('id', id); }
  async findByReference(reference: string): Promise<Payment | null> { return this.findOne('reference', reference); }
  async findByProviderPaymentId(providerPaymentId: string): Promise<Payment | null> { return this.findOne('provider_payment_id', providerPaymentId); }
  async findByIdempotencyKey(idempotencyKey: string): Promise<Payment | null> { return this.findOne('idempotency_key', idempotencyKey); }

  async list(filters: PaymentListFilters = {}): Promise<Payment[]> {
    let query: any = this.client.from('payments').select('*').order('created_at', { ascending: false });
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.method === 'CASH') query = query.eq('provider', 'CASH');
    if (filters.method === 'DIGITAL') query = query.neq('provider', 'CASH');
    if (filters.provider) query = query.eq('provider', filters.provider);
    if (filters.createdBy) query = query.eq('created_by', filters.createdBy);
    if (filters.from) query = query.gte('created_at', filters.from);
    if (filters.to) query = query.lte('created_at', filters.to);
    if (filters.minAmountCents !== undefined) query = query.gte('amount_cents', filters.minAmountCents);
    if (filters.maxAmountCents !== undefined) query = query.lte('amount_cents', filters.maxAmountCents);
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;
    const result = await query.range(offset, offset + limit - 1);
    if (result.error) throw result.error;
    return (result.data ?? []).map((row: Row) => this.fromRow(row));
  }

  async findEventByProviderEventId(providerEventId: string, provider?: string): Promise<PaymentEvent | null> {
    let query: any = this.client.from('payment_events').select('*').eq('provider_event_id', providerEventId);
    if (provider) query = query.eq('provider', provider);
    const result = await query.maybeSingle();
    if (result.error) throw result.error;
    return result.data ? this.eventFromRow(result.data) : null;
  }

  async attachProviderPayment(input: { paymentId: string; provider: string; providerPaymentId: string; providerData: Record<string, unknown>; expiresAt: string | null }): Promise<Payment> {
    const result = await this.client.rpc('attach_payment_provider', {
      p_payment_id: input.paymentId, p_provider: input.provider, p_provider_payment_id: input.providerPaymentId,
      p_provider_data: JSON.stringify(input.providerData), p_expires_at: input.expiresAt,
    });
    if (result.error) throw result.error;
    if (!result.data?.payment) throw new Error('Neon RPC returned no attached payment');
    return this.fromRow(result.data.payment);
  }

  async listPendingExpired(now: string, limit: number): Promise<Payment[]> {
    const result = await this.client.from('payments').select('*').eq('status', 'PENDING').not('expires_at', 'is', null)
      .lte('expires_at', now).order('expires_at', { ascending: true }).limit(limit);
    if (result.error) throw result.error;
    return (result.data ?? []).map((row: Row) => this.fromRow(row));
  }

  async markPaidFromWebhook(input: { paymentId: string; provider: string; amountCents: number; currency: string; providerEventId: string; newStatus: PaymentStatus; payload: unknown; eventType: string; paidAt: string }): Promise<{ payment: Payment; event: PaymentEvent | null; changed: boolean }> {
    const current = await this.findById(input.paymentId);
    if (!current) throw new Error('Payment not found');
    const result = await this.client.rpc('apply_payment_webhook', {
      p_provider: input.provider, p_provider_payment_id: current.providerPaymentId, p_reference: current.reference,
      p_amount_cents: input.amountCents, p_currency: input.currency, p_provider_event_id: input.providerEventId,
      p_event_type: input.eventType, p_new_status: input.newStatus, p_raw_payload: JSON.stringify(input.payload), p_paid_at: input.paidAt,
    });
    if (result.error) throw result.error;
    if (!result.data?.payment) throw new Error('Neon RPC returned no payment');
    return { payment: this.fromRow(result.data.payment), event: result.data.event ? this.eventFromRow(result.data.event) : null, changed: result.data.changed === true };
  }

  async markExpired(paymentId: string, at: string): Promise<{ payment: Payment; event: PaymentEvent | null; changed: boolean }> {
    const result = await this.client.rpc('expire_payment', { p_payment_id: paymentId, p_at: at });
    if (result.error) throw result.error;
    if (!result.data?.payment) throw new Error('Neon RPC returned no payment');
    return { payment: this.fromRow(result.data.payment), event: result.data.event ? this.eventFromRow(result.data.event) : null, changed: result.data.changed === true };
  }

  async markCancelledByAdmin(input: { paymentId: string; provider: string; providerPaymentId: string; reference: string; providerEventId: string; eventId: string; actorId: string; reason?: string; cancelledAt: string }): Promise<{ payment: Payment; event: PaymentEvent | null; changed: boolean }> {
    const result = await this.client.rpc('cancel_payment', {
      p_payment_id: input.paymentId, p_provider: input.provider, p_provider_payment_id: input.providerPaymentId,
      p_reference: input.reference, p_provider_event_id: input.providerEventId, p_event_id: input.eventId,
      p_actor_id: input.actorId, p_reason: input.reason ?? null, p_cancelled_at: input.cancelledAt,
    });
    if (result.error) throw result.error;
    if (!result.data?.payment) throw new Error('Neon RPC returned no payment');
    return { payment: this.fromRow(result.data.payment), event: result.data.event ? this.eventFromRow(result.data.event) : null, changed: result.data.changed === true };
  }

  async insertCashPayment(payment: Payment, event: PaymentEvent): Promise<Payment> {
    const result = await this.client.rpc('record_cash_payment', {
      p_id: payment.id, p_reference: payment.reference, p_amount_cents: payment.amountCents, p_created_by: payment.createdBy,
      p_created_at: payment.createdAt, p_paid_at: payment.paidAt, p_provider_data: JSON.stringify(payment.providerData),
      p_event_id: event.id, p_event_provider_id: event.providerEventId, p_event_created_at: event.createdAt,
      p_idempotency_key: payment.idempotencyKey ?? null,
    });
    if (result.error) throw result.error;
    if (!result.data?.payment) throw new Error('Neon RPC returned no cash payment');
    return this.fromRow(result.data.payment);
  }

  private async findOne(column: string, value: string): Promise<Payment | null> {
    const result = await this.client.from('payments').select('*').eq(column, value).maybeSingle();
    if (result.error) throw result.error;
    return result.data ? this.fromRow(result.data) : null;
  }

  private toRow(payment: Payment): Row {
    return { id: payment.id, reference: payment.reference, amount_cents: payment.amountCents, currency: payment.currency,
      provider: payment.provider, provider_payment_id: payment.providerPaymentId, status: payment.status,
      idempotency_key: payment.idempotencyKey ?? null, created_by: payment.createdBy, created_at: payment.createdAt,
      expires_at: payment.expiresAt, paid_at: payment.paidAt, cancelled_at: payment.cancelledAt, provider_data: JSON.stringify(payment.providerData) };
  }
  private fromRow(row: Row): Payment { return { id: row.id, reference: row.reference, amountCents: Number(row.amount_cents), currency: row.currency,
    provider: row.provider, providerPaymentId: row.provider_payment_id ?? null, status: row.status as PaymentStatus,
    idempotencyKey: row.idempotency_key ?? null, createdBy: row.created_by ?? null, createdAt: row.created_at,
    expiresAt: row.expires_at ?? null, paidAt: row.paid_at ?? null, cancelledAt: row.cancelled_at ?? null,
    providerData: typeof row.provider_data === 'string' ? JSON.parse(row.provider_data) : (row.provider_data ?? {}) }; }
  private eventFromRow(row: Row): PaymentEvent { return { id: row.id, paymentId: row.payment_id, eventType: row.event_type,
    previousStatus: row.previous_status as PaymentStatus, newStatus: row.new_status as PaymentStatus, provider: row.provider,
    providerEventId: row.provider_event_id, rawPayload: typeof row.raw_payload === 'string' ? JSON.parse(row.raw_payload) : row.raw_payload,
    createdAt: row.created_at }; }
}
