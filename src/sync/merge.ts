// 노트 단위 3-way 머지 — base(마지막으로 맞춘 시점)·이 기기(ours)·원격(theirs)을 합친다.
//
// 필기는 획(요소) ID 단위로 합친다. 페이지·청크 통째로 비교하면 같은 페이지에 두 기기가
// 서로 다른 줄을 써도 한쪽이 통째로 덮여 사라지기 때문이다.
//  - 한쪽만 바꾼 것은 그쪽을 따른다 (새로 그린 획은 살고, 지운 획은 지워진다)
//  - 같은 획을 양쪽에서 다르게 고쳤을 때만 충돌이다 → theirs 우선
//    (호출한 쪽이 인자 순서를 바꿔 '이 기기 우선'을 만든다)
//  - 획의 위치(pageId·청크 key)도 내용의 일부로 본다. 올가미로 다른 페이지·청크로 옮긴 획도
//    ID가 같으므로, 노트 전체를 한 번에 비교해야 옮긴 획이 두 군데 생기지 않는다.
//
// base가 없으면(동기화 기록이 지워진 경우 등) 한쪽에만 있는 획이 새로 그린 것인지 다른 쪽이
// 지운 것인지 알 수 없다. 이때는 양쪽 획을 모두 남기고 baseless로 알린다 — 지운 획이 되살아날
// 수는 있어도 필기가 사라지지는 않는다. 호출한 쪽은 baseless면 적용 전에 사용자에게 묻는다.
import type { Block, Element, ID, Page } from '../shared/model'
import type { DocFileV1 } from './pack'

const j = (v: unknown) => JSON.stringify(v)

export type MergeConflictKind = 'page' | 'chunk' | 'block'

/** 충돌 위치 — 확인 다이얼로그와 머지 기록이 읽는다. page는 pageId, chunk는 'pageId|key', block은 blockId */
export interface MergeConflictDetail {
  kind: MergeConflictKind
  id: string
}

export interface MergeResult {
  file: DocFileV1
  /** 충돌 위치 수 (= details.length). 같은 청크 안의 획 여러 개가 충돌해도 1곳으로 센다 */
  conflicts: number
  /** 덮여 쓰이는 충돌 위치 목록 — 양쪽에서 다르게 고친 것만 담는다(어느 쪽이 이기든 위치는 같다) */
  details: MergeConflictDetail[]
  /**
   * base 없이 합쳤고 양쪽 내용이 달랐다. 한쪽에만 있는 획·페이지·블록을 모두 남겼으므로
   * 한쪽에서 지운 것이 되살아날 수 있다 — 충돌이 0이어도 적용 전에 확인해야 한다.
   */
  baseless: boolean
}

/** 저장 위치가 붙은 요소 + 비교용 직렬화 */
interface Placed {
  pageId: ID
  key: string
  el: Element
  sig: string
}

function indexElements(chunks: DocFileV1['chunks']): Map<ID, Placed> {
  const out = new Map<ID, Placed>()
  for (const c of chunks) {
    for (const el of c.elements) out.set(el.id, { pageId: c.pageId, key: c.key, el, sig: j([c.pageId, c.key, el]) })
  }
  return out
}

/** base와 비교해 요소가 하나라도 바뀐(추가·삭제·수정·이동) 페이지 — 옛 위치와 새 위치 모두 */
function touchedPages(base: Map<ID, Placed>, side: Map<ID, Placed>): Set<ID> {
  const out = new Set<ID>()
  for (const [id, b] of base) {
    const s = side.get(id)
    if (!s || s.sig !== b.sig) {
      out.add(b.pageId)
      if (s) out.add(s.pageId)
    }
  }
  for (const [id, s] of side) if (!base.has(id)) out.add(s.pageId)
  return out
}

/** 페이지 정의 비교용 — 저장할 때마다 다시 찍히는 updatedAt·version은 내용이 아니다 */
const pageSig = (p: Page) => j({ ...p, updatedAt: 0, version: 0 })

const chunkId = (p: { pageId: ID; key: string }) => `${p.pageId}|${p.key}`

