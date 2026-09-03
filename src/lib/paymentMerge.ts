import type { Payment } from '../types'

const TERMINAL_STATUSES = new Set<Payment['status']>(['PAID', 'FAILED', 'EXPIRED', 'CANCELLED'])

/**
 * Merge server snapshots without allowing a terminal ledger state to regress.
 * Terminal states are immutable in the backend; this guard covers delayed
 * Realtime/API responses that arrive out of order in the browser.
 */
export function mergePayment(previous: Payment | undefined, next: Payment): Payment {
  if (!previous) return next
  if (isTerminalStatus(previous.status) && previous.status !== next.status) return previous
  return { ...previous, ...next, createdBy: previous.createdBy || next.createdBy }
}

export function mergePaymentSnapshot(previous: Payment[], next: Payment[]): Payment[] {
  return next.map((payment) => {
    const current = previous.find((item) => item.id === payment.id || item.reference === payment.reference)
    return mergePayment(current, payment)
  })
}

export function isTerminalStatus(status: Payment['status']): boolean {
  return TERMINAL_STATUSES.has(status)
}
