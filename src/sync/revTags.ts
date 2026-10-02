// 리비전 표식 캐시 — Drive 리비전에는 커스텀 메타데이터가 없어서, 업로드할 때 기기명·태그를
// (1) 파일 내용 속 표식(DocFileV1.rev)과 (2) 기기 로컬 캐시(syncState)에 함께 남기고 버전 기록이 읽는다.
// 내용 속 표식은 리비전을 내려받아야 읽힌다(고정된 리비전만 다운로드 가능) → 로컬 캐시가 1차이고,
// 다른 기기가 올린 리비전은 고정됐을 때만 내려받아 채운다.
import * as drive from './drive'
import { getSync, putSync } from './folders'
import type { RevMarker } from './pack'

export interface RevTag {
  device?: string
  revKind?: RevMarker['kind']
  conflicts?: number
}

const tagKey = (fileId: string, revId: string) => `revTag:${fileId}:${revId}`

export const getCachedTag = (fileId: string, revId: string) => getSync<RevTag>(tagKey(fileId, revId))

export const putCachedTag = (fileId: string, revId: string, tag: RevTag) => putSync(tagKey(fileId, revId), tag)

/** 방금 올린 리비전(헤드)의 id를 찾아 표식을 기기 로컬에 기록한다. pin이면 그 리비전을 고정한다. */
export async function rememberRevTag(fileId: string, tag: RevTag, pin = false): Promise<void> {
  try {
    const revs = await drive.listRevisions(fileId)
    const newest = revs[revs.length - 1]
    if (!newest) return
    await putCachedTag(fileId, newest.id, tag)
    if (pin) await drive.setKeepForever(fileId, newest.id, true)
  } catch (e) {
    console.warn('[revTags] 리비전 표식 기록 실패 — 동기화는 계속됩니다:', e)
  }
}
