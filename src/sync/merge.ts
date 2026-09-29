// 노트 단위 3-way 머지 — base(마지막으로 맞춘 시점)·이 기기·원격 스냅샷을 합친다.
// 서로 다른 페이지·청크(필기 영역)는 양쪽이 모두 살고, 같은 청크를 양쪽에서
// 고쳤으면 원격을 우선한다(이 기기 편집은 Drive 리비전으로 남아 복구 가능).
import type { DocFileV1 } from './pack'

const j = (v: unknown) => JSON.stringify(v)

export function mergeDocs(base: DocFileV1 | null, ours: DocFileV1, theirs: DocFileV1): { file: DocFileV1; conflicts: number } {
  let conflicts = 0

  // 문서 메타: 이 기기가 바꾼 필드는 ours, 원격이 바꿨으면 theirs
  const doc: DocFileV1['doc'] = { ...theirs.doc, id: ours.doc.id, updatedAt: Math.max(ours.doc.updatedAt, theirs.doc.updatedAt) }
  if (base) {
    if (ours.doc.title !== base.doc.title) doc.title = ours.doc.title
    if (ours.doc.folderId !== base.doc.folderId) doc.folderId = ours.doc.folderId
    if (ours.doc.mode !== base.doc.mode) doc.mode = ours.doc.mode
    if (j(ours.doc.pageOrder) !== j(base.doc.pageOrder)) doc.pageOrder = ours.doc.pageOrder
    else if (j(theirs.doc.pageOrder) !== j(base.doc.pageOrder)) doc.pageOrder = theirs.doc.pageOrder
  }

  // 페이지: id 기준 유니언. base에 있었는데 한쪽에만 없으면 그쪽의 삭제를 따른다
  const pageOf = (list: DocFileV1['pages'], id: string) => list.find((p) => p.id === id)
  const pageIds = new Set<string>([...ours.pages.map((p) => p.id), ...theirs.pages.map((p) => p.id)])
  const pages: DocFileV1['pages'] = []
  for (const id of pageIds) {
    const o = pageOf(ours.pages, id)
    const t = pageOf(theirs.pages, id)
    const bb = base ? pageOf(base.pages, id) : undefined
    if (o && t) pages.push(t) // 정의가 같은 페이지 — 원격 우선
    else if (o) {
      if (!bb) pages.push(o) // 원격에 없지만 base에도 없었다 → 원격 삭제의 증거 없음, 유지
    } else if (t) {
      if (!bb) pages.push(t) // 원격이 새로 만든 페이지
    }
  }

  // 청크(필기 저장 단위): base와 비교해 한쪽만 바꿨으면 그쪽, 양쪽 다 바꿨으면 원격 우선
  const keyOf = (c: { pageId: string; key: string }) => `${c.pageId}|${c.key}`
  const baseEls = new Map<string, string>((base?.chunks ?? []).map((c) => [keyOf(c), j(c.elements)]))
  const oursMap = new Map(ours.chunks.map((c) => [keyOf(c), c]))
  const theirsMap = new Map(theirs.chunks.map((c) => [keyOf(c), c]))
  const chunks: DocFileV1['chunks'] = []
  for (const k of new Set<string>([...oursMap.keys(), ...theirsMap.keys()])) {
    const o = oursMap.get(k)
    const t = theirsMap.get(k)
    const bb = baseEls.get(k)
    if (o && t) {
      if (j(o.elements) === j(t.elements)) chunks.push(t)
      else if (bb === undefined || j(o.elements) === bb) chunks.push(t) // 이 기기만 바꿈
      else if (j(t.elements) === bb) chunks.push(o) // 원격만 바꿈
      else {
        chunks.push(t) // 양쪽에서 다르게 고침 — 원격 우선, 이 기기 편집은 리비전으로 복구
        conflicts++
      }
    } else if (o) {
      if (bb === undefined) chunks.push(o) // 이 기기의 새 청크
      // base에 있었는데 원격에 없다 → 원격이 지움 (버림)
    } else if (t) {
      if (bb === undefined) chunks.push(t) // 원격의 새 청크
      // base에 있었는데 이 기기에 없다 → 이 기기가 지움 (버림)
    }
  }

  // 에셋: 유니언
  const assetIds = new Set<string>([...ours.assets.map((a) => a.id), ...theirs.assets.map((a) => a.id)])
  const assets = [...assetIds].map((id) => theirs.assets.find((a) => a.id === id) ?? ours.assets.find((a) => a.id === id)!)

  return { file: { kind: 'inkpad-doc', schemaVersion: 1, doc, pages, chunks, assets }, conflicts }
}
