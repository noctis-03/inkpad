// ── 디버깅용 네트워크 사용량 계량기 ────────────────────────────────
// 셀룰러 데이터 사용량 확인용. 브라우저는 Wi-Fi와 셀룰러를 구분할 수 없어
// 통합 수치만 센다. 페이지를 새로고침하거나 앱을 껐다 켜면 0으로 초기화된다
// (누적 저장하지 않음).
//
// 떼어 내는 방법:
//   1) 이 파일 삭제
//   2) main.tsx: installNetMeter import + 호출 삭제
//   3) SettingsPanel.tsx: NetUsageSection import + 렌더 한 줄 삭제
//   4) src/ui/NetUsageDebug.tsx 삭제 (styles.css의 .net-usage-* / .net-log-* 규칙도 함께)
//
// 계측 대상: window.fetch로 나가는 요청/응답 바이트.
// 앱의 네트워크 트래픽(원본 지연 로딩·동기화 업/다운로드·토큰 교환)은 모두 fetch를 지난다.
//
// 두 가지를 함께 센다.
//   - 합계(NetStats): 앱을 켠 뒤 총 사용량
//   - 로그(NetEntry[]) + 목적지별 집계(NetDest[]): 어디로 나간 요청이 얼마나 썼는지

export interface NetStats {
  /** 내려받은 바이트 */
  down: number
  /** 올려보낸 바이트 */
  up: number
  /** 요청 수 */
  requests: number
  /** 크기를 알 수 없어 세지 못한 응답 수 */
  unknown: number
  /** 계량 시작 시각 (ms) */
  since: number
}

/** 목적지(사람이 읽는 이름)별 누적 사용량 */
export interface NetDest {
  /** 목적지 라벨 */
  label: string
  /** 내려받은 바이트 */
  down: number
  /** 올려보낸 바이트 */
  up: number
  /** 요청 수 */
  requests: number
}

/** 요청 한 건의 기록 */
export interface NetEntry {
  id: number
  /** 요청 시작 시각 (ms) */
  at: number
  /** HTTP 메서드 */
  method: string
  /** 목적지 라벨 */
  label: string
  /** 실제 요청 URL (툴팁용) */
  url: string
  /** 올려보낸 바이트 */
  up: number
  /** 내려받은 바이트 (스트리밍이면 도착하는 대로 증가) */
  down: number
  /** 응답 상태 코드. 0이면 네트워크 실패, null이면 아직 응답 전 */
  status: number | null
  /** 응답 헤더를 받기까지 걸린 ms (null이면 아직) */
  ms: number | null
  /** 크기를 알 수 없어 세지 못한 응답 */
  unknown: boolean
}

/** 로그를 이 개수까지만 보관한다 (메모리·렌더 부담 방지) */
const MAX_LOG = 200

const stats: NetStats = { down: 0, up: 0, requests: 0, unknown: 0, since: Date.now() }

/** 최신 요청이 앞에 온다 */
const log: NetEntry[] = []
const destMap = new Map<string, NetDest>()
let seq = 0

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((f) => f())

// 바이트가 조금씩 도착할 때마다 다시 그리면 비싸므로 알림을 합친다.
let notifyTimer: number | null = null
function scheduleNotify() {
  if (notifyTimer != null) return
  notifyTimer = window.setTimeout(() => {
    notifyTimer = null
    notify()
  }, 200)
}

