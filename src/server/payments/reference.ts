import { createHash } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomPart(length = 6, random: () => number = Math.random): string {
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  return result;
}

/** Human-readable, unique-at-database reference. Database UNIQUE is final guard. */
export function generateReference(
  date = new Date(),
  random: () => number = Math.random,
): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `CAT-${year}${month}${day}-${randomPart(6, random)}`;
}

/** Same-day deterministic reference used with a client idempotency key. */
export function generateIdempotentReference(date: Date, key: string): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const bytes = createHash('sha256').update(key, 'utf8').digest();
  let part = '';
  for (let index = 0; index < 6; index += 1) part += ALPHABET[bytes[index] % ALPHABET.length];
  return `CAT-${year}${month}${day}-${part}`;
}

export function isPaymentReference(reference: string): boolean {
  return /^CAT-\d{8}-[A-Z2-9]{6}$/.test(reference);
}
