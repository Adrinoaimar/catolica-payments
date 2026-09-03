import type { Payment, PaymentMethod, SessionUser } from '../types'
import { apiFetch, isDemoMode } from './supabase'

const STORAGE_KEY = 'catolica-payments-demo-v1'
const SESSION_KEY = 'catolica-payments-session-v1'
const DEFAULT_USER: SessionUser = {
  id: 'cashier-demo',
  name: 'María González',
  email: 'maria.gonzalez@grupolacatolica.edu.pe',
  role: 'CASHIER',
  initials: 'MG',
}

function dayAt(hours: number, minutes: number) {
  const date = new Date()
  date.setHours(hours, minutes, 0, 0)
  return date.toISOString()
}

const seedPayments: Payment[] = [
  { id: 'seed-1', reference: 'CAT-20260902-7FA2C1', amountCents: 3000, currency: 'PEN', provider: 'mock', providerPaymentId: 'mock_9a12', status: 'PAID', method: 'DIGITAL', createdBy: 'María González', createdAt: dayAt(16, 45), paidAt: dayAt(16, 46) },
  { id: 'seed-2', reference: 'CAT-20260902-1C82DD', amountCents: 2000, currency: 'PEN', provider: 'cash', providerPaymentId: 'cash_8ab3', status: 'PAID', method: 'CASH', createdBy: 'María González', createdAt: dayAt(16, 42), paidAt: dayAt(16, 42) },
  { id: 'seed-3', reference: 'CAT-20260902-9B11E0', amountCents: 5000, currency: 'PEN', provider: 'mock', status: 'PENDING', method: 'DIGITAL', createdBy: 'Carlos Rojas', createdAt: dayAt(16, 40), expiresAt: new Date(Date.now() + 9 * 60_000).toISOString() },
  { id: 'seed-4', reference: 'CAT-20260902-A0D29F', amountCents: 1500, currency: 'PEN', provider: 'mock', providerPaymentId: 'mock_07cd', status: 'PAID', method: 'DIGITAL', createdBy: 'María González', createdAt: dayAt(15, 58), paidAt: dayAt(15, 59) },
  { id: 'seed-5', reference: 'CAT-20260902-2E13AB', amountCents: 1000, currency: 'PEN', provider: 'cash', providerPaymentId: 'cash_22aa', status: 'PAID', method: 'CASH', createdBy: 'Luis Vega', createdAt: dayAt(15, 44), paidAt: dayAt(15, 44) },
]

export function loadPayments(): Payment[] {
  if (!isDemoMode) return []
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) return JSON.parse(saved) as Payment[]
  } catch { /* local storage unavailable: use demo data */ }
  return seedPayments
}

export function savePayments(payments: Payment[]) {
  if (!isDemoMode) return
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payments)) } catch { /* demo keeps in memory */ }
  window.dispatchEvent(new CustomEvent('catolica:payments-updated'))
}

export function loadSession(): SessionUser | null {
  if (!isDemoMode) return null
  try {
    const saved = localStorage.getItem(SESSION_KEY)
    return saved ? JSON.parse(saved) as SessionUser : null
  } catch { return null }
}

export function saveSession(user: SessionUser) {
  if (!isDemoMode) return
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(user)) } catch { /* no-op */ }
}

export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY) } catch { /* no-op */ }
}

export function makeReference() {
  const date = new Date()
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  const entropy = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `CAT-${stamp}-${entropy}`
}

/** Load the authenticated ledger. Local storage is intentionally used only by
 * the explicit offline demo mode; production always reads the API. */
export async function listPayments(): Promise<Payment[]> {
  if (isDemoMode) return loadPayments()
  const response = await apiFetch('/api/payments?limit=200')
  const body = await response.json().catch(() => ({})) as { payments?: unknown }
  if (!response.ok) throw new Error(typeof body === 'object' && body && 'error' in body ? String(body.error) : `No se pudieron cargar las operaciones (${response.status}).`)
  if (!Array.isArray(body.payments)) throw new Error('El servidor devolvió un listado inválido.')
  return body.payments.map(normalizePayment)
}

