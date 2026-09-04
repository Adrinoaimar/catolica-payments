import { HttpError, parseBody, requireAdmin, sendError, serverClient, type ApiRequest, type ApiResponse } from '../_shared';
import { firebaseAdminAuth, type UserRecord } from '../../src/server/firebaseAdmin';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(request: ApiRequest, response: ApiResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'POST') { response.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const client = serverClient();
    const admin = await requireAdmin(request, client);
    if (request.method === 'GET') { response.status(200).json({ users: await listManagedUsers(client) }); return; }
    const body = parseBody(request.body);
    const email = parseEmail(body.email);
    const name = parseName(body.name);
    const role = parseRole(body.role ?? 'CASHIER');
    const auth = firebaseAdminAuth();
    const user = await auth.createUser({ email, displayName: name, emailVerified: false, disabled: false });
    try { await setUserRole(client, user.uid, role, admin.id); }
    catch (error) { await auth.deleteUser(user.uid).catch(() => undefined); throw error; }
    response.status(201).json({ user: await managedUser(client, user) });
  } catch (error) { sendAdminError(response, error); }
}

export async function listManagedUsers(client: ReturnType<typeof serverClient>): Promise<ManagedUser[]> {
  const users: UserRecord[] = [];
  let pageToken: string | undefined;
  do {
    const page = await firebaseAdminAuth().listUsers(1000, pageToken);
    users.push(...page.users); pageToken = page.pageToken;
  } while (pageToken);
  const rolesResult = await client.from('user_roles').select('user_id, role');
  if (rolesResult.error) throw rolesResult.error;
  const roles = new Map<string, string>((rolesResult.data ?? []).map((row: { user_id: string; role: string }) => [row.user_id, row.role] as [string, string]));
  return users.map((user) => toManagedUser(user, roles.get(user.uid)));
}

export async function managedUser(client: ReturnType<typeof serverClient>, user: UserRecord): Promise<ManagedUser> {
  const result = await client.from('user_roles').select('role').eq('user_id', user.uid).maybeSingle();
  if (result.error) throw result.error;
  return toManagedUser(user, result.data?.role);
}

export async function setUserRole(client: ReturnType<typeof serverClient>, userId: string, role: ManagedRole, actorId: string): Promise<void> {
  const result = await client.rpc('admin_set_user_role', { p_user_id: userId, p_role: role, p_actor_id: actorId });
  if (result.error) throw result.error;
  await firebaseAdminAuth().setCustomUserClaims(userId, { role });
}

export function parseRole(value: unknown): ManagedRole {
  const role = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (role !== 'ADMIN' && role !== 'CASHIER') throw new HttpError(400, 'role must be ADMIN or CASHIER');
  return role;
}
function parseEmail(value: unknown): string { if (typeof value !== 'string') throw new HttpError(400, 'A valid email is required'); const email = value.trim().toLowerCase(); if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new HttpError(400, 'A valid email is required'); return email; }
function parseName(value: unknown): string { if (typeof value !== 'string') throw new HttpError(400, 'Name is required'); const name = value.trim().replace(/\s+/g, ' '); if (name.length < 2 || name.length > 100) throw new HttpError(400, 'Name must contain between 2 and 100 characters'); return name; }

export type ManagedRole = 'ADMIN' | 'CASHIER';
export type ManagedUserStatus = 'ACTIVE' | 'INVITED' | 'SUSPENDED';
export interface ManagedUser { id: string; email: string; name: string; role: ManagedRole | null; status: ManagedUserStatus; createdAt: string; lastSignInAt: string | null; }

function toManagedUser(user: UserRecord, role: string | undefined): ManagedUser {
  const status: ManagedUserStatus = user.disabled ? 'SUSPENDED' : user.emailVerified ? 'ACTIVE' : 'INVITED';
  return { id: user.uid, email: user.email ?? '', name: user.displayName?.trim() || user.email?.split('@')[0] || 'Usuario', role: role === 'ADMIN' || role === 'CASHIER' ? role : null,
    status, createdAt: user.metadata.creationTime ?? new Date().toISOString(), lastSignInAt: user.metadata.lastSignInTime ?? null };
}

function sendAdminError(response: ApiResponse, error: unknown): void {
  if (error instanceof HttpError) { response.status(error.statusCode).json({ error: error.message }); return; }
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
  if (code === 'P0001') { response.status(409).json({ error: 'No se pudo cambiar el rol: debe quedar al menos un administrador.' }); return; }
  if (code === 'P0002' || code === 'auth/user-not-found') { response.status(404).json({ error: 'Usuario no encontrado' }); return; }
  if (code === 'auth/email-already-exists') { response.status(409).json({ error: 'El correo ya está registrado.' }); return; }
  sendError(response, error);
}
