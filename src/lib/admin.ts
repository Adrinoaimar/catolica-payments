import { apiFetch } from './supabase'
import type { QuickAmount } from './quickAmounts'

export type ManagedRole = 'ADMIN' | 'CASHIER'
export type ManagedUserStatus = 'ACTIVE' | 'INVITED' | 'SUSPENDED'

export interface ManagedUser {
  id: string
  email: string
  name: string
  role: ManagedRole | null
  status: ManagedUserStatus
  createdAt: string
  lastSignInAt: string | null
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: unknown }
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `La solicitud falló (${response.status}).`)
  return body as T
}

export async function listManagedUsers(): Promise<ManagedUser[]> {
  const body = await jsonResponse<{ users?: unknown }>(await apiFetch('/api/admin/users'))
  if (!Array.isArray(body.users)) throw new Error('El servidor devolvió usuarios inválidos.')
  return body.users.map(normalizeManagedUser)
}

export async function inviteManagedUser(input: { email: string; name: string; role: ManagedRole }): Promise<ManagedUser> {
  const response = await apiFetch('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await jsonResponse<{ user?: unknown }>(response)
  if (!body.user) throw new Error('El servidor no devolvió el usuario invitado.')
  return normalizeManagedUser(body.user)
}

export async function updateManagedUserRole(userId: string, role: ManagedRole): Promise<ManagedUser> {
  const response = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  })
  const body = await jsonResponse<{ user?: unknown }>(response)
  if (!body.user) throw new Error('El servidor no devolvió el usuario actualizado.')
  return normalizeManagedUser(body.user)
}

export async function listAdminQuickAmounts(): Promise<QuickAmount[]> {
  const body = await jsonResponse<{ amounts?: unknown }>(await apiFetch('/api/admin/quick-amounts'))
  if (!Array.isArray(body.amounts)) throw new Error('El servidor devolvió montos inválidos.')
  return body.amounts.map(normalizeQuickAmount)
}

export async function saveAdminQuickAmounts(amounts: number[]): Promise<QuickAmount[]> {
  const response = await apiFetch('/api/admin/quick-amounts', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amounts: amounts.map((amountCents) => ({ amountCents })) }),
  })
  const body = await jsonResponse<{ amounts?: unknown }>(response)
  if (!Array.isArray(body.amounts)) throw new Error('El servidor no devolvió montos válidos.')
  return body.amounts.map(normalizeQuickAmount)
}

function normalizeManagedUser(value: unknown): ManagedUser {
  if (!value || typeof value !== 'object') throw new Error('El servidor devolvió un usuario inválido.')
  const raw = value as Record<string, unknown>
  const role = raw.role === 'ADMIN' || raw.role === 'CASHIER' ? raw.role : null
  const status = raw.status === 'ACTIVE' || raw.status === 'INVITED' || raw.status === 'SUSPENDED' ? raw.status : null
  if (typeof raw.id !== 'string' || typeof raw.email !== 'string' || typeof raw.name !== 'string' || !status || typeof raw.createdAt !== 'string') {
    throw new Error('El servidor devolvió un usuario inválido.')
  }
  return {
    id: raw.id,
    email: raw.email,
    name: raw.name,
    role,
    status,
    createdAt: raw.createdAt,
    lastSignInAt: typeof raw.lastSignInAt === 'string' ? raw.lastSignInAt : null,
  }
}

function normalizeQuickAmount(value: unknown, index: number): QuickAmount {
  if (!value || typeof value !== 'object') throw new Error('El servidor devolvió un monto inválido.')
  const raw = value as Record<string, unknown>
  if (typeof raw.amountCents !== 'number' || !Number.isSafeInteger(raw.amountCents) || raw.amountCents <= 0 || raw.amountCents > 1_000_000) {
    throw new Error('El servidor devolvió un monto inválido.')
  }
  return {
    ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
    amountCents: raw.amountCents,
    sortOrder: typeof raw.sortOrder === 'number' && Number.isInteger(raw.sortOrder) ? raw.sortOrder : index,
  }
}
