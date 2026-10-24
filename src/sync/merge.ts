// 브랜치 머지 — main과 기기 브랜치 하나를 합친다 (설계: docs/branch-merge.md §4). 순수 함수만 둔다(테스트: npm run test:merge).
//
//  - 머지에는 삭제가 없다(모두 살리기): 어느 한쪽에라도 있는 획·페이지·블록은 결과에 남는다.
//    한쪽에서 지운 것이 되살아나는 것은 감수한다 — 머지 화면에서 버리거나, 머지 뒤 지우고 다시 올린다.
//  - 양쪽에 있는데 내용이 다르면(옮김·색·속지·제목…) 브랜치의 '고친 목록'(sync/branch.ts computeModified)으로 누가 고쳤는지 가린다:
//      브랜치 목록에 없음 → 브랜치는 출발점 그대로 → main 쪽이 고친 것 → main
//      있고 main 해시 = 고치기 전 해시 → 브랜치만 고친 것 → 브랜치
//      있고 다르면 → 양쪽이 고침 → 머지하는 기기 쪽(prefer)
//    출발점 없이 올린 브랜치(baseMid 없음)는 누가 고쳤는지 알 수 없어 모두 '양쪽 고침'으로 본다.
//  - 획의 위치(페이지·청크)도 내용의 일부라, 다른 페이지로 옮긴 획도 ID가 같아 두 군데 생기지 않는다.
//
//  - 문서(text 모드)의 블록(tblock)은 예외로 지운 것을 따른다: 한쪽만 손댔는데 그게 지운 것이면 지운다
//    (문단을 지웠는데 머지마다 되살아나면 문서가 엉망이 된다). 한쪽은 고치고 한쪽은 지웠으면 살린다(고친 내용을 잃지 않게).
//    순서는 블록의 순서 키(pos)로 정해지므로 양쪽이 따로 끼워 넣은 블록도 자리를 찾는다.
//
// classify가 항목마다 분류(레이어)와 기본 선택을 정하고, compose가 사용자의 작업본(버린 것·반대쪽으로 바꾼 것)을
// 얹어 결과 노트를 만든다. 머지 화면은 classify 결과로 레이어를 그린다.
import type { Block, Element, ID, Page, TextBlock } from '../shared/model'
// 확장자를 붙여 부른다 — 이 모듈은 브라우저 없이 node 테스트(tools/verify/merge-test.ts)에서도 그대로 돈다
import { blockSig, elementSig, pageSig, shortHash, textBlockSig } from './branch.ts'
import { mergedUpdatedAt } from './judge.ts'
import type { DocFileV1 } from './pack'

export type Side = 'main' | 'branch'
/** 레이어 — 공통 / main에만 / 브랜치에만 / 양쪽에 있는데 내용이 다름 */
export type ItemClass = 'common' | 'mainOnly' | 'branchOnly' | 'modified'
export type ItemKind = 'el' | 'page' | 'block' | 'tblock'

export interface Placed {
  pageId: ID
  key: string
  el: Element
}

export interface MergeItem {
  /** 'el:{id}' | 'page:{id}' | 'block:{id}' | 'tblock:{id}' — 작업본이 이 키로 항목을 가리킨다 */
  key: string
  kind: ItemKind
  id: ID
  cls: ItemClass
  /** 기본으로 쓰는 쪽 (한쪽에만 있으면 그쪽, 내용이 다르면 고침 규칙) */
  pick: Side
  /** 양쪽이 다 고쳤다 (modified일 때만) — pick은 머지하는 기기 쪽 */
  both?: boolean
  main?: Placed | Page | Block | TextBlock
  branch?: Placed | Page | Block | TextBlock
}

export type MetaField = 'title' | 'category' | 'mode' | 'pageOrder'

/** 문서 정보 중 양쪽 값이 다른 것 */
export interface MetaItem {
  key: `doc:${MetaField}`
  field: MetaField
  main: unknown
  branch: unknown
  pick: Side
  both: boolean
}

export interface MergePlan {
  items: MergeItem[]
  meta: MetaItem[]
  /** 획(요소)만 센 레이어별 개수 — 목록·레이어 패널 표시용 */
  counts: Record<ItemClass, number>
  /** 고친 요소 중 양쪽이 다 고친 수 */
  bothCount: number
}

