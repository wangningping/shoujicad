/* 轻量 PWA 缓存：应用外壳预缓存，WASM 运行时按需缓存。 */
const SHELL_CACHE = 'cad-viewer-shell-v1'
const WASM_CACHE = 'cad-viewer-wasm-v1'
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== WASM_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return

  if (url.pathname.endsWith('.wasm')) {
    event.respondWith(
      caches.open(WASM_CACHE).then(async (cache) => {
        const hit = await cache.match(event.request)
        if (hit) return hit
        const res = await fetch(event.request)
        if (res.ok) cache.put(event.request, res.clone())
        return res
      })
    )
    return
  }

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && ['document', 'script', 'style'].includes(event.request.destination)) {
          const copy = res.clone()
          caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy))
        }
        return res
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('./index.html')))
  )
})
