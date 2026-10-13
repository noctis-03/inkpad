// 열린 노트 보호 — 동기화·버전 되돌리기가 이 기기 DB의 노트 내용을 바꾸는 동안의 규칙.
//
// 편집 화면은 노트를 메모리(엔진)에 들고 있고, 바뀐 청크만 골라 DB에 쓴다. 그런데 동기화가
// DB만 바꾸고 편집 화면은 옛 내용을 계속 들고 있으면, 다음 저장 때 옛 내용 위에 그린 청크가
// 받아온 내용을 덮고, 다음 올리기는 그 차이를 "이 기기가 지운 것"으로 올린다(필기 유실).
//
// 그래서 노트 내용을 바꾸는 쪽은 모두 withDocExclusive(docId, fn) 안에서 바꾼다.
//  1. 다른 탭이 그 노트를 편집 중이면(편집 잠금) 건드리지 않고 DocBusyError — 그 탭을 닫은 뒤 다시
//  2. 이 탭의 편집 화면이 열고 있으면 입력을 막고 메모리의 변경을 모두 기록한 뒤 엔진을 내린다
//  3. fn이 DB를 바꾼다 (이 노트에 대한 작업은 한 번에 하나씩 — 순서대로 기다린다)
//  4. 편집 화면은 DB에서 다시 연다
// 읽기 전용 편집 화면(다른 탭이 편집 중이거나 뷰어로 연 경우)은 쓰지 않으므로 여기 등록하지 않고,
// 원격 변경 알림(REMOTE_EVENT)을 받으면 다시 연다.
import { isDocLockedElsewhere } from './tabLock'

export interface OpenDocHandle {
  /** 메모리에만 있는 변경을 기록한다 (올리기 직전 — 멈추지는 않는다) */
  flush(): Promise<void>
  /** 입력을 막고 메모리의 변경을 모두 기록한 뒤 엔진을 내린다. 기록에 실패하면 던진다(편집은 계속된다) */
  suspend(): Promise<void>
  /** DB에서 다시 연다 */
  resume(): void
}

export class DocBusyError extends Error {
  constructor() {
    super('다른 탭에서 편집 중인 노트입니다. 그 탭을 닫은 뒤 다시 시도해 주세요.')
    this.name = 'DocBusyError'
  }
}

const open = new Map<string, OpenDocHandle>()
/** 노트별 작업 줄 — 같은 노트를 바꾸는 작업은 앞의 작업이 끝날 때까지 기다린다 */
const queues = new Map<string, Promise<void>>()
const active = new Set<string>()

/** 편집 화면이 쓰기 가능한 엔진을 띄울 때 등록한다. 해제 함수를 돌려준다 */
export function registerOpenDoc(docId: string, handle: OpenDocHandle): () => void {
  open.set(docId, handle)
  return () => {
    if (open.get(docId) === handle) open.delete(docId)
  }
}

/** 이 탭의 편집 화면들이 메모리에 든 변경을 기록하게 한다 (올리기가 최신 내용을 읽도록) */
export async function flushOpenDocs(): Promise<void> {
  for (const [docId, h] of open) {
    if (active.has(docId)) continue
    try {
      await h.flush()
    } catch (e) {
      console.warn('[docGuard] 편집 내용 기록 실패 — 그 노트는 다음 올리기에 실린다:', docId, e)
    }
  }
}

/** 지금 그 노트가 보호 구간 안에 있는가 (applyDocFile의 안전 확인용) */
export function isDocExclusive(docId: string): boolean {
  return active.has(docId)
}

/** 그 노트를 바꾸는 작업이 모두 끝날 때까지 기다린다 (편집 화면이 DB에서 읽기 직전) */
export function whenDocIdle(docId: string): Promise<void> {
  return queues.get(docId) ?? Promise.resolve()
}

/**
 * 그 노트의 내용을 바꾸는 작업을 보호 구간 안에서 실행한다 (파일 머리 설명 참고).
 * 같은 노트에 대해 중첩해 부르면 안 된다(앞 작업을 기다리다 멈춘다) — 바깥에서 한 번만 감싼다.
 */
export async function withDocExclusive<T>(docId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(docId) ?? Promise.resolve()
  let done!: () => void
  const mine = new Promise<void>((r) => (done = r))
  const tail = prev.then(() => mine)
  queues.set(docId, tail)
  await prev
  try {
    if (await isDocLockedElsewhere(docId)) throw new DocBusyError()
    const h = open.get(docId)
    let suspended = false
    active.add(docId)
    try {
      if (h) {
        await h.suspend()
        suspended = true
      }
      return await fn()
    } finally {
      active.delete(docId)
      if (suspended) h!.resume()
    }
  } finally {
    done()
    if (queues.get(docId) === tail) queues.delete(docId)
  }
}
