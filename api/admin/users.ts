import {
  HttpError,
  parseBody,
  requireAdmin,
  sendError,
  serverClient,
  type ApiRequest,
  type ApiResponse,
} from '../_shared';
import type { User } from '@supabase/supabase-js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(request: ApiRequest, response: ApiResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const client = serverClient();
    const admin = await requireAdmin(request, client);
    if (request.method === 'GET') {
      response.status(200).json({ users: await listManagedUsers(client) });
      return;
    }

    const body = parseBody(request.body);
    const email = parseEmail(body.email);
    const name = parseName(body.name);
    const role = parseRole(body.role ?? 'CASHIER');
    const { data, error } = await client.auth.admin.inviteUserByEmail(email, {
      data: { full_name: name },
    });
    if (error) throw error;
    if (!data.user) throw new HttpError(503, 'Supabase did not return the invited user');

    try {
      await setUserRole(client, data.user.id, role, admin.id);
    } catch (error) {
      // An invitation without a role cannot log into this application. Remove
      // only the user created by this request if role assignment fails.
      await client.auth.admin.deleteUser(data.user.id);
      throw error;
    }
    const managed = await managedUser(client, data.user);
    response.status(201).json({ user: managed });
  } catch (error) {
    sendAdminError(response, error);
  }
}

export async function listManagedUsers(client: ReturnType<typeof serverClient>): Promise<ManagedUser[]> {
  const users: User[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const { data: authData, error: authError } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    if (authError) throw authError;
    const batch = authData.users ?? [];
    users.push(...batch);
    if (batch.length < 1000) break;
  }
  const { data: roleRows, error: roleError } = await client.from('user_roles').select('user_id, role');
  if (roleError) throw roleError;
  const roles = new Map((roleRows ?? []).map((row: { user_id: string; role: string }) => [row.user_id, row.role]));
  return users.map((user) => toManagedUser(user, roles.get(user.id)));
}

export async function managedUser(client: ReturnType<typeof serverClient>, user: User): Promise<ManagedUser> {
  const { data, error } = await client.from('user_roles').select('role').eq('user_id', user.id).maybeSingle();
  if (error) throw error;
  return toManagedUser(user, data?.role);
}

export async function setUserRole(
  client: ReturnType<typeof serverClient>,
  userId: string,
  role: ManagedRole,
  actorId: string,
): Promise<void> {
  const { error } = await client.rpc('admin_set_user_role', {
    p_user_id: userId,
    p_role: role,
    p_actor_id: actorId,
  });
  if (error) throw error;
}

export function parseRole(value: unknown): ManagedRole {
  const role = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (role !== 'ADMIN' && role !== 'CASHIER') throw new HttpError(400, 'role must be ADMIN or CASHIER');
  return role;
}

function parseEmail(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'A valid email is required');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new HttpError(400, 'A valid email is required');
  return email;
}

function parseName(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'Name is required');
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 100) throw new HttpError(400, 'Name must contain between 2 and 100 characters');
  return name;
}

export type ManagedRole = 'ADMIN' | 'CASHIER';
export type ManagedUserStatus = 'ACTIVE' | 'INVITED' | 'SUSPENDED';

export interface ManagedUser {
  id: string;
  email: string;
  name: string;
  role: ManagedRole | null;
  status: ManagedUserStatus;
  createdAt: string;
  lastSignInAt: string | null;
}

function toManagedUser(user: User, role: string | undefined): ManagedUser {
  const metadata = user.user_metadata ?? {};
  const name = firstText(metadata.full_name, metadata.name, metadata.display_name, user.email?.split('@')[0], 'Usuario');
  const suspended = Boolean(user.banned_until && new Date(user.banned_until).getTime() > Date.now());
  const status: ManagedUserStatus = suspended ? 'SUSPENDED' : user.email_confirmed_at ? 'ACTIVE' : 'INVITED';
  return {
    id: user.id,
    email: user.email ?? '',
    name,
    role: role === 'ADMIN' || role === 'CASHIER' ? role : null,
    status,
    createdAt: user.created_at,
    lastSignInAt: user.last_sign_in_at ?? null,
  };
}

function firstText(...values: unknown[]): string {
  const value = values.find((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return value?.trim() ?? 'Usuario';
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
    if (code === '23505') {
      response.status(409).json({ error: 'El correo ya está registrado.' });
      return;
    }
    if (code === 'email_exists' || code === 'user_already_exists') {
      response.status(409).json({ error: 'El correo ya está registrado.' });
      return;
    }
  }
  if (error instanceof Error && /already registered|already exists|email exists/i.test(error.message)) {
    response.status(409).json({ error: 'El correo ya está registrado.' });
    return;
  }
  sendError(response, error);
}
