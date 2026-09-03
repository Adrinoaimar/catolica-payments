import { timingSafeEqual } from 'node:crypto';
import {
  header,
  HttpError,
  paymentContext,
  publicPayment,
  serverClient,
  sendError,
  type ApiRequest,
  type ApiResponse,
} from '../_shared';

// Vercel Pro/Enterprise can run this bounded reconciliation pass for up to
// five minutes. Hobby deployments should use the Supabase Cron template.
export const config = { maxDuration: 300 };

/** Vercel invokes cron handlers with GET and Authorization: Bearer CRON_SECRET. */
export default async function handler(request: ApiRequest, response: ApiResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    response.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    assertCronSecret(request);
    const client = serverClient();
    const { data: lockToken, error: lockError } = await client.rpc('acquire_job_lock', {
      p_job_name: 'payments-reconcile',
      // A full bounded pass can contain seven batches of provider retries.
      // Keep the lease longer than that worst-case window so a second
      // scheduler cannot enter while the first invocation is still active.
      p_lease_seconds: 600,
    });
    if (lockError) throw new HttpError(503, 'Reconciliation lock is not configured');
    if (!lockToken) {
      response.status(202).json({ ok: true, skipped: 'already_running' });
      return;
    }
    try {
      const { service } = paymentContext(client);
      const result = await service.reconcilePendingPayments();
      // Expose partial failures to the scheduler/monitoring system so a later
      // invocation retries rows that could not be reconciled.
      response.status(result.errors > 0 ? 503 : 200).json({
        ok: true,
        inspected: result.inspected,
        reconciled: result.reconciled,
        skipped: result.skipped,
        errors: result.errors,
        payments: result.payments.map(publicPayment),
      });
    } finally {
      await client.rpc('release_job_lock', {
        p_job_name: 'payments-reconcile',
        p_lock_token: lockToken as string,
      });
    }
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