export function mergeDocs(base: DocFileV1 | null, ours: DocFileV1, theirs: DocFileV1): MergeResult {
  const details: MergeConflictDetail[] = []
  const seen = new Set<string>()
  const conflict = (kind: MergeConflictKind, id: string) => {
    const k = `${kind}:${id}`
    if (seen.has(k)) return
    seen.add(k)
    details.push({ kind, id })
  }
  /** base 없이 한쪽에만 있는 것을 남긴 수 — 하나라도 있으면 baseless */
  let oneSided = 0

  // ── 문서 메타: 이 기기가 바꾼 필드는 ours, 원격이 바꿨으면 theirs ──
  const doc: DocFileV1['doc'] = { ...theirs.doc, id: ours.doc.id, updatedAt: Math.max(ours.doc.updatedAt, theirs.doc.updatedAt) }
  if (base) {
    if (ours.doc.title !== base.doc.title) doc.title = ours.doc.title
    if (ours.doc.category !== base.doc.category) doc.category = ours.doc.category
    else if (theirs.doc.category !== base.doc.category) doc.category = theirs.doc.category
    if (ours.doc.mode !== base.doc.mode) doc.mode = ours.doc.mode
    if (j(ours.doc.pageOrder) !== j(base.doc.pageOrder)) doc.pageOrder = ours.doc.pageOrder
    else if (j(theirs.doc.pageOrder) !== j(base.doc.pageOrder)) doc.pageOrder = theirs.doc.pageOrder
  }

  const bEls = base ? indexElements(base.chunks) : new Map<ID, Placed>()
  const oEls = indexElements(ours.chunks)
  const tEls = indexElements(theirs.chunks)
  const oTouched = base ? touchedPages(bEls, oEls) : new Set<ID>()
  const tTouched = base ? touchedPages(bEls, tEls) : new Set<ID>()

  // ── 페이지 ──
  // 한쪽이 지운 페이지를 다른 쪽이 고쳤으면(정의 변경 또는 그 페이지에 필기) 충돌이다.
  // theirs가 지웠으면 지운 쪽을, ours가 지웠으면 theirs의 페이지를 통째로 되살린다(resurrected).
  const bPages = new Map((base?.pages ?? []).map((p) => [p.id, p]))
  const oPages = new Map(ours.pages.map((p) => [p.id, p]))
  const tPages = new Map(theirs.pages.map((p) => [p.id, p]))
  const pages: Page[] = []
  const resurrected = new Set<ID>()
  for (const id of new Set<ID>([...tPages.keys(), ...oPages.keys()])) {
    const o = oPages.get(id)
    const t = tPages.get(id)
    const bb = bPages.get(id)
    if (o && t) {
      if (pageSig(o) === pageSig(t)) pages.push(t)
      else if (bb && pageSig(o) === pageSig(bb)) pages.push(t) // 이 기기가 안 바꿈 → 원격
      else if (bb && pageSig(t) === pageSig(bb)) pages.push(o) // 원격이 안 바꿈 → 이 기기
      else {
        pages.push(t) // 양쪽에서 다르게 고침(또는 base 없이 다름) — theirs 우선
        conflict('page', id)
      }
    } else if (o) {
      if (!bb) {
        pages.push(o) // 이 기기의 새 페이지 (base가 없으면 남겨 둔다)
        if (!base) oneSided++
      } else if (pageSig(o) !== pageSig(bb) || oTouched.has(id)) conflict('page', id) // theirs가 지운 페이지를 이 기기가 고침 → theirs 우선(지움)
      // 그 밖: theirs가 지웠고 이 기기는 손대지 않음 → 지움
    } else if (t) {
      if (!bb) {
        pages.push(t) // 원격의 새 페이지
        if (!base) oneSided++
      } else if (pageSig(t) !== pageSig(bb) || tTouched.has(id)) {
        pages.push(t) // 이 기기가 지운 페이지를 원격이 고침 → theirs 우선(되살림)
        resurrected.add(id)
        conflict('page', id)
      }
      // 그 밖: 이 기기가 지웠고 원격은 손대지 않음 → 지움
    }
  }
  const live = new Set<ID>(pages.map((p) => p.id))

  // pageOrder를 실제로 살아남은 페이지 집합과 맞춘다.
  // 한쪽 pageOrder만 남기면 두 기기가 서로 다른 페이지를 동시에 추가했을 때
  // applySnapshot → layout.setPages에서 페이지가 통째로 사라진다(페이지 유실).
  {
    const prevOrder = Array.isArray(doc.pageOrder) ? doc.pageOrder : []
    const order = prevOrder.filter((id) => live.has(id))
    for (const p of pages) if (!order.includes(p.id)) order.push(p.id)
    doc.pageOrder = order
  }

  // ── 필기 요소: 획 ID 단위 3-way ──
  // 충돌 위치는 살아남은 일반 페이지에서만 센다 — 지워지거나 되살린 페이지는 위의 페이지 충돌 1곳으로 이미 셌다
  const elementConflict = (p: Placed) => {
    if (live.has(p.pageId) && !resurrected.has(p.pageId)) conflict('chunk', chunkId(p))
  }
  const chosen: Placed[] = []
  for (const id of new Set<ID>([...tEls.keys(), ...oEls.keys(), ...bEls.keys()])) {
    const o = oEls.get(id)
    const t = tEls.get(id)
    const b = bEls.get(id)
    let pick: Placed | undefined
    if (t && resurrected.has(t.pageId)) pick = t // 되살린 페이지의 획은 theirs 그대로
    else if (o && t) {
      if (o.sig === t.sig) pick = t
      else if (b && o.sig === b.sig) pick = t // 이 기기는 그대로, 원격이 고침
      else if (b && t.sig === b.sig) pick = o // 원격은 그대로, 이 기기가 고침
      else {
        pick = t // 같은 획을 양쪽에서 다르게 고침 — theirs 우선
        elementConflict(t)
      }
    } else if (o) {
      if (!b) {
        pick = o // 이 기기가 새로 그린 획
        if (!base) oneSided++
      } else if (o.sig !== b.sig) elementConflict(o) // 원격이 지운 획을 이 기기가 고침 → theirs 우선(지움)
      // 그 밖: 원격이 지움 → 지움
    } else if (t) {
      if (!b) {
        pick = t // 원격이 새로 그린 획
        if (!base) oneSided++
      } else if (t.sig !== b.sig) {
        pick = t // 이 기기가 지운 획을 원격이 고침 → theirs 우선(남김)
        elementConflict(t)
      }
      // 그 밖: 이 기기가 지움 → 지움
    }
    if (pick && live.has(pick.pageId)) chosen.push(pick)
  }

  // 청크로 다시 묶는다. 안쪽 순서는 엔진의 저장 순서(획을 z순, 그 밖의 요소는 뒤)와 같게 —
  // 같은 z(두 기기가 각자 매긴 값)는 ID로 순서를 고정해 머지 결과가 늘 같게 한다
  const groups = new Map<string, { pageId: ID; key: string; elements: Element[] }>()
  for (const p of chosen) {
    const k = chunkId(p)
    let g = groups.get(k)
    if (!g) groups.set(k, (g = { pageId: p.pageId, key: p.key, elements: [] }))
    g.elements.push(p.el)
  }
  const rank = (e: Element) => (e.type === 'stroke' ? 0 : 1)
  const chunks: DocFileV1['chunks'] = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, g]) => ({
      ...g,
      elements: g.elements.sort((a, b) => rank(a) - rank(b) || a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }))

  // ── 블록: 같은 3-way ──
  // 한쪽 파일에 blocks 필드 자체가 없으면(블록 기능 이전 클라이언트가 올린 파일) 삭제로 해석하지 않고
  // 반대쪽 블록을 통째로 유지한다. 머지 결과 페이지에 소속이 없는 블록은 버린다.
  const filterLive = (list: Block[]) => list.filter((b) => live.has(b.pageId))
  let blocks: Block[] | undefined
  if (ours.blocks === undefined && theirs.blocks === undefined) {
    blocks = undefined // 양쪽 다 블록 기능 이전 파일 → 결과에도 blocks를 남기지 않는다(apply가 로컬 블록을 지우지 않게)
  } else if (theirs.blocks === undefined) {
    blocks = filterLive(ours.blocks!) // 원격이 옛 클라이언트가 올린 파일 → 이 기기 블록을 유지
  } else if (ours.blocks === undefined) {
    blocks = filterLive(theirs.blocks) // 이 기기가 옛 클라이언트 → 원격 블록을 유지
  } else {
    const blockMapOf = (list: Block[] | undefined) => new Map<string, Block>((list ?? []).map((b) => [b.id, b]))
    const oBlocks = blockMapOf(ours.blocks)
    const tBlocks = blockMapOf(theirs.blocks)
    const bBlocks = blockMapOf(base?.blocks)
    const merged: Block[] = []
    for (const id of new Set<string>([...oBlocks.keys(), ...tBlocks.keys()])) {
      const o = oBlocks.get(id)
      const t = tBlocks.get(id)
      const bb = bBlocks.get(id)
      let chosenBlock: Block | undefined
      if (o && t) {
        if (j(o) === j(t)) chosenBlock = t
        else if (bb && j(o) === j(bb)) chosenBlock = t // 이 기기만 그대로
        else if (bb && j(t) === j(bb)) chosenBlock = o // 원격만 그대로
        else {
          chosenBlock = t.updatedAt >= o.updatedAt ? t : o // 양쪽 다 다르면 updatedAt이 큰 쪽(같으면 theirs)
          conflict('block', id)
        }
      } else if (o) {
        if (!bb) {
          chosenBlock = o // 이 기기의 새 블록
          if (!base) oneSided++
        }
        // base에 있었는데 원격에 없다 → 원격이 지움 (tombstone이므로 이미 반영된다)
      } else if (t) {
        if (!bb) {
          chosenBlock = t // 원격의 새 블록
          if (!base) oneSided++
        }
      }
      if (chosenBlock && live.has(chosenBlock.pageId)) merged.push(chosenBlock)
    }
    blocks = merged
  }

  // ── 에셋: 유니언 ──
  const assetIds = new Set<string>([...ours.assets.map((a) => a.id), ...theirs.assets.map((a) => a.id)])
  const assets = [...assetIds].map((id) => theirs.assets.find((a) => a.id === id) ?? ours.assets.find((a) => a.id === id)!)

  doc.category = doc.category ?? null // category 없는 옛 파일과의 머지 대비
  return {
    file: { kind: 'inkpad-doc', schemaVersion: 1, doc, pages, chunks, ...(blocks ? { blocks } : {}), assets },
    conflicts: details.length,
    details,
    baseless: !base && (details.length > 0 || oneSided > 0)
  }
}
