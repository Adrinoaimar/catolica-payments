import {
  HttpError,
  parseBody,
  requireAdmin,
  serverClient,
  type ApiRequest,
  type ApiResponse,
} from '../../_shared';
import { managedUser, parseRole, setUserRole, type ManagedRole } from '../users';
import { firebaseAdminAuth } from '../../../src/server/firebaseAdmin';

export default async function handler(request: ApiRequest, response: ApiResponse): Promise<void> {
  if (request.method !== 'PATCH') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const client = serverClient();
    const admin = await requireAdmin(request, client);
    const userId = parseUserId(request.query?.id ?? request.query?.userId);
    const body = parseBody(request.body);
    const role = parseRole(body.role);
    const user = await firebaseAdminAuth().getUser(userId).catch(() => null);
    if (!user) throw new HttpError(404, 'Usuario no encontrado');
    await setUserRole(client, userId, role, admin.id);
    response.status(200).json({ user: await managedUser(client, user) });
  } catch (error) {
    sendAdminError(response, error);
  }
}

function parseUserId(value: unknown): string {
  const id = Array.isArray(value) ? value[0] : value;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new HttpError(400, 'Invalid user id');
  return id;
}

function sendAdminError(response: ApiResponse, error: unknown): void {
  if (error instanceof HttpError) {
    response.status(error.statusCode).json({ error: error.message });
    return;
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code);
    if (code === 'P0001') {
      response.status(409).json({ error: 'No se pudo cambiar el rol: debe quedar al menos un administrador.' });
      return;
    }
    if (code === 'P0002') {
      response.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }
  }
  response.status(500).json({ error: 'Internal server error' });
}
