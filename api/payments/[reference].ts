import { serverClient, requireUser, sendError, type ApiRequest, type ApiResponse } from '../_shared'

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' })
  try {
    const client = serverClient()
    await requireUser(request, client)
    const raw = request.query?.reference
    const reference = Array.isArray(raw) ? raw[0] : raw
    if (!reference) return response.status(400).json({ error: 'Reference required' })
    const { data, error } = await client.from('payments').select('*').eq('reference', reference).maybeSingle()
    if (error) throw error
    if (!data) return response.status(404).json({ error: 'Payment not found' })
    return response.status(200).json({
      id: data.id, reference: data.reference, amountCents: data.amount_cents, currency: data.currency,
      provider: data.provider, providerPaymentId: data.provider_payment_id, status: data.status,
      createdBy: data.created_by, createdAt: data.created_at, expiresAt: data.expires_at,
      paidAt: data.paid_at, cancelledAt: data.cancelled_at, providerData: data.provider_data ?? {},
    })
  } catch (error) { sendError(response, error) }
}
