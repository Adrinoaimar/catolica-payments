import { PaymentOperationError } from '../../../src/server';
import {
  HttpError,
  parseBody,
  parseReference,
  paymentContext,
  publicPayment,
  requireAdmin,
  sendError,
  serverClient,
  type ApiRequest,
  type ApiResponse,
} from '../../_shared';

export const config = { api: { bodyParser: { sizeLimit: '64kb' } } };

/**
 * Administrative cancellation. Provider cancellation is requested server-side
 * before the atomic ledger transition. The client cannot submit a status.
 */
export default async function handler(request: ApiRequest, response: ApiResponse): Promise<void> {
  if (request.method !== 'POST') { response.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const client = serverClient();
    const user = await requireAdmin(request, client);
    const raw = request.query?.reference;
    const reference = parseReference(Array.isArray(raw) ? raw[0] : raw);
    const body = request.body === undefined || request.body === null || request.body === '' ? {} : parseBody(request.body);
    const reason = parseReason(body.reason);
    const { service } = paymentContext(client);
    const result = await service.cancelPaymentByReference({ reference, actorId: user.id, ...(reason ? { reason } : {}) });
    response.status(200).json({ payment: publicPayment(result.payment), changed: result.changed });
  } catch (error) {
    if (error instanceof PaymentOperationError) {
      response.status(error.statusCode).json({ error: error.message });
      return;
    }
    sendError(response, error);
  }
}

function parseReason(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'reason must be a string');
  const reason = value.trim();
  if (reason.length > 500) throw new HttpError(400, 'reason must be at most 500 characters');
  return reason || undefined;
}
