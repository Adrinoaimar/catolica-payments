import { paymentContext, parseBody, requireUser, sendError, serverClient, type ApiRequest, type ApiResponse } from './_shared';
import { solesToCents } from '../src/server';

export default async function handler(request: ApiRequest, response: ApiResponse): Promise<void> {
  if (request.method !== 'POST') { response.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const client = serverClient();
    const user = await requireUser(request, client);
    const body = parseBody(request.body);
    const rawCents = body.amount_cents ?? body.amountCents;
    const amountCents = Number.isSafeInteger(Number(rawCents)) ? Number(rawCents) : solesToCents(String(body.amount ?? ''));
    const { service } = paymentContext();
    if (String(body.method ?? 'DIGITAL').toUpperCase() === 'CASH') {
      const payment = await service.createCashPayment({ amountCents, createdBy: user.id });
      response.status(201).json({ payment });
      return;
    }
    const result = await service.createDigitalPayment({ amountCents, createdBy: user.id });
    response.status(201).json(result);
  } catch (error) { sendError(response, error); }
}
