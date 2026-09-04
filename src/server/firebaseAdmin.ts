import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth, type UserRecord } from 'firebase-admin/auth';

let app: App | undefined;
function firebaseApp(): App {
  if (app) return app;
  const existing = getApps()[0];
  if (existing) { app = existing; return app; }
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
  if (!projectId || !clientEmail || !privateKey) throw new Error('Firebase Admin environment is not configured');
  app = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  return app;
}

export function firebaseAdminAuth(): Auth { return getAuth(firebaseApp()); }
export type { UserRecord };
