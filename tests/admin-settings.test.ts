import { describe, expect, it } from 'vitest'
import { parseQuickAmounts } from '../api/admin/quick-amounts'
import { parseRole } from '../api/admin/users'

describe('administrative configuration boundaries', () => {
  it('accepts bounded unique quick amounts in cents', () => {
    expect(parseQuickAmounts([1000, { amountCents: 1550 }, { amount_cents: '3000' }])).toEqual([1000, 1550, 3000])
    expect(() => parseQuickAmounts([])).toThrow('between 1 and 12')
    expect(() => parseQuickAmounts([1000, 1000])).toThrow('unique')
    expect(() => parseQuickAmounts([1_000_001])).toThrow('up to 1000000')
    expect(() => parseQuickAmounts([{ amountCents: '10.5' }])).toThrow('positive integer')
  })

  it('normalizes only supported managed roles', () => {
    expect(parseRole(' cashier ')).toBe('CASHIER')
    expect(parseRole('ADMIN')).toBe('ADMIN')
    expect(() => parseRole('viewer')).toThrow('ADMIN or CASHIER')
  })
})
