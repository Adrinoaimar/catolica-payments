import { describe, expect, it } from 'vitest'
import { mergePayment, mergePaymentSnapshot } from '../src/lib/paymentMerge'
import type { Payment } from '../src/types'

const base: Payment = {
  id: 'p1', reference: 'CAT-20260902-AAAAAA', amountCents: 1000, currency: 'PEN', provider: 'taypi',
  providerPaymentId: 'tp-1', status: 'PENDING', method: 'DIGITAL', createdBy: 'Cajero', createdAt: '2026-09-02T12:00:00.000Z',
}

describe('monotonic payment snapshots', () => {
  it('does not regress any terminal state to PENDING', () => {
    for (const status of ['PAID', 'FAILED', 'EXPIRED', 'CANCELLED'] as const) {
      const terminal = { ...base, status }
      expect(mergePayment(terminal, { ...base, status }).status).toBe(status)
      expect(mergePayment(terminal, base).status).toBe(status)
    }
  })

  it('does not replace a terminal state with a different terminal response', () => {
    expect(mergePayment({ ...base, status: 'PAID' }, { ...base, status: 'CANCELLED' }).status).toBe('PAID')
    expect(mergePayment({ ...base, status: 'CANCELLED' }, { ...base, status: 'PAID' }).status).toBe('CANCELLED')
  })

  it('merges a pending snapshot into the newer terminal state', () => {
    expect(mergePayment(base, { ...base, status: 'PAID', paidAt: '2026-09-02T12:01:00.000Z' })).toMatchObject({ status: 'PAID', paidAt: '2026-09-02T12:01:00.000Z' })
  })

  it('applies guard across a list snapshot', () => {
    const current: Payment[] = [{ ...base, status: 'PAID' }, { ...base, id: 'p2', reference: 'CAT-20260902-AA2AAA', status: 'PENDING' }]
    const next: Payment[] = [{ ...base, status: 'PENDING' }, { ...base, id: 'p2', reference: 'CAT-20260902-AA2AAA', status: 'PAID' }]
    expect(mergePaymentSnapshot(current, next).map((payment) => payment.status)).toEqual(['PAID', 'PAID'])
  })
})