/** 사용량이 바뀔 때 알림. 해제 함수를 돌려준다. */
export function subscribeNetStats(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function getNetStats(): NetStats {
  return { ...stats }
}

/** 목적지별 집계 (많이 쓴 순) */
export function getNetDestinations(): NetDest[] {
  return [...destMap.values()]
    .map((d) => ({ ...d }))
    .sort((a, b) => b.down + b.up - (a.down + a.up))
}

/** 최근 요청 기록 (최신순, 최대 MAX_LOG건) */
export function getNetLog(): NetEntry[] {
  return log.map((e) => ({ ...e }))
}

/** 계량값·로그를 모두 0으로 되돌린다 (계량 시작 시각도 지금으로) */
export function resetNetStats() {
  stats.down = 0
  stats.up = 0
  stats.requests = 0
  stats.unknown = 0
  stats.since = Date.now()
  log.length = 0
  destMap.clear()
  if (notifyTimer != null) {
    window.clearTimeout(notifyTimer)
    notifyTimer = null
  }
  notify()
}

/** 요청 본문 크기(알 수 없으면 0). FormData/스트림은 셀 수 없다 */
function bodyBytes(body: unknown): number {
  if (!body) return 0
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength
  if (body instanceof Blob) return body.size
  if (body instanceof ArrayBuffer) return body.byteLength
  if (ArrayBuffer.isView(body)) return body.byteLength
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength
  return 0
}

/** URL을 사람이 읽는 목적지 라벨로 바꾼다 */
function labelFor(rawUrl: string, method: string): { label: string; url: string } {
  let u: URL
  try {
    u = new URL(rawUrl, typeof location !== 'undefined' ? location.href : 'http://localhost')
  } catch {
    return { label: rawUrl || '(알 수 없음)', url: rawUrl }
  }
  const path = u.pathname
  const sameOrigin = typeof location !== 'undefined' && u.origin === location.origin

  if (sameOrigin) {
    if (path === '/api/auth/token') return { label: '동기화 토큰 교환 · 자체 서버', url: path }
    if (path === '/api/auth/login') return { label: '로그인 · 자체 서버', url: path }
    if (path === '/api/auth/logout') return { label: '로그아웃 · 자체 서버', url: path }
    if (path.startsWith('/api/auth/')) return { label: `인증 · ${path}`, url: path }
    if (path.startsWith('/api/')) return { label: path, url: path }
    return { label: `${u.origin}${path}`, url: u.href }
  }

  if (u.hostname === 'www.googleapis.com') {
    // 업로드는 별도 호스트 경로(/upload/drive/v3)로 나간다
    if (path.startsWith('/upload/drive')) return { label: 'Google Drive · 업로드', url: `${u.origin}${path}` }
    if (path.startsWith('/drive/v3')) {
      // alt=media는 메타데이터가 아니라 실제 파일 바이트를 받는 다운로드다
      if (u.searchParams.get('alt') === 'media') return { label: 'Google Drive · 다운로드', url: `${u.origin}${path}` }
      if (path.includes('/revisions')) return { label: 'Google Drive · 리비전', url: `${u.origin}${path}` }
      // /drive/v3/files/{id} → 파일 하나의 메타데이터 (getMeta·updateMeta·trash)
      if (/^\/drive\/v3\/files\/[^/]+$/.test(path)) return { label: 'Google Drive · 개별 메타 (파일별)', url: `${u.origin}${path}` }
      // /drive/v3/files (GET=목록 조회(listFiles·findFolder·findByName), POST=생성)
      if (path === '/drive/v3/files') {
        return {
          label: method === 'GET' ? 'Google Drive · 목록 조회 (1000개 단위)' : 'Google Drive · 생성',
          url: `${u.origin}${path}`
        }
      }
      return { label: `Google Drive · 기타 (${path})`, url: `${u.origin}${path}` }
    }
    return { label: `Google API · ${path}`, url: `${u.origin}${path}` }
  }
  if (u.hostname === 'oauth2.googleapis.com') return { label: 'Google 인증 · 토큰 해지', url: `${u.origin}${path}` }
  if (u.hostname.endsWith('googleusercontent.com')) return { label: 'Google 사용자 콘텐츠', url: `${u.origin}${path}` }
  return { label: `${u.hostname}${path}`, url: u.href }
}

function destOf(label: string): NetDest {
  let d = destMap.get(label)
  if (!d) {
    d = { label, down: 0, up: 0, requests: 0 }
    destMap.set(label, d)
  }
  return d
}

/** 한 요청의 바이트를 합계·로그·목적지 집계에 반영한다 */
function bump(entry: NetEntry, kind: 'up' | 'down', n: number) {
  if (!n) return
  if (kind === 'up') {
    entry.up += n
    stats.up += n
    destOf(entry.label).up += n
  } else {
    entry.down += n
    stats.down += n
    destOf(entry.label).down += n
  }
  scheduleNotify()
}

let installed = false

/** fetch를 감싸 세션 동안의 사용량을 센다. 여러 번 불러도 한 번만 감싼다 */
export function installNetMeter() {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return
  installed = true
  const orig = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const t0 = Date.now()
    const rawUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : String(input)
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase()

    let up = bodyBytes(init?.body)
    if (!up && typeof Request !== 'undefined' && input instanceof Request) {
      try {
        up = (await input.clone().arrayBuffer()).byteLength
      } catch {
        up = 0
      }
    }

    const { label, url } = labelFor(rawUrl, method)
    const entry: NetEntry = { id: ++seq, at: t0, method, label, url, up: 0, down: 0, status: null, ms: null, unknown: false }
    stats.requests++
    destOf(label).requests++
    log.unshift(entry)
    if (log.length > MAX_LOG) log.length = MAX_LOG
    if (up) bump(entry, 'up', up)
    scheduleNotify()

    let res: Response
    try {
      res = await orig(input, init)
    } catch (err) {
      entry.status = 0
      entry.ms = Date.now() - t0
      scheduleNotify()
      throw err
    }
    entry.status = res.status
    entry.ms = Date.now() - t0

    // Content-Length는 CORS 안전 헤더라 교차 출처 응답에서도 읽힌다 (압축된 전송 크기)
    const len = Number(res.headers.get('content-length') ?? NaN)
    if (Number.isFinite(len)) {
      bump(entry, 'down', len)
      return res
    }
    if (!res.body) {
      entry.unknown = true
      stats.unknown++
      scheduleNotify()
      return res
    }
    // 헤더가 없을 때만 본문을 복제해 세면서 넘긴다 (압축 해제된 크기 기준이라 과대 계상될 수 있음)
    const clone = res.clone()
    void (async () => {
      const reader = clone.body!.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) bump(entry, 'down', value.byteLength)
        }
      } catch {
        entry.unknown = true
        stats.unknown++
      } finally {
        scheduleNotify()
      }
    })()
    return res
  }
}
