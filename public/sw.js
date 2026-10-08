/* Application-shell cache only. User books live in OPFS/IndexedDB and are never cached here. */
const CACHE_NAME = 'worlibrary-shell-v1'
const APP_SHELL = ['/', '/index.html', '/offline.html', '/manifest.webmanifest']
const NEVER_CACHE = /^\/(api|auth|rest|storage)\b/

self.addEventListener('install', (event) => { event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))) })
self.addEventListener('activate', (event) => { event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('worlibrary-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim())) })
self.addEventListener('message', (event) => { if (event.data?.type === 'SKIP_WAITING') self.skipWaiting() })
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || NEVER_CACHE.test(url.pathname)) return
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => { const copy = response.clone(); void caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy)); return response }).catch(async () => (await caches.match('/index.html')) || caches.match('/offline.html')))
    return
  }
  const isStaticAsset = url.pathname.startsWith('/assets/') || ['script', 'style', 'worker', 'font', 'image'].includes(request.destination)
  if (!isStaticAsset || /\.(epub|pdf|mobi|cbz)$/i.test(url.pathname)) return
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => { if (response.ok) { const copy = response.clone(); void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)) } return response })))
})
