import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { registerServiceWorker } from '../src/lib/pwa'

describe('PWA shell contract', () => {
  it('does not register a service worker outside production', async () => {
    const serviceWorker = { register: vi.fn() } as unknown as ServiceWorkerContainer
    await registerServiceWorker({ isProduction: false, serviceWorker })
    expect(serviceWorker.register).not.toHaveBeenCalled()
  })

  it('registers the production worker at root scope', async () => {
    const registration = {} as ServiceWorkerRegistration
    const serviceWorker = { register: vi.fn().mockResolvedValue(registration) } as unknown as ServiceWorkerContainer
    await expect(registerServiceWorker({ isProduction: true, serviceWorker })).resolves.toBe(registration)
    expect(serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' })
  })

  it('keeps API and webhook paths outside the service-worker cache policy', () => {
    const worker = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8')
    expect(worker).toContain("const PRIVATE_PREFIXES = ['/api/', '/auth/', '/rest/', '/realtime/', '/dev/']")
    expect(worker).toContain("request.method !== 'GET'")
    expect(worker).toContain("url.origin !== self.location.origin")
  })

  it('ships an installable manifest with a scoped standalone shell', () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'public/manifest.webmanifest'), 'utf8')) as {
      start_url: string
      scope: string
      display: string
      icons: Array<{ src: string; type: string }>
    }
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.display).toBe('standalone')
    expect(manifest.icons.some((icon) => icon.src === '/icons/icon.svg' && icon.type === 'image/svg+xml')).toBe(true)
  })
})
