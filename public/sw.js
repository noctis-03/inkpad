// Inkpad Service Worker (NFR-06: 첫 설치 이후 오프라인 실행)
// self.__PRECACHE / self.__VERSION 은 빌드 시 vite.config.ts가 주입한다.
const VERSION = self.__VERSION || 'dev'
const PRECACHE = self.__PRECACHE || ['/']
const SHELL = `inkpad-shell-${VERSION}`
const RUNTIME = 'inkpad-runtime-v1' // pdf.js CMap/폰트 등 (버전 바뀌어도 유지)

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting()
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return

  // 앱 화면: 네트워크 우선 — 배포 즉시 새 버전이 닿는다(구버전이 남아 기기마다
  // 다른 증상이 보이는 일 방지). 실패하면 캐시로 (오프라인 실행은 그대로 유지).
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put('/', res.clone()))
          return res
        })
        .catch(() => caches.match('/', { cacheName: SHELL }).then((hit) => hit || Response.error()))
    )
    return
  }

  // 해시가 붙은 빌드 파일, 아이콘 등: 캐시 우선
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && (url.pathname.startsWith('/pdfjs/') || url.pathname.startsWith('/assets/'))) {
            const copy = res.clone()
            caches.open(url.pathname.startsWith('/pdfjs/') ? RUNTIME : SHELL).then((c) => c.put(req, copy))
          }
          return res
        })
    )
  )
})