/**
 * 사용자의 작업본 — 머지 화면에서 한 일. 항목은 키('el:{id}' 등)로 가리키므로, 입력(main·브랜치)이 새 판으로 바뀌어도
 * 같은 키가 있으면 그대로 다시 얹힌다.
 */
export interface MergeDraft {
  /** 버린 항목 (공통 항목은 버릴 수 없다) */
  discard: Set<string>
  /** 기본 선택의 반대쪽을 쓰기로 한 항목 (고친 것·문서 정보) */
  flip: Set<string>
  /** 옮긴 획 — 페이지(무한 캔버스는 월드) 좌표의 이동량. 여러 번 옮기면 더해진다 */
  move: Map<string, { dx: number; dy: number }>
  /** 색을 바꾼 획 */
  color: Map<string, string>
}

export const emptyDraft = (): MergeDraft => ({ discard: new Set(), flip: new Set(), move: new Map(), color: new Map() })

/** 작업본을 저장 가능한 모양으로 (Set·Map → 배열) */
export interface MergeDraftJson {
  discard: string[]
  flip: string[]
  move: [string, { dx: number; dy: number }][]
  color: [string, string][]
}
export const draftToJson = (d: MergeDraft): MergeDraftJson => ({ discard: [...d.discard], flip: [...d.flip], move: [...d.move], color: [...d.color] })
export const draftFromJson = (j: Partial<MergeDraftJson> | undefined): MergeDraft => ({
  discard: new Set(j?.discard ?? []),
  flip: new Set(j?.flip ?? []),
  move: new Map(j?.move ?? []),
  color: new Map(j?.color ?? [])
})

/** 작업본에서 이 계획에 없는 항목을 뺀다 — 입력이 새 판으로 바뀌었을 때 다시 얹기 */
export function retainDraft(d: MergeDraft, plan: MergePlan): MergeDraft {
  const keys = new Set<string>([...plan.items.map((i) => i.key), ...plan.meta.map((m) => m.key)])
  return {
    discard: new Set([...d.discard].filter((k) => keys.has(k))),
    flip: new Set([...d.flip].filter((k) => keys.has(k))),
    move: new Map([...d.move].filter(([k]) => keys.has(k))),
    color: new Map([...d.color].filter(([k]) => keys.has(k)))
  }
}

export const isEmptyDraft = (d: MergeDraft) => !d.discard.size && !d.flip.size && !d.move.size && !d.color.size

const j = (v: unknown) => JSON.stringify(v)
const other = (s: Side): Side => (s === 'main' ? 'branch' : 'main')

function indexElements(file: DocFileV1): Map<ID, Placed> {
  const out = new Map<ID, Placed>()
  for (const c of file.chunks) for (const el of c.elements) out.set(el.id, { pageId: c.pageId, key: c.key, el })
  return out
}

