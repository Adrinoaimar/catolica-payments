import { getApps, initializeApp, type FirebaseApp } from 'firebase/app'
import { getAuth, type Auth, type User } from 'firebase/auth'
import type { SessionUser } from '../types'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY?.trim(),
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim(),
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim(),
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET?.trim(),
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim(),
  appId: import.meta.env.VITE_FIREBASE_APP_ID?.trim(),
}

/** Firebase Auth is optional only in explicit local demo mode. */
export const isDemoMode = !import.meta.env.PROD && import.meta.env.VITE_DEMO_MODE === 'true'
export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey
  && firebaseConfig.authDomain
  && firebaseConfig.projectId
  && firebaseConfig.messagingSenderId
  && firebaseConfig.appId,
)

let firebaseApp: FirebaseApp | null = null
if (isFirebaseConfigured) {
  firebaseApp = getApps()[0] ?? initializeApp(firebaseConfig)
}

export const firebaseAuth: Auth | null = firebaseApp ? getAuth(firebaseApp) : null

/** Convert Firebase's identity to the UI session shape. */
export function authUserToSessionUser(authUser: User, role: SessionUser['role']): SessionUser {
  const name = firstNonEmpty(
    authUser.displayName,
    authUser.email?.split('@')[0],
    'Usuario',
  )
  return {
    id: authUser.uid,
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
 * Fetch API route with current Firebase ID token.
 *
 * Demo mode remains an explicit local-only escape hatch. Production fails
 * closed when Firebase is not configured or no authenticated user exists.
 */
export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (isDemoMode) return fetch(input, init)
  if (!firebaseAuth) {
    throw new Error('Firebase Auth no está configurado. Define VITE_FIREBASE_* antes de iniciar sesión.')
  }

  const currentUser = firebaseAuth.currentUser
  if (!currentUser) throw new Error('Tu sesión expiró. Ingresa nuevamente.')
  const accessToken = await currentUser.getIdToken()
  if (!accessToken) throw new Error('Tu sesión expiró. Ingresa nuevamente.')

  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${accessToken}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  return fetch(input, { ...init, headers })
}

export async function authenticatedSession(): Promise<User | null> {
  return firebaseAuth?.currentUser ?? null
}

function firstNonEmpty(...values: unknown[]): unknown {
  return values.find((value) => typeof value === 'string' && value.trim())
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (match) => match.toUpperCase())
}
