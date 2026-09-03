import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { clearSession, loadSession, saveSession } from './demoStore'
import { authUserToSessionUser, initialsFor, isDemoMode, isSupabaseConfigured, supabase } from './supabase'
import type { SessionUser } from '../types'

interface AuthContextValue {
  user: SessionUser | null
  session: Session | null
  loading: boolean
  error: string | null
  demoMode: boolean
  signIn: (email: string, password: string) => Promise<SessionUser>
  signOut: () => Promise<void>
  resetPassword: (email: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    if (isDemoMode) {
      const stored = loadSession()
      if (active) {
        setUser(stored)
        setLoading(false)
      }
      return () => { active = false }
    }

    if (!supabase) {
      if (active) {
        setError('Supabase Auth no está configurado. Define las variables VITE_SUPABASE_* antes de iniciar sesión.')
        setLoading(false)
      }
      return () => { active = false }
    }

    const hydrate = async (nextSession: Session | null) => {
      if (!nextSession) {
        if (active) { setSession(null); setUser(null); setLoading(false) }
        return
      }
      try {
        const nextUser = await resolveSessionUser(nextSession.user)
        if (!active) return
        setSession(nextSession)
        setUser(nextUser)
        setError(null)
      } catch (reason) {
        if (!active) return
        setSession(nextSession)
        setUser(null)
        setError(toAuthMessage(reason))
      } finally {
        if (active) setLoading(false)
      }
    }

    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (sessionError) throw sessionError
      return hydrate(data.session)
    }).catch((reason) => {
      if (active) {
        setError(toAuthMessage(reason))
        setLoading(false)
      }
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      // Do not await inside Supabase callback. Hydration can query user_roles.
      window.setTimeout(() => { void hydrate(nextSession) }, 0)
    })

    return () => {
      active = false
      listener.subscription.unsubscribe()
    }
  }, [])

  const value = useMemo<AuthContextValue>(() => ({
    user,
    session,
    loading,
    error,
    demoMode: isDemoMode,
    signIn: async (email, password) => {
      const normalizedEmail = email.trim().toLowerCase()
      if (!normalizedEmail || !password) throw new Error('Ingresa tu correo y contraseña para continuar.')

      if (isDemoMode) {
        const demoUser = makeDemoUser(normalizedEmail)
        saveSession(demoUser)
        setUser(demoUser)
        setError(null)
        return demoUser
      }
      if (!supabase) throw new Error('Supabase Auth no está configurado.')

      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password })
      if (signInError) throw new Error(toAuthMessage(signInError))
      if (!data.session) throw new Error('No se recibió una sesión válida.')

      const nextUser = await resolveSessionUser(data.session.user)
      setSession(data.session)
      setUser(nextUser)
      setError(null)
      return nextUser
    },
    signOut: async () => {
      if (supabase && !isDemoMode) {
        const { error: signOutError } = await supabase.auth.signOut()
        if (signOutError) throw new Error(toAuthMessage(signOutError))
      }
      clearSession()
      setSession(null)
      setUser(null)
      setError(null)
    },
    resetPassword: async (email) => {
      const normalizedEmail = email.trim().toLowerCase()
      if (!normalizedEmail) throw new Error('Ingresa tu correo electrónico.')
      if (isDemoMode) return
      if (!supabase) throw new Error('Supabase Auth no está configurado.')
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
        redirectTo: `${window.location.origin}/reset-password`,
      })
      if (resetError) throw new Error(toAuthMessage(resetError))
    },
  }), [error, loading, session, user])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}

async function resolveSessionUser(authUser: User): Promise<SessionUser> {
  if (!supabase) throw new Error('Supabase Auth no está configurado.')
  const { data: roleRow, error: roleError } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', authUser.id)
    .maybeSingle()
  if (roleError) throw new Error(`No se pudo cargar tu rol: ${roleError.message}`)
  if (!roleRow || !['ADMIN', 'CASHIER'].includes(String(roleRow.role))) {
    throw new Error('Tu usuario todavía no tiene un rol asignado. Solicita acceso al administrador.')
  }
  return authUserToSessionUser(authUser, roleRow.role as SessionUser['role'])
}

function makeDemoUser(email: string): SessionUser {
  const rawName = email.split('@')[0] || 'Usuario demo'
  const name = rawName.replace(/[._-]+/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase())
  return { id: 'cashier-demo', name, email, role: email.includes('admin') ? 'ADMIN' : 'CASHIER', initials: initialsFor(name) }
}

function toAuthMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message
  if (typeof reason === 'object' && reason && 'message' in reason && typeof reason.message === 'string') return reason.message
  return 'No se pudo validar tu sesión. Intenta nuevamente.'
}

export { isSupabaseConfigured }
