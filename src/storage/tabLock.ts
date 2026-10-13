// 같은 문서를 두 탭에서 열면 나중에 연 탭은 읽기 전용 (16.4)
//
// 브라우저의 Web Locks(navigator.locks)로 잠근다. 예전에는 BroadcastChannel로 "누가 열고 있니?"를
// 묻고 250ms 안에 대답이 없으면 잠금을 가져갔는데, iPad가 뒤쪽 탭을 얼려 대답하지 못하거나
// 두 탭이 동시에 물으면 두 탭이 모두 편집할 수 있었다. Web Locks는 브라우저가 한 탭에만 주고,
// 탭이 닫히거나 죽으면 저절로 풀린다.
const PREFIX = 'inkpad-doc:'

/** 이 탭이 쥔 잠금 — 같은 탭에서 같은 노트를 닫자마자 다시 열어도 잠금을 놓쳤다 다시 잡지 않게 센다 */
const held = new Map<string, { count: number; release: () => void }>()

const locksApi = (): LockManager | undefined => (typeof navigator !== 'undefined' ? navigator.locks : undefined)

/**
 * 편집 잠금. 다른 탭이 이미 열고 있으면 false.
 * readOnly(뷰어보드)로 열면 애초에 잠그지 않는다 — 편집할 수 없으니 다른 탭의 편집도 막지 않는다.
 * 읽기 전용 판정은 이 한 곳(!lock)에서만 나온다 (탭 충돌 · 뷰어보드 공통 경로).
 * timeoutMs: 잠금이 풀리기를 기다리는 시간 — 같은 탭에서 방금 놓은 잠금이 풀리는 동안만 기다린다.
 */
export function acquireDocLock(doc: string, opts?: { readOnly?: boolean; timeoutMs?: number }): Promise<boolean> {
  if (opts?.readOnly) return Promise.resolve(false) // 읽기 전용 — 잠금 없음
  const mine = held.get(doc)
  if (mine) {
    mine.count++
    return Promise.resolve(true)
  }
  const locks = locksApi()
  if (!locks) return Promise.resolve(true) // Web Locks가 없는 옛 브라우저 — 막을 방법이 없다
  const timeoutMs = opts?.timeoutMs ?? 400
  return new Promise<boolean>((resolve) => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    locks
      .request(PREFIX + doc, { signal: ac.signal }, () => {
        clearTimeout(timer)
        // 이 약속이 풀릴 때까지 잠금을 쥔다 (releaseDocLock)
        return new Promise<void>((release) => {
          held.set(doc, { count: 1, release })
          resolve(true)
        })
      })
      .catch(() => {
        // AbortError — 기다리는 동안 다른 탭이 놓지 않았다
        clearTimeout(timer)
        resolve(false)
      })
  })
}

export function releaseDocLock(doc: string) {
  const h = held.get(doc)
  if (!h) return
  if (--h.count > 0) return
  held.delete(doc)
  h.release()
}

/** 다른 탭이 그 노트를 편집 중인가 (이 탭이 쥔 잠금은 빼고) */
export async function isDocLockedElsewhere(doc: string): Promise<boolean> {
  if (held.has(doc)) return false
  const locks = locksApi()
  if (!locks?.query) return false
  try {
    const snap = await locks.query()
    return !!snap.held?.some((l) => l.name === PREFIX + doc)
  } catch {
    return false
  }
}
