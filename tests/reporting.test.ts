import { describe, expect, it } from 'vitest'
import { parseFilters } from '../api/payments'
import { InMemoryPaymentRepository } from '../src/server'
import { paymentsToCsv, periodRange } from '../src/lib/reporting'
import type { Payment as ClientPayment } from '../src/types'
import type { Payment as ServerPayment } from '../src/server/payments/types'

describe('payment report filters', () => {
  it('parses date, status, method, cashier and amount filters', () => {
    expect(parseFilters({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z',
      status: 'PAID',
      method: 'DIGITAL',
      createdBy: 'cashier-1',
      minAmountCents: '1000',
      maxAmountCents: '5000',
      limit: '50',
    }, 'ADMIN')).toEqual({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z',
      status: 'PAID',
      method: 'DIGITAL',
      createdBy: 'cashier-1',
      minAmountCents: 1000,
      maxAmountCents: 5000,
      limit: 50,
    })
  })

  it('rejects malformed or inverted amount filters', () => {
    expect(() => parseFilters({ minAmountCents: '-1' }, 'ADMIN')).toThrow('non-negative integer')
    expect(() => parseFilters({ minAmountCents: '5001', maxAmountCents: '5000' }, 'ADMIN')).toThrow('Invalid amount range')
    expect(() => parseFilters({ createdBy: 'other-user' }, 'CASHIER')).toThrow('Only administrators')
  })

  it('applies amount bounds in repository adapters', async () => {
    const repository = new InMemoryPaymentRepository()
    const makePayment = (id: string, amountCents: number): ServerPayment => ({
      id,
      reference: `CAT-20260902-${id.padEnd(6, 'A').slice(0, 6)}`,
      amountCents,
      currency: 'PEN',
      provider: 'taypi',
      providerPaymentId: `provider-${id}`,
      status: 'PAID',
      createdBy: 'cashier-1',
      createdAt: '2026-09-02T12:00:00.000Z',
      expiresAt: null,
      paidAt: '2026-09-02T12:01:00.000Z',
      cancelledAt: null,
      providerData: {},
    })
    await repository.insert(makePayment('one', 1000))
    await repository.insert(makePayment('two', 3000))
    await repository.insert(makePayment('three', 6000))
    const filtered = await repository.list({ minAmountCents: 2000, maxAmountCents: 5000 })
    expect(filtered.map((payment) => payment.amountCents)).toEqual([3000])
  })
})

describe('report export', () => {
  it('builds CSV using only public, non-sensitive fields', () => {
    const payment: ClientPayment = {
      id: 'p1',
      reference: 'CAT-20260902-AAAAAA',
      amountCents: 3050,
      currency: 'PEN',
      provider: 'taypi',
      providerPaymentId: 'provider-secret-id',
      status: 'PAID',
      method: 'DIGITAL',
      createdBy: 'María, González',
      createdAt: '2026-09-02T12:00:00.000Z',
      qrCode: 'qr-secret',
      checkoutToken: 'token-secret',
    }
    const csv = paymentsToCsv([payment])
    expect(csv).toContain('"Referencia"')
    expect(csv).toContain('"CAT-20260902-AAAAAA"')
    expect(csv).toContain('"María, González"')
    expect(csv).not.toContain('provider-secret-id')
    expect(csv).not.toContain('qr-secret')
    expect(csv).not.toContain('token-secret')
  })

  it('neutralizes spreadsheet formulas in exported text', () => {
    const payment: ClientPayment = {
      id: 'p-formula', reference: '=1+1', amountCents: 1000, currency: 'PEN',
      provider: 'taypi', status: 'PAID', method: 'DIGITAL', createdBy: '@attacker',
      createdAt: '2026-09-02T12:00:00.000Z',
    }
    const csv = paymentsToCsv([payment])
    expect(csv).toContain("'=1+1")
    expect(csv).toContain("'@attacker")
  })

  it('uses Monday-to-Sunday local calendar weeks', () => {
    const range = periodRange('WEEK', new Date('2026-09-02T12:00:00.000Z'))
    const from = new Date(range.from!)
    const to = new Date(range.to!)
    expect(from.getUTCDay()).toBe(1)
    expect(from.getUTCHours()).toBe(5)
    // Sunday 23:59:59.999 in Lima is Monday 04:59:59.999 UTC.
    expect(to.getUTCDay()).toBe(1)
    expect(to.getUTCHours()).toBe(4)
  })
})