export function classify(
  main: DocFileV1,
  branch: DocFileV1,
  opts: {
    /** 브랜치의 고친 목록 (BranchMarker.modified) */
    modified: Record<string, string>
    /** 브랜치가 출발점을 알고 올렸는가 (baseMid가 있었나) — 모르면 내용이 다른 것은 모두 양쪽 고침 */
    hasBase: boolean
    /** 양쪽이 다 고쳤을 때 쓰는 쪽 — 머지하는 기기가 브랜치 기기면 'branch', 아니면 'main' */
    prefer: Side
  }
): MergePlan {
  /** 같은 키의 내용이 다를 때 누가 고쳤나 */
  const decide = (key: string, mainSig: string): { pick: Side; both: boolean } => {
    if (!opts.hasBase) return { pick: opts.prefer, both: true }
    const baseHash = opts.modified[key]
    if (baseHash === undefined) return { pick: 'main', both: false }
    if (shortHash(mainSig) === baseHash) return { pick: 'branch', both: false }
    return { pick: opts.prefer, both: true }
  }
  const items: MergeItem[] = []
  const counts: Record<ItemClass, number> = { common: 0, mainOnly: 0, branchOnly: 0, modified: 0 }
  let bothCount = 0

  // ── 페이지 ──
  const mPages = new Map(main.pages.map((p) => [p.id, p]))
  const bPages = new Map(branch.pages.map((p) => [p.id, p]))
  for (const id of new Set<ID>([...mPages.keys(), ...bPages.keys()])) {
    const m = mPages.get(id)
    const b = bPages.get(id)
    const key = 'page:' + id
    if (m && b) {
      const ms = pageSig(m)
      if (ms === pageSig(b)) items.push({ key, kind: 'page', id, cls: 'common', pick: 'main', main: m, branch: b })
      else items.push({ key, kind: 'page', id, cls: 'modified', ...decide(key, ms), main: m, branch: b })
    } else if (m) items.push({ key, kind: 'page', id, cls: 'mainOnly', pick: 'main', main: m })
    else items.push({ key, kind: 'page', id, cls: 'branchOnly', pick: 'branch', branch: b })
  }

  // ── 필기 요소 ──
  const mEls = indexElements(main)
  const bEls = indexElements(branch)
  for (const id of new Set<ID>([...mEls.keys(), ...bEls.keys()])) {
    const m = mEls.get(id)
    const b = bEls.get(id)
    const key = 'el:' + id
    let item: MergeItem
    if (m && b) {
      const ms = elementSig(m.pageId, m.key, m.el)
      if (ms === elementSig(b.pageId, b.key, b.el)) item = { key, kind: 'el', id, cls: 'common', pick: 'main', main: m, branch: b }
      else {
        const d = decide(key, ms)
        item = { key, kind: 'el', id, cls: 'modified', ...d, main: m, branch: b }
        if (d.both) bothCount++
      }
    } else if (m) item = { key, kind: 'el', id, cls: 'mainOnly', pick: 'main', main: m }
    else item = { key, kind: 'el', id, cls: 'branchOnly', pick: 'branch', branch: b }
    items.push(item)
    counts[item.cls]++
  }

  // ── 블록 ──
  // 블록은 지울 때 삭제 표식(deletedAt)을 남긴다. 머지에는 삭제가 없으므로 한쪽만 지웠으면 살아 있는 쪽을 쓴다.
  // 블록 기능 이전 앱이 올린 파일(blocks 필드 없음)은 '블록 없음'이 아니라 '모름'이라 반대쪽을 그대로 쓴다.
  const mBlocks = new Map((main.blocks ?? []).map((b) => [b.id, b]))
  const bBlocks = new Map((branch.blocks ?? []).map((b) => [b.id, b]))
  for (const id of new Set<ID>([...mBlocks.keys(), ...bBlocks.keys()])) {
    const m = mBlocks.get(id)
    const b = bBlocks.get(id)
    const key = 'block:' + id
    if (m && b) {
      const ms = blockSig(m)
      if (ms === blockSig(b)) items.push({ key, kind: 'block', id, cls: 'common', pick: 'main', main: m, branch: b })
      else if (!!m.deletedAt !== !!b.deletedAt) items.push({ key, kind: 'block', id, cls: 'modified', pick: m.deletedAt ? 'branch' : 'main', both: false, main: m, branch: b })
      else items.push({ key, kind: 'block', id, cls: 'modified', ...decide(key, ms), main: m, branch: b })
    } else if (m) items.push({ key, kind: 'block', id, cls: 'mainOnly', pick: 'main', main: m })
    else items.push({ key, kind: 'block', id, cls: 'branchOnly', pick: 'branch', branch: b })
  }

  // ── 문서(text 모드) 블록 ──
  const mText = new Map((main.textBlocks ?? []).map((b) => [b.id, b]))
  const bText = new Map((branch.textBlocks ?? []).map((b) => [b.id, b]))
  for (const id of new Set<ID>([...mText.keys(), ...bText.keys()])) {
    const m = mText.get(id)
    const b = bText.get(id)
    const key = 'tblock:' + id
    if (m && b) {
      const ms = textBlockSig(m)
      if (ms === textBlockSig(b)) items.push({ key, kind: 'tblock', id, cls: 'common', pick: 'main', main: m, branch: b })
      else {
        const d = decide(key, ms)
        // 한쪽만 손댔으면 그쪽(지운 것이면 지운다). 양쪽이 손댔는데 한쪽은 지웠으면 살아 있는 쪽 — 고친 내용을 잃지 않게
        const pick = d.both && !!m.deletedAt !== !!b.deletedAt ? { pick: (m.deletedAt ? 'branch' : 'main') as Side, both: true } : d
        items.push({ key, kind: 'tblock', id, cls: 'modified', ...pick, main: m, branch: b })
      }
    } else if (m) items.push({ key, kind: 'tblock', id, cls: 'mainOnly', pick: 'main', main: m })
    else items.push({ key, kind: 'tblock', id, cls: 'branchOnly', pick: 'branch', branch: b })
  }

  // ── 문서 정보 ──
  const meta: MetaItem[] = []
  for (const field of ['title', 'category', 'mode', 'pageOrder'] as const) {
    const mv = main.doc[field] ?? null
    const bv = branch.doc[field] ?? null
    if (j(mv) === j(bv)) continue
    meta.push({ key: `doc:${field}`, field, main: mv, branch: bv, ...decide(`doc:${field}`, j(mv)) })
  }
  return { items, meta, counts, bothCount }
}

