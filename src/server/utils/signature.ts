import { createHmac, timingSafeEqual } from 'node:crypto';

export function hmacSha256Hex(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

export function verifyHmacSha256(secret: string, body: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const normalized = signature.replace(/^sha256=/i, '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) return false;
  const expected = hmacSha256Hex(secret, body);
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(normalized, 'hex'));
}

export function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase()) ?? ''];
  return Array.isArray(value) ? value[0] : value;
}
