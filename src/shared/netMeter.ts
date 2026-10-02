// ── 디버깅용 네트워크 사용량 계량기 ────────────────────────────────
// 셀룰러 데이터 사용량 확인용. 브라우저는 Wi-Fi와 셀룰러를 구분할 수 없어
// 통합 수치만 센다. 페이지를 새로고침하거나 앱을 껐다 켜면 0으로 초기화된다
// (누적 저장하지 않음).
//
// 떼어 내는 방법:
//   1) 이 파일 삭제
//   2) main.tsx: installNetMeter import + 호출 삭제
//   3) SettingsPanel.tsx: NetUsageSection import + 렌더 한 줄 삭제
//   4) src/ui/NetUsageDebug.tsx 삭제 (styles.css의 .net-usage-* 규칙도 함께)
//
// 계측 대상: window.fetch로 나가는 요청/응답 바이트.
// 앱의 네트워크 트래픽(원본 지연 로딩·동기화 업/다운로드·토큰 교환)은 모두 fetch를 지난다.

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

const stats: NetStats = { down: 0, up: 0, requests: 0, unknown: 0, since: Date.now() }

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((f) => f())

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

/** 계량값을 0으로 되돌린다 (계량 시작 시각도 지금으로) */
export function resetNetStats() {
  stats.down = 0
  stats.up = 0
  stats.requests = 0
  stats.unknown = 0
  stats.since = Date.now()
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

let installed = false

/** fetch를 감싸 세션 동안의 사용량을 센다. 여러 번 불러도 한 번만 감싼다 */
export function installNetMeter() {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return
  installed = true
  const orig = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    stats.requests++
    let up = bodyBytes(init?.body)
    if (!up && typeof Request !== 'undefined' && input instanceof Request) {
      try {
        up = (await input.clone().arrayBuffer()).byteLength
      } catch {
        up = 0
      }
    }
    if (up) stats.up += up
    notify()

    const res = await orig(input, init)

    // Content-Length는 CORS 안전 헤더라 교차 출처 응답에서도 읽힌다 (압축된 전송 크기)
    const len = Number(res.headers.get('content-length') ?? NaN)
    if (Number.isFinite(len)) {
      stats.down += len
      notify()
      return res
    }
    if (!res.body) {
      stats.unknown++
      notify()
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
          if (value) stats.down += value.byteLength
        }
      } catch {
        stats.unknown++
      } finally {
        notify()
      }
    })()
    return res
  }
}
