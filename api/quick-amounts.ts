import {
  requireUser,
  sendError,
  serverClient,
  type ApiRequest,
  type ApiResponse,
} from './_shared';

export default async function handler(request: ApiRequest, response: ApiResponse): Promise<void> {
  if (request.method !== 'GET') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const client = serverClient();
    await requireUser(request, client);
    const { data, error } = await client
      .from('quick_amounts')
      .select('id, amount_cents, sort_order')
      .eq('active', true)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    response.status(200).json({ amounts: (data ?? []).map(toPublicAmount) });
  } catch (error) {
    sendError(response, error);
  }
}

function toPublicAmount(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: typeof row.id === 'string' ? row.id : undefined,
    amountCents: row.amount_cents,
    sortOrder: row.sort_order,
  };
}
