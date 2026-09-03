import { PaymentService } from '../../../src/server';
import {
  parseReference,
  paymentContext,
  publicPayment,
  requireUser,
  sendError,
  serverClient,
  type ApiRequest,
  type ApiResponse,
} from '../../_shared';

/**
 * Authenticated, bounded fallback when a provider webhook is delayed. It
 * polls exactly one operation server-side and uses the same validated atomic
 * transition as the webhook/cron paths. The browser never supplies a status.
 */
export default async function handler(request: ApiRequest, response: ApiResponse): Promise<void> {
  if (request.method !== 'POST') { response.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const client = serverClient();
    await requireUser(request, client);
    const reference = parseReference(request.query?.reference instanceof Array ? request.query.reference[0] : request.query?.reference);
    const { service } = paymentContext(client);
    const result = await service.reconcilePaymentByReference(reference);
    response.status(200).json({ payment: publicPayment(result.payment), changed: result.changed });
  } catch (error) { sendError(response, error); }
}
