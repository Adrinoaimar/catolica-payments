import {
  cashPaymentContext,
  parseBody,
  parseRequestAmount,
  publicPayment,
  requireUser,
  sendError,
  serverClient,
  type ApiRequest,
  type ApiResponse,
} from '../_shared';

export const config = { api: { bodyParser: { sizeLimit: '64kb' } } };

export default async function handler(request: ApiRequest, response: ApiResponse): Promise<void> {
  if (request.method !== 'POST') { response.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const client = serverClient();
    const user = await requireUser(request, client);
    const body = parseBody(request.body);
    const amountCents = parseRequestAmount(body);
    const payment = await cashPaymentContext(client).createCashPayment({ amountCents, createdBy: user.id });
    response.status(201).json({ payment: publicPayment(payment) });
  } catch (error) { sendError(response, error); }
}