/** 작업본을 얹은 그 항목의 상태 — 버렸는가, 어느 쪽을 쓰는가 */
export function resolveItem(item: MergeItem, draft: MergeDraft): { side: Side; discarded: boolean } {
  const side = item.cls === 'modified' && draft.flip.has(item.key) ? other(item.pick) : item.pick
  // 공통 항목은 버릴 수 없다 — 양쪽이 같은 것을 갖고 있어 버리면 '삭제'가 된다
  return { side, discarded: item.cls !== 'common' && draft.discard.has(item.key) }
}

export function resolveMeta(m: MetaItem, draft: MergeDraft): Side {
  return draft.flip.has(m.key) ? other(m.pick) : m.pick
}

/** 무한 캔버스의 청크 한 변 — shared/model.ts CHUNK_SIZE와 같은 값 (이 모듈은 node 테스트에서도 돌아 엔진을 부르지 않는다) */
const CHUNK = 4096
const q2 = (v: number) => Math.round(v * 100) / 100

/**
 * 작업본의 옮김·색을 요소에 얹는다. 무한 캔버스에서 옮긴 획은 시작점이 들어간 청크로 다시 배치한다
 * (엔진도 획을 시작점의 청크에 둔다 — 청크 밖 좌표로 두면 화면 검색에서 빠진다).
 */
export function editPlaced(p: Placed, mv: { dx: number; dy: number } | undefined, color: string | undefined, infinite: boolean): Placed {
  if (!mv && !color) return p
  let el = p.el
  if (color && 'color' in el) el = { ...el, color } as Element
  if (!mv || (!mv.dx && !mv.dy)) return { ...p, el }
  let { dx, dy } = mv
  let key = p.key
  if (infinite && el.type === 'stroke' && el.points.length >= 2) {
    const [cx, cy] = p.key.split('_').map(Number)
    const wx = cx * CHUNK + el.points[0] + dx
    const wy = cy * CHUNK + el.points[1] + dy
    const nx = Math.floor(wx / CHUNK)
    const ny = Math.floor(wy / CHUNK)
    key = `${nx}_${ny}`
    dx += (cx - nx) * CHUNK // 새 청크 원점 기준으로
    dy += (cy - ny) * CHUNK
  }
  if (el.type === 'stroke') {
    const points = el.points.slice()
    for (let i = 0; i + 1 < points.length; i += 4) {
      points[i] = q2(points[i] + dx)
      points[i + 1] = q2(points[i + 1] + dy)
    }
    const [x0, y0, x1, y1] = el.bbox
    el = { ...el, points, bbox: [x0 + dx, y0 + dy, x1 + dx, y1 + dy] }
  } else if ('x' in el && 'y' in el) el = { ...el, x: el.x + dx, y: el.y + dy } as Element
  return { ...p, key, el }
}

const valueOf = <T>(item: MergeItem, side: Side): T => (side === 'main' ? (item.main ?? item.branch) : (item.branch ?? item.main)) as T

/**
 * 결과 페이지 순서 — 기준 쪽 순서를 따르고, 기준 쪽에 없는 페이지는 다른 쪽 순서에서 바로 앞 페이지 뒤에 끼운다
 * (앞 페이지가 없으면 맨 앞). 결과에 없는 페이지(버린 페이지)는 뺀다.
 */
export function mergePageOrder(primary: readonly ID[], secondary: readonly ID[], live: Set<ID>): ID[] {
  const order = primary.filter((id) => live.has(id))
  for (let i = 0; i < secondary.length; i++) {
    const id = secondary[i]
    if (!live.has(id) || order.includes(id)) continue
    let at = 0
    for (let k = i - 1; k >= 0; k--) {
      const prev = order.indexOf(secondary[k])
      if (prev >= 0) {
        at = prev + 1
        break
      }
    }
    order.splice(at, 0, id)
  }
  for (const id of live) if (!order.includes(id)) order.push(id) // 어느 순서에도 없던 페이지(옛 파일)는 뒤에
  return order
}

