// 노트 단위 3-way 머지 — base(마지막으로 맞춘 시점)·이 기기·원격 스냅샷을 합친다.
// 서로 다른 페이지·청크(필기 영역)는 양쪽이 모두 살고, 같은 청크를 양쪽에서
// 고쳤으면 원격을 우선한다(이 기기 편집은 Drive 리비전으로 남아 복구 가능).
import type { Block } from '../shared/model'
import type { DocFileV1 } from './pack'

const j = (v: unknown) => JSON.stringify(v)

export function mergeDocs(base: DocFileV1 | null, ours: DocFileV1, theirs: DocFileV1): { file: DocFileV1; conflicts: number } {
  let conflicts = 0

  // 문서 메타: 이 기기가 바꾼 필드는 ours, 원격이 바꿨으면 theirs
  const doc: DocFileV1['doc'] = { ...theirs.doc, id: ours.doc.id, updatedAt: Math.max(ours.doc.updatedAt, theirs.doc.updatedAt) }
  if (base) {
    if (ours.doc.title !== base.doc.title) doc.title = ours.doc.title
    if (ours.doc.category !== base.doc.category) doc.category = ours.doc.category
    else if (theirs.doc.category !== base.doc.category) doc.category = theirs.doc.category
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

  // 블록: 청크와 같은 3-way. 한쪽 파일에 blocks 필드 자체가 없으면(블록 기능 이전 클라이언트가 올린 파일)
  // 삭제로 해석하지 않고 반대쪽 블록을 유지한다. 머지 결과 페이지에 소속이 없는 블록은 버린다.
  const pageIdSet = new Set<string>(pages.map((pg) => pg.id))
  const blockMapOf = (list: Block[] | undefined) => new Map<string, Block>((list ?? []).map((b) => [b.id, b]))
  const oBlocks = blockMapOf(ours.blocks)
  const tBlocks = blockMapOf(theirs.blocks)
  const bBlocks = blockMapOf(base?.blocks)
  const blocks: Block[] = []
  if (ours.blocks !== undefined || theirs.blocks !== undefined) {
    for (const id of new Set<string>([...oBlocks.keys(), ...tBlocks.keys()])) {
      const o = oBlocks.get(id)
      const t = tBlocks.get(id)
      const bb = bBlocks.get(id)
      let chosen: Block | undefined
      if (o && t) {
        if (j(o) === j(t)) chosen = t
        else if (!bb || j(o) === j(bb)) chosen = t // 이 기기만 바꿈
        else if (j(t) === j(bb)) chosen = o // 원격만 바꿈
        else {
          chosen = t.updatedAt >= o.updatedAt ? t : o // 양쪽 다 다르면 updatedAt이 큰 쪽(같으면 theirs)
          conflicts++
        }
      } else if (o) {
        if (!bb) chosen = o // 이 기기의 새 블록
        // base에 있었는데 원격에 없다 → 원격이 지움 (tombstone이므로 이미 반영된다)
      } else if (t) {
        if (!bb) chosen = t // 원격의 새 블록
      }
      if (chosen && pageIdSet.has(chosen.pageId)) blocks.push(chosen)
    }
  }

  // 에셋: 유니언
  const assetIds = new Set<string>([...ours.assets.map((a) => a.id), ...theirs.assets.map((a) => a.id)])
  const assets = [...assetIds].map((id) => theirs.assets.find((a) => a.id === id) ?? ours.assets.find((a) => a.id === id)!)

  doc.category = doc.category ?? null // category 없는 옛 파일과의 머지 대비
  return { file: { kind: 'inkpad-doc', schemaVersion: 1, doc, pages, chunks, blocks, assets }, conflicts }
}
