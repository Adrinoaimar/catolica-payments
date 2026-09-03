import { PaymentService } from '../../src/server';
import {
  parseReference,
  paymentRepository,
  publicPayment,
  requireUser,
  sendError,
  serverClient,
  type ApiRequest,
  type ApiResponse,
  HttpError,
} from '../_shared';

export default async function handler(request: ApiRequest, response: ApiResponse): Promise<void> {
  if (request.method !== 'GET') { response.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const client = serverClient();
    await requireUser(request, client);
    const raw = request.query?.reference;
    const reference = parseReference(Array.isArray(raw) ? raw[0] : raw);
    const payment = await new PaymentService({ repository: paymentRepository(client) }).findPaymentByReference(reference);
    if (!payment) throw new HttpError(404, 'Payment not found');
    response.status(200).json(publicPayment(payment));
  } catch (error) { sendError(response, error); }
}
