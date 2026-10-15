// "이 노트를 받아야 하나" 판정 — 받기(pull)·받기 미리보기(planPull)·클라우드 노트 목록(listCloudNotes)의 단일 출처.
// 예전에는 세 곳에 같은 판정이 복사돼 서로 어긋났다(받기는 내용 표식을 보지 않고 같은 노트의 중복 파일도
// 혼자만 걸러서, 미리보기 목록과 실제로 받는 목록이 달랐다). Drive·DB를 모르는 순수 함수만 둔다 — 테스트용.
import type { RemoteFile } from './drive'
import type { FileRecord } from './folders'

/** Drive version 비교용 — int64 문자열이라 Number로는 정밀도를 잃는다. 없거나 깨졌으면 0으로 본다 */
export function verNum(v: string | undefined): bigint {
  try {
    return BigInt(v ?? 0)
  } catch {
    return 0n
  }
}

/**
 * 같은 docId의 살아 있는 파일이 여러 개면(폴더 재생성 직후 분기 등) 가장 최신 하나만 본다 —
 * 버전이 재시작한 파일끼리 비교해 되받기를 반복하거나, 목록에 같은 노트가 두 번 뜨는 일이 없게 한다.
 */
export function newestPerDoc(remotes: RemoteFile[]): RemoteFile[] {
  const byDoc = new Map<string, RemoteFile>()
  for (const r of remotes) {
    const docId = r.appProperties?.docId
    if (!docId) continue
    const cur = byDoc.get(docId)
    if (!cur || verNum(r.version) > verNum(cur.version) || (r.version === cur.version && r.modifiedTime > cur.modifiedTime)) byDoc.set(docId, r)
  }
  return [...byDoc.values()]
}

/**
 * (브랜치 이전 기록용) 이 기기가 그 원격 파일과 이미 맞춰져 있는가. 둘 중 하나라도 맞으면 맞춰진 것으로 본다.
 * 브랜치 상태(br:)가 없는 노트의 출발점을 정할 때만 쓴다 (knownBaseMid).
 *  - 위치 기록의 version이 원격 이상 (Drive version은 실제보다 뒤처져 보일 수 있어 '같거나 크면')
 *  - 원격 appProperties.updatedAt(이 앱이 올릴 때 직접 쓴 값)이 이 기기 노트의 updatedAt과 같음 —
 *    기록이 한 번 낡아도 스스로 바로잡힌다. 그래서 내용이 다른 업로드는 반드시 새 updatedAt을 달아야 한다
 *    (머지 결과는 mergedUpdatedAt으로 새 값을 받는다)
 */
export function isUpToDate(rec: FileRecord | undefined, local: { updatedAt: number } | undefined, remote: RemoteFile): boolean {
  // 기록한 파일과 다른 파일이면(폴더 재생성으로 새로 만들어져 version이 다시 시작) version 비교를 믿지 않는다
  if (rec && rec.fileId === remote.id && verNum(rec.version) >= verNum(remote.version)) return true
  const remoteUpdatedAt = Number(remote.appProperties?.updatedAt) || 0
  return !!local && remoteUpdatedAt > 0 && local.updatedAt === remoteUpdatedAt
}

/**
 * 노트 하나의 동기화 상태 (이 기기 기준, docs/branch-merge.md §3.1)
 *  - same: 최신 / pull: 받을 것(main으로 따라가기) / push: 올릴 것(올리면 main도 따라간다) /
 *  - diverged: 갈라짐 — 이 기기 변경(또는 main에 아직 안 들어간 내 브랜치)이 있는데 main도 내 출발점 이후 바뀌었다.
 *    받기로 덮지 않고, 올리기는 내 브랜치에만 올린다. 머지 관리에서 합친다.
 */
export type NoteSync = 'same' | 'pull' | 'push' | 'diverged'

export function noteSync(a: {
  /** 이 기기 변경이 올리기 대기 중 */
  pending: boolean
  /** 내 브랜치에 main에 아직 들어가지 않은 내용이 있다 (branch.ts isUnmerged) */
  unmerged: boolean
  /** 이 기기 출발점의 main 신원 (모르면 null) */
  baseMid: string | null
  /** 지금 main의 신원 (branch.ts mainMidOf) */
  mainMid: string
}): NoteSync {
  const moved = a.baseMid !== a.mainMid
  if (a.pending || a.unmerged) return moved ? 'diverged' : 'push'
  return moved ? 'pull' : 'same'
}

/**
 * 출발점 신원 — 브랜치 상태에 기록이 있으면 그것, 없으면(브랜치 이전에 맞춘 노트) 예전 판정으로 맞춰져 있을 때만
 * 지금 main을 출발점으로 본다. 모르면 null(→ 받을 것, 또는 이 기기 변경이 있으면 갈라짐 — 덮지 않는다).
 */
export function knownBaseMid(stateBaseMid: string | null | undefined, legacyUpToDate: boolean, mainMid: string): string | null {
  if (stateBaseMid) return stateBaseMid
  return legacyUpToDate ? mainMid : null
}

export type PullSkip = 'gone' | 'hidden' | 'trashed' | 'pending' | 'diverged' | 'same'

/** 받기에서 이 원격 노트를 건너뛰는 이유 (없으면 null = 받는다) */
export function pullSkipReason(a: {
  /** 이 기기에서 지운 노트(gone 표식) — 받기로 되살리지 않는다 (목록에서 개별 받기) */
  gone: boolean
  /** 숨긴 카테고리 — 이 기기는 받지 않는다 (클라우드 목록에는 표시) */
  hidden: boolean
  local: { deletedAt?: number } | undefined
  sync: NoteSync
}): PullSkip | null {
  if (a.gone) return 'gone'
  if (a.hidden) return 'hidden'
  if (a.local?.deletedAt) return 'trashed'
  if (a.sync === 'push') return 'pending' // 올리기가 맡는다
  if (a.sync === 'diverged') return 'diverged' // 덮지 않는다 — 머지 관리에서 합친다
  if (a.sync === 'same') return 'same'
  return null
}

/**
 * 머지 결과에 붙일 updatedAt — 두 쪽 어느 것과도 겹치지 않는 새 값.
 * 예전에는 max(이 기기, 원격)를 그대로 써서 머지 결과가 먼저 올린 기기의 노트와 updatedAt이 같았고,
 * 그 기기는 isUpToDate의 내용 표식 때문에 머지 결과를 '이미 맞춰짐'으로 보고 받지 못했다.
 * 기기 시계가 어긋나 원격 값이 미래여도 그보다 크게 잡는다.
 */
export function mergedUpdatedAt(ours: number, theirs: number, now: number): number {
  return Math.max(now, ours + 1, theirs + 1)
}
