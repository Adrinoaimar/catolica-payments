import { requireUser, serverClient, sendError, type ApiRequest, type ApiResponse } from '../_shared';

export default async function handler(request: ApiRequest, response: ApiResponse): Promise<void> {
  if (request.method !== 'GET') { response.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const user = await requireUser(request, serverClient());
    response.status(200).json({ user });
  } catch (error) { sendError(response, error); }
}
