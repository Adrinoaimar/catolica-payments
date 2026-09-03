import { createClient, type Session, type SupabaseClient, type User } from '@supabase/supabase-js'
import type { SessionUser } from '../types'

/**
 * Browser Supabase client.
 *
 * Only the publishable anon key is ever read here. The service-role key stays
 * in serverless environment variables and must never be prefixed with VITE_.
 */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

export const isDemoMode = !import.meta.env.PROD && import.meta.env.VITE_DEMO_MODE === 'true'
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null

export function authUserToSessionUser(authUser: User, role: SessionUser['role']): SessionUser {
  const metadata = authUser.user_metadata ?? {}
  const name = firstNonEmpty(metadata.full_name, metadata.name, metadata.display_name, authUser.email?.split('@')[0], 'Usuario')
  return {
    id: authUser.id,
    name: titleCase(String(name).replace(/[._-]+/g, ' ')),
    email: authUser.email ?? '',
    role,
    initials: initialsFor(String(name)),
  }
}

export function initialsFor(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'US'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
}

/**
 * Fetch API route with current Supabase access token.
 *
 * In explicit local demo mode, requests are allowed without a token so the
 * offline mock fallback can be exercised. Real mode fails closed when no
 * authenticated session exists.
 */
export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (isDemoMode) return fetch(input, init)
  if (!supabase) {
    throw new Error('Supabase no está configurado. Define VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.')
  }

  const { data, error } = await supabase.auth.getSession()
  if (error) throw new Error(`No se pudo validar la sesión: ${error.message}`)
  if (!data.session?.access_token) throw new Error('Tu sesión expiró. Ingresa nuevamente.')

  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${data.session.access_token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  return fetch(input, { ...init, headers })
}

export async function authenticatedSession(): Promise<Session | null> {
  if (!supabase) return null
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  return data.session
}

function firstNonEmpty(...values: unknown[]): unknown {
  return values.find((value) => typeof value === 'string' && value.trim())
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (match) => match.toUpperCase())
}
