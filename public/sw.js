/*
 * Católica Pay shell service worker.
 *
 * This deliberately has a narrow cache allow-list. Payment/API requests,
 * webhook endpoints, Firebase calls and development routes never enter a
 * cache, so an offline/stale browser cannot present old financial data.
 */
const CACHE_PREFIX = 'catolica-payments-'
const SHELL_CACHE = `${CACHE_PREFIX}shell-v1`
const ASSET_CACHE = `${CACHE_PREFIX}assets-v1`
const SCOPE_URL = self.registration.scope
const SHELL_URL = new URL('./', SCOPE_URL).href
const PRECACHE_URLS = [
  SHELL_URL,
  new URL('./manifest.webmanifest', SCOPE_URL).href,
  new URL('./icons/icon.svg', SCOPE_URL).href,
]
const PRIVATE_PREFIXES = ['/api/', '/auth/', '/rest/', '/realtime/', '/dev/']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && ![SHELL_CACHE, ASSET_CACHE].includes(key))
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)

  if (request.method !== 'GET' || url.origin !== self.location.origin || isPrivatePath(url.pathname)) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request))
    return
  }

  if (isStaticAsset(url.pathname)) event.respondWith(cacheFirstAsset(request))
})

function isPrivatePath(pathname) {
  return PRIVATE_PREFIXES.some((prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix))
}

function isStaticAsset(pathname) {
  return pathname === '/manifest.webmanifest'
    || pathname === '/favicon.svg'
    || pathname.startsWith('/assets/')
    || pathname.startsWith('/icons/')
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE)
      await cache.put(SHELL_URL, response.clone())
    }
    return response
  } catch {
    const cached = await caches.match(SHELL_URL)
    return cached || Response.error()
  }
}

async function cacheFirstAsset(request) {
  const cached = await caches.match(request)
  if (cached) return cached

  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(ASSET_CACHE)
      await cache.put(request, response.clone())
    }
    return response
  } catch {
    return Response.error()
  }
}