export async function createPaymentRequest(amountCents: number, method: PaymentMethod, user: SessionUser): Promise<Payment> {
  const now = new Date().toISOString()
  const payment: Payment = {
    id: crypto.randomUUID?.() ?? `local-${Date.now()}`,
    reference: makeReference(),
    amountCents,
    currency: 'PEN',
    provider: method === 'CASH' ? 'cash' : 'mock',
    status: method === 'CASH' ? 'PAID' : 'PENDING',
    method,
    createdBy: user.name,
    createdAt: now,
    paidAt: method === 'CASH' ? now : undefined,
    expiresAt: method === 'DIGITAL' ? new Date(Date.now() + 15 * 60_000).toISOString() : undefined,
  }
  // Backend remains source of truth. Local fallback exists only in explicit demo mode.
  try {
    const response = await apiFetch(method === 'CASH' ? '/api/payments/cash' : '/api/payments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amountCents, method }) })
    if (response.ok) {
      const remote = await response.json() as Partial<Payment> & { payment?: Partial<Payment> }
      const remotePayment = remote.payment ?? remote
      if (!remotePayment.id || !remotePayment.reference) throw new Error('El servidor devolvió un cobro inválido.')
      const providerPayment = 'providerPayment' in remote && remote.providerPayment && typeof remote.providerPayment === 'object'
        ? remote.providerPayment as Partial<Payment>
        : {}
      return normalizePayment({
        ...payment,
        ...remotePayment,
        ...providerPayment,
        provider: String(remotePayment.provider ?? payment.provider).toLowerCase() as Payment['provider'],
        method,
      })
    }
    const body = await response.json().catch(() => ({})) as { error?: string }
    if (!isDemoMode) throw new Error(body.error || `No se pudo crear el cobro (${response.status}).`)
  } catch (reason) {
    if (!isDemoMode) throw reason
    // Demo mode can intentionally run without API/Supabase.
  }
  if (!isDemoMode) throw new Error('No se pudo crear el cobro.')
  const payments = loadPayments()
  savePayments([payment, ...payments])
  return payment
}

function normalizePayment(value: unknown): Payment {
  if (!value || typeof value !== 'object') throw new Error('El servidor devolvió una operación inválida.')
  const raw = value as Partial<Payment> & Record<string, unknown>
  const provider = String(raw.provider ?? '').toLowerCase() as Payment['provider']
  const method = raw.method === 'CASH' || provider === 'cash' ? 'CASH' : 'DIGITAL'
  if (typeof raw.id !== 'string' || typeof raw.reference !== 'string' || typeof raw.amountCents !== 'number') {
    throw new Error('El servidor devolvió una operación inválida.')
  }
  return { ...raw, provider, method, createdBy: String(raw.createdBy ?? 'Usuario') } as Payment
}

export async function simulateMockPayment(payment: Payment): Promise<Payment> {
  if (!isDemoMode) throw new Error('El simulador está deshabilitado fuera del modo demo.')
  // Deliberately call webhook endpoint. Never mark paid from the simulator UI itself.
  try {
    const response = await apiFetch('/api/webhooks/mock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_id: `mock_evt_${crypto.randomUUID?.() ?? Date.now()}`, event_type: 'payment.paid', reference: payment.reference, amount_cents: payment.amountCents, provider_payment_id: payment.providerPaymentId ?? `mock_${payment.reference.slice(-6).toLowerCase()}`, currency: payment.currency, status: 'PAID' }) })
    if (response.ok) {
      const remote = await response.json() as Partial<Payment>
      const updated = { ...payment, ...remote, status: 'PAID' as const, paidAt: remote.paidAt ?? new Date().toISOString() }
      savePayments(loadPayments().map((item) => item.id === payment.id || item.reference === payment.reference ? updated : item))
      return updated
    }
  } catch { /* local event replay below */ }
  const updated = { ...payment, status: 'PAID' as const, providerPaymentId: `mock_${payment.reference.slice(-6).toLowerCase()}`, paidAt: new Date().toISOString() }
  savePayments(loadPayments().map((item) => item.id === payment.id || item.reference === payment.reference ? updated : item))
  return updated
}
