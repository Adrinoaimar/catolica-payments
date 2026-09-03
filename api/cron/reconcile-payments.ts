import { timingSafeEqual } from 'node:crypto';
import {
  header,
  HttpError,
  paymentContext,
  publicPayment,
  sendError,
  type ApiRequest,
  type ApiResponse,
} from '../_shared';

/** Vercel invokes cron handlers with GET and Authorization: Bearer CRON_SECRET. */
export default async function handler(request: ApiRequest, response: ApiResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    response.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    assertCronSecret(request);
    const { service } = paymentContext();
    const result = await service.reconcilePendingPayments();
    response.status(200).json({
      ok: true,
      inspected: result.inspected,
      reconciled: result.reconciled,
      skipped: result.skipped,
      errors: result.errors,
      payments: result.payments.map(publicPayment),
    });
  } catch (error) {
    sendError(response, error);
  }
}

/**
 * Keep this check independent from Supabase auth: Vercel cron has no user
 * session, and the secret is the only credential allowed for this job.
 */
export function assertCronSecret(request: ApiRequest): void {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) throw new HttpError(503, 'CRON_SECRET is not configured');

  const authorization = header(request.headers, 'authorization');
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const supplied = bearer ?? header(request.headers, 'x-cron-secret')?.trim();
  if (!supplied || supplied.length > 4096) throw new HttpError(401, 'Authentication required');

  const expectedBytes = Buffer.from(expected, 'utf8');
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
    throw new HttpError(401, 'Invalid cron secret');
  }
}
