import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth'
import { clearSession, loadSession, saveSession } from './demoStore'
import {
  authUserToSessionUser,
  firebaseAuth,
  initialsFor,
  isDemoMode,
  isFirebaseConfigured,
  apiFetch,
} from './firebase'
import type { SessionUser } from '../types'

interface AuthContextValue {
  user: SessionUser | null
  session: User | null
  loading: boolean
  error: string | null
  demoMode: boolean
  signIn: (email: string, password: string) => Promise<SessionUser>
  signOut: () => Promise<void>
  resetPassword: (email: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<User | null>(null)
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

    if (!firebaseAuth || !isFirebaseConfigured) {
      if (active) {
        setError('Firebase Auth no está configurado. Define las variables VITE_FIREBASE_* antes de iniciar sesión.')
        setLoading(false)
      }
      return () => { active = false }
    }

    const hydrate = async (nextUser: User | null) => {
      if (!nextUser) {
        if (active) {
          setSession(null)
          setUser(null)
          setError(null)
          setLoading(false)
        }
        return
      }
      try {
        const nextSessionUser = await resolveSessionUser(nextUser)
        if (!active) return
        setSession(nextUser)
        setUser(nextSessionUser)
        setError(null)
      } catch (reason) {
        if (!active) return
        setSession(nextUser)
        setUser(null)
        setError(toAuthMessage(reason))
      } finally {
        if (active) setLoading(false)
      }
    }

    const unsubscribe = onAuthStateChanged(firebaseAuth, (nextUser) => {
      void hydrate(nextUser)
    })

    return () => {
      active = false
      unsubscribe()
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
      if (!firebaseAuth || !isFirebaseConfigured) throw new Error('Firebase Auth no está configurado.')

      try {
        const credential = await signInWithEmailAndPassword(firebaseAuth, normalizedEmail, password)
        const nextUser = await resolveSessionUser(credential.user)
        setSession(credential.user)
        setUser(nextUser)
        setError(null)
        return nextUser
      } catch (reason) {
        throw new Error(toAuthMessage(reason))
      }
    },
    signOut: async () => {
      if (firebaseAuth && !isDemoMode) await firebaseSignOut(firebaseAuth)
      clearSession()
      setSession(null)
      setUser(null)
      setError(null)
    },
    resetPassword: async (email) => {
      const normalizedEmail = email.trim().toLowerCase()
      if (!normalizedEmail) throw new Error('Ingresa tu correo electrónico.')
      if (isDemoMode) return
      if (!firebaseAuth || !isFirebaseConfigured) throw new Error('Firebase Auth no está configurado.')
      try {
        await sendPasswordResetEmail(firebaseAuth, normalizedEmail, {
          url: `${window.location.origin}/reset-password`,
          handleCodeInApp: false,
        })
      } catch (reason) {
        throw new Error(toAuthMessage(reason))
      }
    },
  }), [error, loading, session, user])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}

/**
 * UI role comes from a Firebase custom claim when present. The API must still
 * resolve the authoritative role from Neon for every protected request.
 */
async function resolveSessionUser(authUser: User): Promise<SessionUser> {
  let role: SessionUser['role'] = 'CASHIER'
  try {
    const response = await apiFetch('/api/auth/me')
    const body = await response.json().catch(() => ({})) as { user?: { role?: unknown } }
    if (response.ok && body.user?.role === 'ADMIN') role = 'ADMIN'
  } catch {
    // The API remains authoritative; the fallback keeps the shell usable while
    // the first request is retried or during a local preview without functions.
  }
  return authUserToSessionUser(authUser, role)
}

function makeDemoUser(email: string): SessionUser {
  const rawName = email.split('@')[0] || 'Usuario demo'
  const name = rawName.replace(/[._-]+/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase())
  return { id: 'cashier-demo', name, email, role: email.includes('admin') ? 'ADMIN' : 'CASHIER', initials: initialsFor(name) }
}

function toAuthMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) return translateFirebaseError(reason.message)
  if (typeof reason === 'object' && reason && 'message' in reason && typeof reason.message === 'string') {
    return translateFirebaseError(reason.message)
  }
  return 'No se pudo validar tu sesión. Intenta nuevamente.'
}

function translateFirebaseError(message: string): string {
  if (/auth\/invalid-credential|auth\/wrong-password|auth\/user-not-found/i.test(message)) return 'Correo o contraseña incorrectos.'
  if (/auth\/too-many-requests/i.test(message)) return 'Demasiados intentos. Espera unos minutos y vuelve a intentar.'
  if (/auth\/invalid-email/i.test(message)) return 'El correo electrónico no es válido.'
  if (/auth\/network-request-failed/i.test(message)) return 'No se pudo conectar con Firebase Auth.'
  return message
}

export { isFirebaseConfigured }
