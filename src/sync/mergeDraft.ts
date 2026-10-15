// 머지 작업본 저장 — 머지 화면에서 한 일(버림·쪽 바꿈·옮김·색)을 이 기기에 남겨, 화면을 닫거나 앱이 꺼져도 이어서 한다.
// syncState(기기 로컬 KV)에 `mergeDraft:{docId}@{브랜치 기기 ID}`로 둔다. 다른 기기로는 가지 않는다.
// 작업본은 연 순간의 입력(main 신원·브랜치 seq)을 함께 적어 둔다 — 다시 열 때 입력이 바뀌었으면
// 항목 키로 새 입력에 다시 얹고(sync/merge.ts retainDraft) 그렇게 했다고 알린다.
import type { ID } from '../shared/model'
import { db } from '../storage/db'
import { getSync, putSync } from './folders'
import { draftFromJson, draftToJson, isEmptyDraft, type MergeDraft, type MergeDraftJson } from './merge'

interface SavedDraft {
  mainMid: string
  branchSeq: number
  at: number
  draft: MergeDraftJson
}

const PREFIX = 'mergeDraft:'
const keyOf = (docId: ID, deviceId: string) => `${PREFIX}${docId}@${deviceId}`

/** 저장한다 — 빈 작업본이면 지운다 */
export async function saveMergeDraft(docId: ID, deviceId: string, input: { mainMid: string; branchSeq: number }, draft: MergeDraft): Promise<void> {
  if (isEmptyDraft(draft)) return deleteMergeDraft(docId, deviceId)
  await putSync(keyOf(docId, deviceId), { ...input, at: Date.now(), draft: draftToJson(draft) } satisfies SavedDraft)
}

export async function loadMergeDraft(docId: ID, deviceId: string): Promise<{ draft: MergeDraft; mainMid: string; branchSeq: number; at: number } | null> {
  const s = await getSync<SavedDraft>(keyOf(docId, deviceId))
  if (!s?.draft) return null
  return { draft: draftFromJson(s.draft), mainMid: s.mainMid, branchSeq: s.branchSeq, at: s.at }
}

export async function deleteMergeDraft(docId: ID, deviceId: string): Promise<void> {
  await db.syncState.delete(keyOf(docId, deviceId))
}

/** 작업본이 있는 머지들 — '{docId}@{기기 ID}' (머지 관리 목록의 '작업 중' 표시) */
export async function mergeDraftKeys(): Promise<Set<string>> {
  const keys = await db.syncState.where('key').startsWith(PREFIX).primaryKeys()
  return new Set(keys.map((k) => String(k).slice(PREFIX.length)))
}
