/** Parse a user-entered PEN amount without ever using a floating point value. */
export function solesToCents(value: string | number): number {
  const text = String(value).trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new Error('Invalid amount');
  }
  const [soles, decimals = ''] = text.split('.');
  const cents = Number(`${soles}${decimals.padEnd(2, '0')}`);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error('Amount must be greater than zero');
  }
  return cents;
}

export function centsToSoles(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('Invalid cents');
  return `S/ ${(cents / 100).toFixed(2)}`;
}
