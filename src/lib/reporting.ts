import type { Payment, PaymentMethod, PaymentStatus } from '../types'
import { apiFetch, isDemoMode } from './firebase'

export type ReportPeriod = 'ALL' | 'DAY' | 'WEEK' | 'MONTH' | 'CUSTOM'

export interface PaymentReportFilters {
  period?: ReportPeriod
  from?: string
  to?: string
  status?: PaymentStatus
  method?: PaymentMethod
  createdBy?: string
  minAmountCents?: number
  maxAmountCents?: number
  limit?: number
}

/** Return the institution's America/Lima calendar range. */
export function periodRange(period: ReportPeriod, now = new Date()): { from?: string; to?: string } {
  if (period === 'ALL') return {}
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  // Represent a Lima midnight as 05:00 UTC so range calculations do not use
  // the cashier device's timezone.
  const start = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), 5, 0, 0, 0))
  const end = new Date(start)
  if (period === 'DAY') {
    end.setTime(start.getTime() + 24 * 60 * 60_000 - 1)
  } else if (period === 'WEEK') {
    const day = start.getUTCDay()
    const mondayOffset = day === 0 ? -6 : 1 - day
    start.setUTCDate(start.getUTCDate() + mondayOffset)
    end.setTime(start.getTime() + 7 * 24 * 60 * 60_000 - 1)
  } else if (period === 'MONTH') {
    start.setUTCDate(1)
    end.setUTCMonth(start.getUTCMonth() + 1, 1)
    end.setTime(end.getTime() - 1)
  } else {
    return {}
  }
  return { from: start.toISOString(), to: end.toISOString() }
}

/** Fetches the server-filtered public ledger. Demo mode filters the local fixture. */
export async function fetchReportPayments(filters: PaymentReportFilters, fallback: Payment[]): Promise<Payment[]> {
  if (isDemoMode) return filterLocalPayments(fallback, filters)
  const pageSize = Math.min(filters.limit ?? 200, 200)
  const all: Payment[] = []
  const maxPages = 25
  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams()
    const range = filters.period && filters.period !== 'CUSTOM' ? periodRange(filters.period) : { from: filters.from, to: filters.to }
    if (range.from) params.set('from', range.from)
    if (range.to) params.set('to', range.to)
    if (filters.status) params.set('status', filters.status)
    if (filters.method) params.set('method', filters.method)
    if (filters.createdBy) params.set('createdBy', filters.createdBy)
    if (filters.minAmountCents !== undefined) params.set('minAmountCents', String(filters.minAmountCents))
    if (filters.maxAmountCents !== undefined) params.set('maxAmountCents', String(filters.maxAmountCents))
    params.set('limit', String(pageSize))
    params.set('offset', String(page * pageSize))
    const response = await apiFetch(`/api/payments?${params.toString()}`)
    const body = await response.json().catch(() => ({})) as { payments?: unknown; hasMore?: unknown; error?: unknown }
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `No se pudieron cargar las operaciones (${response.status}).`)
    if (!Array.isArray(body.payments)) throw new Error('El servidor devolvió un listado inválido.')
    const next = body.payments.map(normalizePublicPayment)
    all.push(...next)
    if (body.hasMore !== true || next.length === 0) break
    if (page === maxPages - 1) throw new Error('El reporte supera el límite operativo de 5,000 operaciones. Ajusta el periodo o los filtros.')
  }
  return all
}

function filterLocalPayments(payments: Payment[], filters: PaymentReportFilters): Payment[] {
  const range = filters.period && filters.period !== 'CUSTOM' ? periodRange(filters.period) : { from: filters.from, to: filters.to }
  const from = range.from ? Date.parse(range.from) : Number.NEGATIVE_INFINITY
  const to = range.to ? Date.parse(range.to) : Number.POSITIVE_INFINITY
  return payments.filter((payment) => {
    const created = Date.parse(payment.createdAt)
    return (!filters.status || payment.status === filters.status)
      && (!filters.method || payment.method === filters.method)
      && (!filters.createdBy || payment.createdBy === filters.createdBy)
      && (!filters.minAmountCents || payment.amountCents >= filters.minAmountCents)
      && (filters.maxAmountCents === undefined || payment.amountCents <= filters.maxAmountCents)
      && created >= from && created <= to
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, filters.limit ?? 200)
}

function normalizePublicPayment(value: unknown): Payment {
  if (!value || typeof value !== 'object') throw new Error('El servidor devolvió una operación inválida.')
  const raw = value as Record<string, unknown>
  const provider = String(raw.provider ?? '').toLowerCase() as Payment['provider']
  const method = raw.method === 'CASH' || provider === 'cash' ? 'CASH' : 'DIGITAL'
  if (typeof raw.id !== 'string' || typeof raw.reference !== 'string' || typeof raw.amountCents !== 'number') {
    throw new Error('El servidor devolvió una operación inválida.')
  }
  return {
    id: raw.id,
    reference: raw.reference,
    amountCents: raw.amountCents,
    currency: raw.currency === 'PEN' ? 'PEN' : 'PEN',
    provider,
    providerPaymentId: typeof raw.providerPaymentId === 'string' ? raw.providerPaymentId : undefined,
    status: raw.status as PaymentStatus,
    method,
    createdBy: String(raw.createdBy ?? 'Usuario'),
    createdAt: String(raw.createdAt),
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : undefined,
    paidAt: typeof raw.paidAt === 'string' ? raw.paidAt : undefined,
    qrCode: typeof raw.qrCode === 'string' ? raw.qrCode : undefined,
    checkoutUrl: typeof raw.checkoutUrl === 'string' ? raw.checkoutUrl : undefined,
    checkoutToken: typeof raw.checkoutToken === 'string' ? raw.checkoutToken : undefined,
  }
}

const csvColumns: Array<{ key: string; label: string; value: (payment: Payment) => string }> = [
  { key: 'reference', label: 'Referencia', value: (payment) => payment.reference },
  { key: 'createdAt', label: 'Fecha', value: (payment) => payment.createdAt },
  { key: 'status', label: 'Estado', value: (payment) => payment.status },
  { key: 'method', label: 'Método', value: (payment) => payment.method },
  { key: 'amount', label: 'Monto (S/)', value: (payment) => (payment.amountCents / 100).toFixed(2) },
  { key: 'currency', label: 'Moneda', value: (payment) => payment.currency },
  { key: 'createdBy', label: 'Cajero', value: (payment) => payment.createdBy },
]

/** CSV contains only public report fields: no provider IDs, tokens, QR, or raw metadata. */
export function paymentsToCsv(payments: Payment[]): string {
  // Prefix formula-leading values so spreadsheet programs treat user data as
  // text rather than executing it when the CSV is opened.
  const escape = (value: string) => {
    const safe = /^[=+\-@]/.test(value) ? `'${value}` : value
    return `"${safe.replace(/"/g, '""')}"`
  }
  return `\ufeff${csvColumns.map((column) => escape(column.label)).join(',')}\r\n${payments.map((payment) => csvColumns.map((column) => escape(column.value(payment))).join(',')).join('\r\n')}${payments.length ? '\r\n' : ''}`
}

export function downloadPaymentsCsv(payments: Payment[], filename = `catolica-reporte-${new Date().toISOString().slice(0, 10)}.csv`): void {
  const blob = new Blob([paymentsToCsv(payments)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
