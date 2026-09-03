import { apiFetch, isDemoMode } from './supabase'

export interface QuickAmount {
  id?: string
  amountCents: number
  sortOrder: number
}

export const DEFAULT_QUICK_AMOUNTS = [1000, 1500, 2000, 2500, 3000, 4000, 5000]

export async function fetchQuickAmounts(): Promise<QuickAmount[]> {
  try {
    const response = await apiFetch('/api/quick-amounts')
    const body = await response.json().catch(() => ({})) as { amounts?: unknown; error?: unknown }
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `No se pudieron cargar los montos (${response.status}).`)
    if (!Array.isArray(body.amounts)) throw new Error('El servidor devolvió montos inválidos.')
    const amounts = body.amounts.map(normalizeQuickAmount)
    if (amounts.length === 0) throw new Error('No hay montos rápidos configurados.')
    return amounts.sort((a, b) => a.sortOrder - b.sortOrder)
  } catch (error) {
    if (isDemoMode) return DEFAULT_QUICK_AMOUNTS.map((amountCents, sortOrder) => ({ amountCents, sortOrder }))
    throw error
  }
}

function normalizeQuickAmount(value: unknown, index: number): QuickAmount {
  if (!value || typeof value !== 'object') throw new Error('El servidor devolvió un monto inválido.')
  const raw = value as { id?: unknown; amountCents?: unknown; sortOrder?: unknown }
  if (typeof raw.amountCents !== 'number' || !Number.isSafeInteger(raw.amountCents) || raw.amountCents <= 0 || raw.amountCents > 1_000_000) {
    throw new Error('El servidor devolvió un monto inválido.')
  }
  return {
    ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
    amountCents: raw.amountCents,
    sortOrder: typeof raw.sortOrder === 'number' && Number.isInteger(raw.sortOrder) ? raw.sortOrder : index,
  }
}
