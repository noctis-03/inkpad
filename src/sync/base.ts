// 마지막 동기화 스냅샷(base) 보관 — sync.ts(업로드·머지)와 unchanged.ts(되돌림 판정)가 함께 쓴다.
// sync.ts가 직접 들고 있으면 unchanged.ts를 쓰는 곳에서 순환 import가 생겨 분리했다.
import type { ID } from '../shared/model'
import { gunzipJson, gzipJson } from '../storage/compress'
import { getSync, putSync } from './folders'
import type { DocFileV1 } from './pack'

interface BaseRecord {
  blob: Blob
  /** 저장 시각 — 요약 캐시(baseSummary)의 열쇠. 옛 기록엔 없다 */
  savedAt?: number
}

/** 마지막으로 맞춘 시점의 문서 스냅샷(머지의 base). gzip JSON blob을 syncState에 보관 */
export async function saveBase(docId: ID, file: DocFileV1) {
  await putBaseBlob(docId, await gzipJson(file))
}

/** 이미 gzip한 스냅샷을 base로 저장한다 (올리기 직후 markSynced) */
export async function putBaseBlob(docId: ID, blob: Blob) {
  await putSync(`base:${docId}`, { blob, savedAt: Date.now() } satisfies BaseRecord)
}

export async function loadBase(docId: ID): Promise<DocFileV1 | null> {
  const rec = await getSync<BaseRecord>(`base:${docId}`)
  if (!rec?.blob) return null
  return decodeBase(rec.blob)
}

async function decodeBase(blob: Blob): Promise<DocFileV1 | null> {
  try {
    const file = await gunzipJson<DocFileV1>(blob)
    return file?.kind === 'inkpad-doc' ? file : null
  } catch {
    return null
  }
}

/**
 * 스냅샷의 요약 — 페이지 순서, 청크별 요소 수, 블록 수. 내용이 같으려면 요약부터 같아야 한다(필요조건).
 * 되돌리기 판정(unchanged.ts)이 압축을 풀지 않고 먼저 걸러 내는 데 쓴다.
 */
export function summarize(order: readonly string[], chunks: Iterable<[key: string, count: number]>, blocks: number): string {
  const list = [...chunks].filter(([, n]) => n > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify([order, list, blocks])
}

const summaryCache = new Map<ID, { key: string; summary: string }>()

/** base의 요약. 같은 base면 다시 풀지 않는다 (base는 동기화 때만 바뀐다). 없으면 null */
export async function baseSummary(docId: ID): Promise<string | null> {
  const rec = await getSync<BaseRecord>(`base:${docId}`)
  if (!rec?.blob) {
    summaryCache.delete(docId)
    return null
  }
  const key = `${rec.savedAt ?? 0}:${rec.blob.size}`
  const hit = summaryCache.get(docId)
  if (hit?.key === key) return hit.summary
  const file = await decodeBase(rec.blob)
  if (!file) return null
  const summary = summarize(
    file.doc.pageOrder,
    file.chunks.map((c) => [`${c.pageId}|${c.key}`, c.elements.length] as [string, number]),
    file.blocks?.length ?? 0
  )
  summaryCache.set(docId, { key, summary })
  return summary
}
