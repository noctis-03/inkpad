// Inkpad Service Worker (NFR-06: 첫 설치 이후 오프라인 실행)
// self.__PRECACHE / self.__VERSION 은 빌드 시 vite.config.ts가 주입한다.
const VERSION = self.__VERSION || 'dev'
const PRECACHE = self.__PRECACHE || ['/']
const SHELL = `inkpad-shell-${VERSION}`
const RUNTIME = 'inkpad-runtime-v1' // pdf.js CMap/폰트 등 (버전 바뀌어도 유지)
const META = 'inkpad-meta' // 활성화된 셸 캐시의 순서 기록
/** 남겨 둘 셸 캐시 세대 수 — 지금 버전 + 직전 버전 */
const KEEP_SHELLS = 2

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  )
})

/** 이 셸을 최신으로 기록하고, 남겨 둘 셸 캐시 이름(최근 KEEP_SHELLS개)을 돌려준다 */
async function rememberShell() {
  const meta = await caches.open(META)
  const res = await meta.match('/__shells')
  let list = []
  try {
    list = res ? await res.json() : []
  } catch {
    list = []
  }
  list = list.filter((n) => n !== SHELL)
  list.push(SHELL)
  list = list.slice(-KEEP_SHELLS)
  await meta.put('/__shells', new Response(JSON.stringify(list), { headers: { 'Content-Type': 'application/json' } }))
  return list
}

// 새 버전은 설치되자마자 바로 넘겨받는다(배포 즉시 새 버전이 닿게). 다만 직전 버전의 셸 캐시는 한 세대 남긴다 —
// 이미 열려 있던 화면은 옛 index.html이 가리키는 옛 파일 이름(해시)으로 나중에 파일을 불러오는데(pdf.js,
// 내보내기 워커 등), 그 캐시를 바로 지우면 서버에도 캐시에도 없어 기능이 깨졌다. 그보다 오래된 셸만 지운다.
self.addEventListener('activate', (e) => {
  e.waitUntil(
    rememberShell()
      .then((keep) => {
        const keepSet = new Set([...keep, RUNTIME, META])
        return caches.keys().then((keys) => Promise.all(keys.filter((k) => !keepSet.has(k)).map((k) => caches.delete(k))))
      })
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
