import { describe, expect, it } from 'vitest';
import { parseBody, parseRequestAmount, publicPayment } from '../api/_shared';

describe('server API input and response boundaries', () => {
  it('accepts integer cents or decimal soles, rejects ambiguous amounts', () => {
    expect(parseRequestAmount({ amountCents: 3_050 })).toBe(3_050);
    expect(parseRequestAmount({ amount_cents: '3050' })).toBe(3_050);
    expect(parseRequestAmount({ amount: '30.50' })).toBe(3_050);
    expect(() => parseRequestAmount({ amount_cents: '30.5' })).toThrow('positive integer');
    expect(() => parseRequestAmount({ amount: '' })).toThrow('up to two decimals');
  });

  it('returns a 400-domain error for malformed JSON', () => {
    expect(() => parseBody('{')).toThrow('Invalid JSON body');
    expect(() => parseBody([])).toThrow('JSON object body required');
  });

  it('does not expose provider metadata wholesale', () => {
    const value = publicPayment({
      id: 'p1', reference: 'CAT-20260902-AAAAAA', amountCents: 1000, currency: 'PEN', provider: 'taypi',
      providerPaymentId: 'provider-1', status: 'PENDING', createdBy: 'u1', createdAt: '2026-09-02T12:00:00Z',
      expiresAt: '2026-09-02T12:15:00Z', paidAt: null, cancelledAt: null,
      providerData: { qr_image: 'abc123', secret_token: 'must-not-leak' },
    });
    expect(value).toMatchObject({ method: 'DIGITAL', qrCode: 'data:image/svg+xml;base64,abc123' });
    expect(value).not.toHaveProperty('secret_token');
    expect(value).not.toHaveProperty('providerData');
  });
});
