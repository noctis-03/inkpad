// 마지막 동기화 스냅샷(base) 보관 — sync.ts(업로드·머지)와 unchanged.ts(되돌림 판정)가 함께 쓴다.
// sync.ts가 직접 들고 있으면 unchanged.ts를 쓰는 곳에서 순환 import가 생겨 분리했다.
import type { ID } from '../shared/model'
import { gunzipJson, gzipJson } from '../storage/compress'
import { getSync, putSync } from './folders'
import type { DocFileV1 } from './pack'

/** 마지막으로 맞춘 시점의 문서 스냅샷(머지의 base). gzip JSON blob을 syncState에 보관 */
export async function saveBase(docId: ID, file: DocFileV1) {
  await putSync(`base:${docId}`, { blob: await gzipJson(file) })
}

export async function loadBase(docId: ID): Promise<DocFileV1 | null> {
  const rec = await getSync<{ blob: Blob }>(`base:${docId}`)
  if (!rec?.blob) return null
  try {
    const file = await gunzipJson<DocFileV1>(rec.blob)
    return file?.kind === 'inkpad-doc' ? file : null
  } catch {
    return null
  }
}
