// 로컬 참조 수집 — "이 기기가 참조하는 에셋"의 단일 출처 (구현.md 6.4).
// GC(원격 격리 판단, sync/gc.ts)와 apply.ts의 로컬 정리가 함께 쓴다.
// pack.ts의 packDocument와 같은 기준(페이지 원본 PDF + 청크의 이미지 요소)을 따르되,
// 문서 단위 로딩 대신 테이블을 한 번씩만 훑는다. 휴지통(deletedAt)·clouddel·gone 노트도
// 되살리거나 다시 올릴 수 있으므로 그대로 참조로 센다 — 판단이 애매하면 보호하는 편이 원칙이다.
import type { Element, ID } from '../shared/model'
import { gunzipJson } from '../storage/compress'
import { db } from '../storage/db'

/** 최근 생성 보호 기간 — 가져오기는 했지만 아직 요소가 확정되지 않은 에셋을 위한 유예 */
export const RECENT_ASSET_MS = 7 * 24 * 60 * 60 * 1000

/** 로컬의 모든 노트가 참조하는 assetId 집합 (휴지통 노트, clouddel 노트 포함) */
export async function collectLocalAssetIds(): Promise<Set<ID>> {
  const ids = new Set<ID>()

  // 페이지 원본 PDF — packDocument와 같은 기준
  await db.pages.each((p) => {
    if (p.pdf) ids.add(p.pdf.assetId)
  })

  // 청크의 이미지 요소 — data는 gzip(JSON Element[]).
  // 삭제 표식(deletedAt) 청크도 되살려질 수 있으므로 packDocument보다 넓게 센다 (보호 방향)
  const chunks = await db.chunks.toArray()
  for (const c of chunks) {
    try {
      const elements = await gunzipJson<Element[]>(c.data)
      for (const e of elements) {
        if (e.type === 'image') ids.add(e.assetId)
      }
    } catch {
      // 깨진 청크는 참조를 판단할 수 없다 — 에셋 행은 남긴다(보호). 정리 대상에서만 빠진다
    }
  }

  // outbox에서 에셋 업로드 대기 중인 것 — 아직 요소에 확정되지 않았지만 곧 참조된다
  for (const r of await db.outbox.toArray()) {
    if (r.entity === 'asset') ids.add(r.entityId as ID)
  }

  // 최근에 만든 에셋 행 — 요소 반영이 늦는 경우를 위한 보호
  const recentSince = Date.now() - RECENT_ASSET_MS
  await db.assets.each((a) => {
    if (a.createdAt >= recentSince) ids.add(a.id)
  })

  return ids
}

/** collectLocalAssetIds를 sha256으로 변환. db.assets 행이 없는 것은 unresolved로 센다 */
export async function collectLocalShaRefs(): Promise<{ shas: Set<string>; unresolved: number }> {
  const shas = new Set<string>()
  let unresolved = 0
  for (const id of await collectLocalAssetIds()) {
    const row = await db.assets.get(id)
    if (row) shas.add(row.sha256)
    else unresolved++
  }
  return { shas, unresolved }
}
