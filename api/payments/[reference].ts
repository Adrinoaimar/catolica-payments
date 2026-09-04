import {
  parseReference,
  assertPaymentVisibleToUser,
  paymentContext,
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
    const user = await requireUser(request, client);
    const raw = request.query?.reference;
    const reference = parseReference(Array.isArray(raw) ? raw[0] : raw);
    const candidate = await paymentRepository(client).findByReference(reference);
    if (candidate) assertPaymentVisibleToUser(candidate, user);
    const { service } = paymentContext(client);
    const payment = await service.findPaymentByReference(reference);
    if (!payment) throw new HttpError(404, 'Payment not found');
    assertPaymentVisibleToUser(payment, user);
    response.status(200).json(publicPayment(payment));
  } catch (error) { sendError(response, error); }
}