/** 결과 노트를 만든다 — main의 문서를 바탕으로, 항목마다 고른 쪽을 쓰고 버린 것은 뺀다 */
export function compose(main: DocFileV1, branch: DocFileV1, plan: MergePlan, draft: MergeDraft, now = Date.now()): DocFileV1 {
  const doc: DocFileV1['doc'] = { ...main.doc }
  let orderSide: Side = 'main'
  for (const m of plan.meta) {
    const side = resolveMeta(m, draft)
    if (m.field === 'pageOrder') orderSide = side
    else (doc as Record<string, unknown>)[m.field] = side === 'main' ? m.main : m.branch
  }
  doc.category = doc.category ?? null
  doc.updatedAt = mergedUpdatedAt(main.doc.updatedAt, branch.doc.updatedAt, now)

  const pages: Page[] = []
  const placed: Placed[] = []
  const blocks: Block[] = []
  const textBlocks: TextBlock[] = []
  for (const item of plan.items) {
    const { side, discarded } = resolveItem(item, draft)
    if (discarded) continue
    if (item.kind === 'page') pages.push(valueOf<Page>(item, side))
    else if (item.kind === 'el') placed.push(editPlaced(valueOf<Placed>(item, side), draft.move.get(item.key), draft.color.get(item.key), doc.mode === 'infinite'))
    else if (item.kind === 'tblock') textBlocks.push(valueOf<TextBlock>(item, side))
    else blocks.push(valueOf<Block>(item, side))
  }
  // 보조 용지(sheet)는 pageOrder에 넣지 않는다. 기준 페이지가 결과에 없으면 용지도 함께 빠진다
  const livePages = new Set(pages.filter((p) => !p.sheet).map((p) => p.id))
  const primary = orderSide === 'main' ? main.doc.pageOrder : branch.doc.pageOrder
  const secondary = orderSide === 'main' ? branch.doc.pageOrder : main.doc.pageOrder
  doc.pageOrder = mergePageOrder(primary ?? [], secondary ?? [], livePages)
  const keptPages = pages.filter((p) => !p.sheet || livePages.has(p.sheet.anchorPageId))
  pages.length = 0
  pages.push(...keptPages)
  const live = new Set(pages.map((p) => p.id))
  const byOrder = new Map(doc.pageOrder.map((id, i) => [id, i]))
  // 페이지는 순서대로, 보조 용지는 그 뒤에 (용지끼리는 id 순 — 머지 결과가 늘 같게)
  const rankOf = (p: Page) => byOrder.get(p.id) ?? doc.pageOrder.length
  pages.sort((a, b) => rankOf(a) - rankOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  // 청크로 다시 묶는다. 안쪽 순서는 엔진의 저장 순서(획을 z순, 그 밖의 요소는 뒤)와 같게 —
  // 같은 z(두 기기가 각자 매긴 값)는 ID로 순서를 고정해 머지 결과가 늘 같게 한다
  const groups = new Map<string, { pageId: ID; key: string; elements: Element[] }>()
  for (const p of placed) {
    if (!live.has(p.pageId)) continue // 버린 페이지의 필기는 함께 빠진다
    const k = `${p.pageId}|${p.key}`
    let g = groups.get(k)
    if (!g) groups.set(k, (g = { pageId: p.pageId, key: p.key, elements: [] }))
    g.elements.push(p.el)
  }
  const rank = (e: Element) => (e.type === 'stroke' ? 0 : 1)
  const chunks: DocFileV1['chunks'] = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, g]) => ({ ...g, elements: g.elements.sort((a, b) => rank(a) - rank(b) || a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) }))

  // 원본(PDF·이미지)은 합집합
  const assets = [...main.assets]
  for (const a of branch.assets) if (!assets.some((x) => x.id === a.id)) assets.push(a)

  const keepBlocks = main.blocks !== undefined || branch.blocks !== undefined
  const keepText = main.textBlocks !== undefined || branch.textBlocks !== undefined
  // 순서 키(pos), 같으면 id — 머지 결과가 늘 같게
  textBlocks.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {
    kind: 'inkpad-doc',
    schemaVersion: 1,
    doc,
    pages,
    chunks,
    ...(keepBlocks ? { blocks: blocks.filter((b) => live.has(b.pageId)) } : {}),
    ...(keepText ? { textBlocks } : {}),
    assets
  }
}
