import type { RealtimeChannel } from '@supabase/supabase-js'
import type { Payment } from '../types'
import { apiFetch, isDemoMode, supabase } from './supabase'

/**
 * Identifiers emitted by the payments Realtime stream.
 *
 * The browser deliberately does not use the row payload as a payment object.
 * A change only invalidates the local snapshot; App refreshes the affected
 * record through the authenticated API, which applies the public response
 * boundary and never exposes provider metadata to UI state.
 */
export type PaymentChangeEvent = 'INSERT' | 'UPDATE' | 'DELETE'

export interface PaymentChange {
  event: PaymentChangeEvent
  id: string | null
  reference: string | null
}

export interface SubscribeToPaymentsOptions {
  userId: string
  onChange: (change: PaymentChange) => void
  onStatus?: (status: 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED', error?: Error) => void
}

type RealtimeRow = Record<string, unknown>
type RealtimePayload = {
  eventType?: string
  new?: RealtimeRow
  old?: RealtimeRow
}

/**
 * Subscribe to authenticated payment changes.
 *
 * Supabase applies `payment_updates` RLS to this channel. That projection
 * contains only payment ID/reference, so provider secrets never cross the
 * Realtime stream. No service-role key or provider credentials are read by
 * this module. Demo mode has no channel; its local event/storage path remains
 * isolated from production.
 */
export function subscribeToPayments({ userId, onChange, onStatus }: SubscribeToPaymentsOptions): () => void {
  if (isDemoMode || !supabase || !userId) return () => undefined

  const channelName = `payments:${userId}`
  let disposed = false
  let channel: RealtimeChannel | null = null
  let reconnectTimer: number | null = null
  let reconnectAttempt = 0

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== null) return
    const delay = Math.min(30_000, 1_000 * (2 ** Math.min(reconnectAttempt, 5)))
    reconnectAttempt += 1
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      if (disposed) return
      if (channel) {
        const previous = channel
        channel = null
        void supabase?.removeChannel(previous)
      }
      connect()
    }, delay)
  }

  function connect() {
    if (disposed || !supabase) return
    const nextChannel = supabase.channel(channelName)
    // Assign before subscribe: some adapters can synchronously report an
    // initial state, and that state must not be discarded as stale.
    channel = nextChannel
    nextChannel.on('postgres_changes', { event: '*', schema: 'public', table: 'payment_updates' }, (payload: RealtimePayload) => {
        const event = normalizeEvent(payload.eventType)
        if (!event || disposed || channel !== nextChannel) return
        const row = event === 'DELETE' ? payload.old : payload.new
        if (!row || typeof row !== 'object') return
        const id = stringValue(row.id)
        const reference = stringValue(row.reference)
        // Do not forward row data. provider_data can contain provider-only
        // response fields; App re-reads a sanitized public payment by reference.
        // DELETE only needs the primary key, so it remains actionable even if
        // a deployment uses the default replica identity.
        if (event === 'DELETE' && !id) return
        onChange({ event, id, reference })
      })
      .subscribe((status, reason) => {
        if (disposed || channel !== nextChannel) return
        if (status === 'SUBSCRIBED') {
          reconnectAttempt = 0
          onStatus?.(status)
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          const error = reason instanceof Error ? reason : reason ? new Error(String(reason)) : undefined
          onStatus?.(status, error)
          scheduleReconnect()
        }
      })
  }

  connect()

  return () => {
    disposed = true
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    reconnectTimer = null
    // removeChannel also calls unsubscribe and clears the Realtime binding.
    if (channel) void supabase?.removeChannel(channel)
    channel = null
  }
}

/**
 * Re-read one changed payment through the authenticated API. Realtime rows
 * are intentionally not trusted as UI data because they include internal DB
 * columns that the public API strips (for example provider_data).
 */
export async function fetchPublicPayment(reference: string): Promise<Payment> {
  if (!reference) throw new Error('Missing payment reference')
  const response = await apiFetch(`/api/payments/${encodeURIComponent(reference)}`)
  const body = await response.json().catch(() => ({})) as unknown
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body ? String((body as { error?: unknown }).error) : `No se pudo cargar la operación (${response.status}).`
    throw new Error(message)
  }
  return normalizePublicPayment(body)
}

function normalizeEvent(value: unknown): PaymentChangeEvent | null {
  if (value === 'INSERT' || value === 'UPDATE' || value === 'DELETE') return value
  return null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizePublicPayment(value: unknown): Payment {
  if (!value || typeof value !== 'object') throw new Error('El servidor devolvió una operación inválida.')
  const raw = value as Record<string, unknown>
  const provider = String(raw.provider ?? '').toLowerCase()
  const validProviders = ['mock', 'cash', 'taypi', 'culqi', 'mercadopago']
  const status = String(raw.status ?? '').toUpperCase()
  const validStatuses = ['PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED']
  const amountCents = raw.amountCents
  if (!validProviders.includes(provider) || !validStatuses.includes(status)
    || typeof raw.id !== 'string' || typeof raw.reference !== 'string'
    || typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents <= 0
    || typeof raw.createdAt !== 'string') {
    throw new Error('El servidor devolvió una operación inválida.')
  }
  const method = raw.method === 'CASH' || provider === 'cash' ? 'CASH' : 'DIGITAL'
  return {
    id: raw.id,
    reference: raw.reference,
    amountCents,
    currency: 'PEN',
    provider: provider as Payment['provider'],
    providerPaymentId: typeof raw.providerPaymentId === 'string' ? raw.providerPaymentId : undefined,
    status: status as Payment['status'],
    method,
    createdBy: typeof raw.createdBy === 'string' && raw.createdBy ? raw.createdBy : 'Usuario',
    createdAt: raw.createdAt,
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : undefined,
    paidAt: typeof raw.paidAt === 'string' ? raw.paidAt : undefined,
    qrCode: typeof raw.qrCode === 'string' ? raw.qrCode : undefined,
    checkoutUrl: typeof raw.checkoutUrl === 'string' ? raw.checkoutUrl : undefined,
    checkoutToken: typeof raw.checkoutToken === 'string' ? raw.checkoutToken : undefined,
  }
}
