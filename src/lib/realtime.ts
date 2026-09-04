import type { Payment } from '../types'
import { apiFetch, isDemoMode } from './firebase'

/** Polling-compatible change events. Kept stable so App does not depend on a realtime vendor. */
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
  /** Polling cadence. Defaults to five seconds for pending payment UX. */
  intervalMs?: number
}

/**
 * Poll the authenticated ledger and emit only changes between snapshots.
 *
 * This replaces provider-specific WebSocket realtime. The API response is
 * already sanitized; each change is still re-read through the public payment
 * endpoint before UI state uses it. Backend/webhook remains payment authority.
 */
export function subscribeToPayments({ userId, onChange, onStatus, intervalMs = 5_000 }: SubscribeToPaymentsOptions): () => void {
  if (isDemoMode || !userId) return () => undefined

  let disposed = false
  let polling = false
  let initialized = false
  let previous = new Map<string, Payment>()

  const poll = async () => {
    if (disposed || polling) return
    polling = true
    try {
      const next = await fetchPaymentsSnapshot()
      if (disposed) return
      const current = new Map(next.map((payment) => [payment.id, payment]))
      if (initialized) {
        for (const payment of next) {
          const old = previous.get(payment.id)
          if (!old) {
            onChange({ event: 'INSERT', id: payment.id, reference: payment.reference })
          } else if (old.status !== payment.status || old.paidAt !== payment.paidAt || old.expiresAt !== payment.expiresAt) {
            onChange({ event: 'UPDATE', id: payment.id, reference: payment.reference })
          }
        }
        for (const payment of previous.values()) {
          if (!current.has(payment.id)) onChange({ event: 'DELETE', id: payment.id, reference: payment.reference })
        }
      }
      previous = current
      initialized = true
      onStatus?.('SUBSCRIBED')
    } catch (reason) {
      if (!disposed) onStatus?.('CHANNEL_ERROR', toError(reason, 'No se pudo sincronizar el ledger.'))
    } finally {
      polling = false
    }
  }

  void poll()
  const timer = window.setInterval(() => { void poll() }, Math.max(2_000, intervalMs))

  return () => {
    disposed = true
    window.clearInterval(timer)
    onStatus?.('CLOSED')
  }
}

/** Re-read one changed payment through the authenticated API. */
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

async function fetchPaymentsSnapshot(): Promise<Payment[]> {
  const response = await apiFetch('/api/payments?limit=200&offset=0')
  const body = await response.json().catch(() => ({})) as { payments?: unknown; error?: unknown }
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `No se pudieron cargar las operaciones (${response.status}).`)
  if (!Array.isArray(body.payments)) throw new Error('El servidor devolvió un listado inválido.')
  return body.payments.map(normalizePublicPayment)
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

function toError(reason: unknown, fallback: string): Error {
  return reason instanceof Error && reason.message ? reason : new Error(fallback)
}
