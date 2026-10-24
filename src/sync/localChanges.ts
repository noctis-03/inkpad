// 이 기기에서 바꾼 것 — 마지막으로 맞춘 시점의 노트(기준본 base) 대비. 네트워크를 쓰지 않는다.
// 받기로 덮기·변경 버리기·클라우드에 맞추기 전에 "지금 쓴 것이 무엇인지" 보여 주는 비교 화면이 쓴다.
// 머지 엔진의 분류를 그대로 쓴다: main = 기준본, 브랜치 = 이 기기 노트.
//   브랜치에만 = 이 기기에서 새로 쓴 것(덮으면 사라짐) · main에만 = 이 기기에서 지운 것(덮으면 돌아옴) · 다름 = 고친 것
import type { ID } from '../shared/model'
import { loadBase } from './base'
import { computeModified } from './branch'
import { classify, type MergePlan } from './merge'
import { packDocument, type DocFileV1 } from './pack'

export interface LocalChanges {
  base: DocFileV1
  local: DocFileV1
  plan: MergePlan
  /** 새로 쓴 획 */
  added: number
  /** 지운 획 */
  removed: number
  /** 옮기거나 색을 바꾼 획 */
  modified: number
  /** 페이지·블록·제목 등 그 밖의 바뀐 것 (문서는 제목·카테고리) */
  other: number
  total: number
  /** 센 단위 — 노트는 획, 문서(text 모드)는 블록 */
  unit: '획' | '블록'
}

/** 기준본이 없으면(한 번도 맞춘 적 없는 노트) null */
export async function localChanges(docId: ID): Promise<LocalChanges | null> {
  const base = await loadBase(docId)
  if (!base) return null
  const local = await packDocument(docId)
  const plan = classify(base, local, { modified: computeModified(base, local), hasBase: true, prefer: 'branch' })
  if (local.doc.mode === 'text') {
    // 문서(text 모드)는 블록으로 센다 — 지운 블록은 지운 표식(deletedAt)이 남아 '양쪽에 있는데 다름'으로 분류된다
    let added = 0
    let removed = 0
    let modified = 0
    for (const i of plan.items) {
      if (i.kind !== 'tblock' || i.cls === 'common') continue
      const m = i.main as { deletedAt?: number } | undefined
      const l = i.branch as { deletedAt?: number } | undefined
      if ((!m || m.deletedAt) && (!l || l.deletedAt)) continue // 맞춘 뒤 만들었다 지운 블록 — 보일 것이 없다
      if (i.cls === 'branchOnly' || (m?.deletedAt && !l?.deletedAt)) added++
      else if (i.cls === 'mainOnly' || (l?.deletedAt && !m?.deletedAt)) removed++
      else modified++
    }
    const other = plan.meta.length
    return { base, local, plan, added, removed, modified, other, total: added + removed + modified + other, unit: '블록' }
  }
  const added = plan.counts.branchOnly
  const removed = plan.counts.mainOnly
  const modified = plan.counts.modified
  const other = plan.items.filter((i) => i.kind !== 'el' && i.cls !== 'common').length + plan.meta.length
  return { base, local, plan, added, removed, modified, other, total: added + removed + modified + other, unit: '획' }
}
