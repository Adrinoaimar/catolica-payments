const SERVICE_WORKER_PATH = '/sw.js'

type ServiceWorkerRegistrationOptions = {
  isProduction?: boolean
  serviceWorker?: ServiceWorkerContainer
}

/**
 * Register the shell-only service worker in production builds.
 *
 * Payment data and all API requests remain network-only. Keeping registration
 * behind the production flag also prevents a stale worker from interfering
 * with Vite's development server.
 */
export async function registerServiceWorker(
  options: ServiceWorkerRegistrationOptions = {},
): Promise<ServiceWorkerRegistration | undefined> {
  const isProduction = options.isProduction ?? import.meta.env.PROD
  const serviceWorker = options.serviceWorker ?? getServiceWorkerContainer()
  if (!isProduction || !serviceWorker) return undefined

  try {
    return await serviceWorker.register(SERVICE_WORKER_PATH, { scope: '/' })
  } catch {
    // The app remains fully usable without a service worker (for example when
    // a hosting platform has not exposed /sw.js yet).
    return undefined
  }
}

function getServiceWorkerContainer(): ServiceWorkerContainer | undefined {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined
  return navigator.serviceWorker
}

export { SERVICE_WORKER_PATH }
