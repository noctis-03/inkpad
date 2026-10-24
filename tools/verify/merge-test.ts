/**
 * 브랜치 머지(sync/merge.ts) 회귀 테스트 (의존성 없음)
 *
 * 실행:  node --experimental-strip-types --no-warnings tools/verify/merge-test.ts
 *
 * 규칙 (docs/branch-merge.md §4):
 *  - 머지에는 삭제가 없다(모두 살리기) — 한쪽에라도 있으면 남는다
 *  - 한쪽만 고쳤으면 고친 쪽, 양쪽이 고쳤으면 머지하는 기기 쪽 (브랜치의 '고친 목록'으로 가린다)
 *  - 옮긴 획은 ID로 따라가 두 군데 생기지 않는다
 *  - 작업본: 버린 항목은 빠지고, 반대쪽으로 바꾼 항목은 그쪽 내용
 */
import { classify, compose, draftFromJson, draftToJson, editPlaced, emptyDraft, mergePageOrder, resolveItem, retainDraft, type MergeDraft, type Side } from '../../src/sync/merge.ts'
import { computeModified } from '../../src/sync/branch.ts'
import type { DocFileV1 } from '../../src/sync/pack.ts'
import type { Block, Element, Page, Stroke, TextBlock } from '../../src/shared/model.ts'

let pass = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) pass++
  else failures.push(`${name}${detail ? ' — ' + detail : ''}`)
}
/** 작업본 줄임말 — 안 준 것은 비어 있다 */
const D = (d: Partial<MergeDraft>): MergeDraft => ({ ...emptyDraft(), ...d })
const eqSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',')

/* ── 테스트용 노트 ─────────────────────────────────────────────── */

const stroke = (id: string, x = 0, color = '#000000ff', z = 1): Stroke => ({
  id, type: 'stroke', layer: 'main', z, createdAt: 0, tool: 'pen', color, width: 2,
  points: [x, 0, 0.5, 0, x + 10, 10, 0.5, 16], bbox: [x, 0, x + 10, 10],
  opts: { thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false }
})
const page = (id: string, bg: 'blank' | 'grid' = 'blank'): Page => ({
  id, documentId: 'D', schemaVersion: 2, size: { w: 595, h: 842 },
  background: bg === 'grid' ? { type: 'grid', spacing: 24, color: '#d3d9e2' } : { type: 'blank', color: '#ffffff' },
  createdAt: 0, updatedAt: 0, version: 0
})
const memo = (id: string, text: string, deletedAt?: number): Block =>
  ({ id, type: 'memo', documentId: 'D', pageId: 'p1', schemaVersion: 1, x: 0, y: 0, w: 100, h: 50, z: 1, createdAt: 0, updatedAt: 0, data: { text }, ...(deletedAt ? { deletedAt } : {}) }) as unknown as Block
function doc(layout: Record<string, Element[]>, opts: { pages?: Page[]; title?: string; order?: string[]; blocks?: Block[]; updatedAt?: number } = {}): DocFileV1 {
  const pageIds = [...new Set(Object.keys(layout).map((k) => k.split('|')[0]))]
  const pages = opts.pages ?? pageIds.map((id) => page(id))
  return {
    kind: 'inkpad-doc', schemaVersion: 1,
    doc: { id: 'D', schemaVersion: 2, title: opts.title ?? '노트', mode: 'paged', category: null, pageOrder: opts.order ?? pages.map((p) => p.id), createdAt: 0, updatedAt: opts.updatedAt ?? 1 },
    pages,
    chunks: Object.entries(layout).map(([k, elements]) => ({ pageId: k.split('|')[0], key: k.split('|')[1], elements })),
    blocks: opts.blocks ?? [],
    assets: []
  }
}
const P = (pageId: string) => `${pageId}|0_0`
const ids = (f: DocFileV1) => f.chunks.flatMap((c) => c.elements.map((e) => e.id))
const elOf = (f: DocFileV1, id: string) => f.chunks.flatMap((c) => c.elements.map((e) => ({ pageId: c.pageId, el: e }))).find((x) => x.el.id === id)
const noDuplicates = (f: DocFileV1) => new Set(ids(f)).size === ids(f).length

/** base에서 출발해 main·branch가 각각 바뀐 상황을 머지한다 (브랜치의 고친 목록은 실제처럼 base와 비교해 만든다) */
function run(base: DocFileV1 | null, main: DocFileV1, branch: DocFileV1, prefer: Side = 'main', draft: MergeDraft = emptyDraft()) {
  const modified = base ? computeModified(base, branch) : {}
  const plan = classify(main, branch, { modified, hasBase: !!base, prefer })
  return { plan, out: compose(main, branch, plan, draft, 5000), item: (key: string) => plan.items.find((i) => i.key === key)! }
}

/* ── M1 · 양쪽이 서로 다른 획을 추가 ──────────────────────────── */
{
  const base = doc({ [P('p1')]: [stroke('a')] })
  const r = run(base, doc({ [P('p1')]: [stroke('a'), stroke('m')] }), doc({ [P('p1')]: [stroke('a'), stroke('b')] }))
  check('M1 양쪽 새 획 모두 남음', eqSet(ids(r.out), ['a', 'm', 'b']), ids(r.out).join(','))
  check('M1 분류: 공통·main에만·브랜치에만', r.item('el:a').cls === 'common' && r.item('el:m').cls === 'mainOnly' && r.item('el:b').cls === 'branchOnly')
  check('M1 개수', r.plan.counts.common === 1 && r.plan.counts.mainOnly === 1 && r.plan.counts.branchOnly === 1 && r.plan.counts.modified === 0)
}

/* ── M2 · 모두 살리기: 한쪽에서 지운 획도 남는다 ─────────────────── */
{
  const base = doc({ [P('p1')]: [stroke('a'), stroke('x')] })
  const r1 = run(base, doc({ [P('p1')]: [stroke('a'), stroke('x')] }), doc({ [P('p1')]: [stroke('a')] }))
  check('M2 브랜치가 지운 획은 main에 남아 살아난다', eqSet(ids(r1.out), ['a', 'x']) && r1.item('el:x').cls === 'mainOnly')
  const r2 = run(base, doc({ [P('p1')]: [stroke('a')] }), doc({ [P('p1')]: [stroke('a'), stroke('x')] }))
  check('M2 main이 지운 획도 브랜치에 있으면 살아난다', eqSet(ids(r2.out), ['a', 'x']) && r2.item('el:x').cls === 'branchOnly')
}

/* ── M3 · 한쪽만 고친 획은 고친 쪽 ───────────────────────────── */
{
  const base = doc({ [P('p1')]: [stroke('a'), stroke('b')] })
  const main = doc({ [P('p1')]: [stroke('a', 0, '#ff0000ff'), stroke('b')] }) // main이 a 색을 바꿈
  const branch = doc({ [P('p1')]: [stroke('a'), stroke('b', 40)] }) // 브랜치가 b를 옮김
  for (const prefer of ['main', 'branch'] as const) {
    const r = run(base, main, branch, prefer)
    check(`M3 main만 고친 획은 main 쪽 (머지하는 기기=${prefer})`, r.item('el:a').pick === 'main' && !r.item('el:a').both && (elOf(r.out, 'a')!.el as Stroke).color === '#ff0000ff')
    check(`M3 브랜치만 고친 획은 브랜치 쪽 (머지하는 기기=${prefer})`, r.item('el:b').pick === 'branch' && !r.item('el:b').both && (elOf(r.out, 'b')!.el as Stroke).points[0] === 40)
  }
}

/* ── M4 · 양쪽이 고친 획은 머지하는 기기 쪽 ───────────────────── */
{
  const base = doc({ [P('p1')]: [stroke('a')] })
  const main = doc({ [P('p1')]: [stroke('a', 0, '#ff0000ff')] })
  const branch = doc({ [P('p1')]: [stroke('a', 0, '#0000ffff')] })
  const rm = run(base, main, branch, 'main')
  check('M4 양쪽 고침 — main 기기가 머지하면 main', rm.item('el:a').both === true && (elOf(rm.out, 'a')!.el as Stroke).color === '#ff0000ff')
  const rb = run(base, main, branch, 'branch')
  check('M4 양쪽 고침 — 브랜치 기기가 머지하면 브랜치', (elOf(rb.out, 'a')!.el as Stroke).color === '#0000ffff')
  check('M4 양쪽 고침 개수', rm.plan.bothCount === 1)
  const flipped = run(base, main, branch, 'main', D({ flip: new Set(['el:a']) }))
  check('M4 반대쪽으로 바꾸면 그쪽 내용', (elOf(flipped.out, 'a')!.el as Stroke).color === '#0000ffff')
}

/* ── M5 · 출발점 없이 올린 브랜치는 내용이 다른 것을 모두 양쪽 고침으로 ── */
{
  const r = run(null, doc({ [P('p1')]: [stroke('a', 0, '#ff0000ff'), stroke('m')] }), doc({ [P('p1')]: [stroke('a', 0, '#0000ffff'), stroke('b')] }), 'branch')
  check('M5 출발점 없음 — 다른 획은 양쪽 고침, 머지하는 기기 쪽', r.item('el:a').both === true && (elOf(r.out, 'a')!.el as Stroke).color === '#0000ffff')
  check('M5 출발점 없음 — 한쪽에만 있는 획은 모두 남는다', eqSet(ids(r.out), ['a', 'm', 'b']))
}

/* ── M6 · 다른 페이지로 옮긴 획은 한 곳에만 ───────────────────── */
{
  const base = doc({ [P('p1')]: [stroke('a')], [P('p2')]: [] })
  const branch = doc({ [P('p1')]: [], [P('p2')]: [stroke('a')] })
  const r = run(base, base, branch)
  check('M6 옮긴 획은 새 페이지에', elOf(r.out, 'a')?.pageId === 'p2' && noDuplicates(r.out))
}

/* ── M7 · 페이지: 모두 살리기, 순서 끼워 넣기, 속지 ───────────── */
{
  const base = doc({ [P('p1')]: [], [P('p2')]: [] })
  const main = doc({ [P('p1')]: [], [P('p2')]: [], [P('m3')]: [stroke('mm')] }) // main이 맨 뒤에 m3 추가
  const branch = doc({ [P('p1')]: [], [P('b9')]: [stroke('bb')], [P('p2')]: [] }) // 브랜치가 p1 뒤에 b9 추가
  const r = run(base, main, branch)
  check('M7 양쪽 새 페이지 모두 남음', eqSet(r.out.pages.map((p) => p.id), ['p1', 'b9', 'p2', 'm3']))
  check('M7 브랜치 페이지는 브랜치 순서의 앞 페이지 뒤에', r.out.doc.pageOrder.join(',') === 'p1,b9,p2,m3', r.out.doc.pageOrder.join(','))
  check('M7 결과 페이지 배열도 같은 순서', r.out.pages.map((p) => p.id).join(',') === r.out.doc.pageOrder.join(','))

  const del = run(base, base, doc({ [P('p1')]: [] }))
  check('M7 브랜치가 지운 페이지도 남는다', eqSet(del.out.pages.map((p) => p.id), ['p1', 'p2']) && del.item('page:p2').cls === 'mainOnly')

  const bg = run(base, base, doc({ [P('p1')]: [], [P('p2')]: [] }, { pages: [page('p1', 'grid'), page('p2')] }))
  check('M7 브랜치만 바꾼 속지는 브랜치 쪽', bg.out.pages.find((p) => p.id === 'p1')!.background.type === 'grid' && bg.item('page:p1').pick === 'branch')

  const discard = run(base, main, branch, 'main', D({ discard: new Set(['page:b9']) }))
  check('M7 버린 페이지는 그 필기와 함께 빠진다', !discard.out.pages.some((p) => p.id === 'b9') && !ids(discard.out).includes('bb') && !discard.out.doc.pageOrder.includes('b9'))
}

/* ── M8 · 페이지 순서 끼워 넣기 (순수 함수) ───────────────────── */
{
  const live = (xs: string[]) => new Set(xs)
  check('M8 앞 페이지가 없으면 맨 앞', mergePageOrder(['a', 'b'], ['n', 'a', 'b'], live(['a', 'b', 'n'])).join(',') === 'n,a,b')
  check('M8 연속으로 끼운 페이지는 순서 유지', mergePageOrder(['a', 'b'], ['a', 'x', 'y', 'b'], live(['a', 'b', 'x', 'y'])).join(',') === 'a,x,y,b')
  check('M8 결과에 없는 페이지는 뺀다', mergePageOrder(['a', 'gone', 'b'], ['a', 'b'], live(['a', 'b'])).join(',') === 'a,b')
}

/* ── M9 · 문서 정보 ───────────────────────────────────────────── */
{
  const base = doc({ [P('p1')]: [] }, { title: '처음' })
  const onlyBranch = run(base, base, doc({ [P('p1')]: [] }, { title: '브랜치 제목' }))
  check('M9 브랜치만 바꾼 제목은 브랜치 쪽', onlyBranch.out.doc.title === '브랜치 제목')
  const onlyMain = run(base, doc({ [P('p1')]: [] }, { title: 'main 제목' }), base)
  check('M9 main만 바꾼 제목은 main 쪽', onlyMain.out.doc.title === 'main 제목')
  const both = run(base, doc({ [P('p1')]: [] }, { title: 'M' }), doc({ [P('p1')]: [] }, { title: 'B' }), 'branch')
  check('M9 양쪽이 바꾼 제목은 머지하는 기기 쪽', both.out.doc.title === 'B' && both.plan.meta[0]?.both === true)
  const flip = run(base, doc({ [P('p1')]: [] }, { title: 'M' }), doc({ [P('p1')]: [] }, { title: 'B' }), 'branch', D({ flip: new Set(['doc:title']) }))
  check('M9 제목도 반대쪽으로 바꿀 수 있다', flip.out.doc.title === 'M')
}

/* ── M10 · 블록 ───────────────────────────────────────────────── */
{
  const base = doc({ [P('p1')]: [] }, { blocks: [memo('k', '처음'), memo('d', '지울 메모')] })
  const main = doc({ [P('p1')]: [] }, { blocks: [memo('k', '처음'), memo('d', '지울 메모')] })
  const branch = doc({ [P('p1')]: [] }, { blocks: [memo('k', '고침'), memo('d', '지울 메모', 99)] })
  const r = run(base, main, branch)
  const out = new Map((r.out.blocks ?? []).map((b) => [b.id, b]))
  check('M10 브랜치만 고친 블록은 브랜치 쪽', (out.get('k') as unknown as { data: { text: string } }).data.text === '고침')
  check('M10 한쪽만 지운 블록은 살아 있는 쪽(모두 살리기)', !!out.get('d') && !out.get('d')!.deletedAt)
}

/* ── M11 · 작업본: 버리기 ─────────────────────────────────────── */
{
  const base = doc({ [P('p1')]: [stroke('a'), stroke('x')] })
  const main = doc({ [P('p1')]: [stroke('a'), stroke('x'), stroke('m')] })
  const branch = doc({ [P('p1')]: [stroke('a'), stroke('b')] })
  const r = run(base, main, branch, 'main', D({ discard: new Set(['el:x', 'el:b', 'el:a']) }))
  check('M11 버린 획은 빠진다(브랜치가 지운 x, 브랜치 새 획 b)', !ids(r.out).includes('x') && !ids(r.out).includes('b'))
  check('M11 공통 획은 버릴 수 없다', ids(r.out).includes('a') && !resolveItem(r.item('el:a'), D({ discard: new Set(['el:a']) })).discarded)
  check('M11 나머지는 남는다', ids(r.out).includes('m'))
}

/* ── M12 · 결과의 형태 ────────────────────────────────────────── */
{
  const base = doc({ [P('p1')]: [stroke('a')] }, { updatedAt: 100 })
  const main = doc({ [P('p1')]: [stroke('a'), stroke('m', 0, '#000000ff', 2)] }, { updatedAt: 9000 })
  const branch = doc({ [P('p1')]: [stroke('a'), stroke('b', 0, '#000000ff', 2)] }, { updatedAt: 200 })
  main.assets = [{ id: 'A1', kind: 'pdf', mime: 'application/pdf', size: 1, sha256: 's1', createdAt: 0 }]
  branch.assets = [{ id: 'A2', kind: 'image', mime: 'image/png', size: 1, sha256: 's2', createdAt: 0 }]
  const r = run(base, main, branch)
  check('M12 결과 updatedAt은 양쪽보다 크다', r.out.doc.updatedAt > 9000 && r.out.doc.updatedAt > 200)
  check('M12 원본은 합집합', eqSet(r.out.assets.map((a) => a.id), ['A1', 'A2']))
  check('M12 같은 z는 ID로 순서 고정(늘 같은 결과)', r.out.chunks[0].elements.map((e) => e.id).join(',') === 'a,b,m')
  check('M12 중복 없음', noDuplicates(r.out))
  const again = run(base, main, branch)
  check('M12 같은 입력이면 같은 결과', JSON.stringify(again.out) === JSON.stringify(r.out))
}

/* ── M13 · 작업본: 옮기기·색 ─────────────────────────────────── */
{
  const base = doc({ [P('p1')]: [stroke('a')] })
  const branch = doc({ [P('p1')]: [stroke('a'), stroke('b')] })
  const r = run(base, base, branch, 'main', D({ move: new Map([['el:b', { dx: 30, dy: 5 }]]), color: new Map([['el:a', '#00ff00ff']]) }))
  const b = elOf(r.out, 'b')!.el as Stroke
  check('M13 옮긴 획은 점·상자가 함께 옮겨진다', b.points[0] === 30 && b.points[1] === 5 && b.points[4] === 40 && b.bbox[0] === 30 && b.bbox[3] === 15, JSON.stringify(b.points))
  check('M13 색을 바꾼 획 (공통 획도 바꿀 수 있다)', (elOf(r.out, 'a')!.el as Stroke).color === '#00ff00ff')
  check('M13 원래 입력은 그대로', (branch.chunks[0].elements[1] as Stroke).points[0] === 0)
  // 무한 캔버스: 청크 밖으로 옮기면 시작점이 들어간 청크로 다시 배치 (엔진과 같은 규칙)
  const moved = editPlaced({ pageId: 'p', key: '0_0', el: stroke('c', 4000) }, { dx: 200, dy: -10 }, undefined, true)
  check('M13 무한 캔버스 — 새 청크로', moved.key === '1_-1', moved.key)
  const pts = (moved.el as Stroke).points
  check('M13 무한 캔버스 — 새 청크 원점 기준 좌표', pts[0] === 104 && pts[1] === 4086, JSON.stringify(pts.slice(0, 2)))
  check('M13 문서형은 같은 페이지에', editPlaced({ pageId: 'p', key: '0_0', el: stroke('c', 590) }, { dx: 50, dy: 0 }, undefined, false).key === '0_0')
}

/* ── M14 · 작업본 저장·다시 얹기 ──────────────────────────────── */
{
  const d = D({ discard: new Set(['el:x', 'el:gone']), flip: new Set(['doc:title']), move: new Map([['el:x', { dx: 1, dy: 2 }]]), color: new Map([['el:gone', '#000']]) })
  const back = draftFromJson(JSON.parse(JSON.stringify(draftToJson(d))))
  check('M14 저장 모양으로 갔다 와도 같다', JSON.stringify(draftToJson(back)) === JSON.stringify(draftToJson(d)))
  const base = doc({ [P('p1')]: [stroke('x')] })
  const { plan } = run(base, base, doc({ [P('p1')]: [stroke('x')] }, { title: '새' }))
  const kept = retainDraft(d, plan)
  check('M14 새 입력에 없는 항목은 빠진다', !kept.discard.has('el:gone') && !kept.color.has('el:gone'))
  check('M14 있는 항목은 그대로 얹힌다', kept.discard.has('el:x') && kept.move.get('el:x')?.dy === 2 && kept.flip.has('doc:title'))
}

/* ── T1~T6 · 문서(text 모드) 블록 — 블록 단위로 합치고, 한쪽만 지웠으면 지운다 ───── */
const tb = (id: string, html: string, pos: string, o: Partial<TextBlock> = {}): TextBlock => ({ id, documentId: 'D', type: 'p', html, indent: 0, pos, createdAt: 0, updatedAt: 0, ...o })
const tdoc = (blocks: TextBlock[]): DocFileV1 => ({ ...doc({}, { pages: [], order: [] }), doc: { ...doc({}, { pages: [], order: [] }).doc, mode: 'text' }, textBlocks: blocks })
const live = (f: DocFileV1) => (f.textBlocks ?? []).filter((b) => !b.deletedAt)
const htmls = (f: DocFileV1) => live(f).map((b) => b.html).join('|')
{
  const base = tdoc([tb('a', '하나', 'a'), tb('b', '둘', 'b'), tb('c', '셋', 'c')])
  // T1 서로 다른 블록을 고침
  const r1 = run(base, tdoc([tb('a', '하나 (main)', 'a', { updatedAt: 9 }), tb('b', '둘', 'b'), tb('c', '셋', 'c')]), tdoc([tb('a', '하나', 'a'), tb('b', '둘', 'b'), tb('c', '셋 (브랜치)', 'c', { updatedAt: 7 })]))
  check('T1 서로 다른 블록을 고치면 둘 다 반영', htmls(r1.out) === '하나 (main)|둘|셋 (브랜치)', htmls(r1.out))
  check('T1 updatedAt만 다른 블록은 공통', r1.item('tblock:b').cls === 'common')
  // T2 같은 블록을 양쪽이 고침 → 머지하는 기기 쪽, 양쪽 고침 표시
  const m2 = tdoc([tb('a', 'M', 'a'), tb('b', '둘', 'b'), tb('c', '셋', 'c')])
  const b2 = tdoc([tb('a', 'B', 'a'), tb('b', '둘', 'b'), tb('c', '셋', 'c')])
  const r2 = run(base, m2, b2, 'branch')
  check('T2 같은 블록 양쪽 고침 → prefer 쪽', htmls(r2.out).startsWith('B|') && r2.item('tblock:a').both === true, htmls(r2.out))
  check('T2 작업본으로 반대쪽 선택', htmls(compose(m2, b2, r2.plan, D({ flip: new Set(['tblock:a']) }), 5000)).startsWith('M|'))
  // T3 브랜치만 지움 → 지운다
  const r3 = run(base, base, tdoc([tb('a', '하나', 'a'), tb('b', '둘', 'b', { deletedAt: 50 }), tb('c', '셋', 'c')]))
  check('T3 한쪽만 지웠으면 지운다', htmls(r3.out) === '하나|셋', htmls(r3.out))
  check('T3 지운 표식은 결과에 남는다 (다음 머지용)', (r3.out.textBlocks ?? []).some((b) => b.id === 'b' && b.deletedAt))
  // T4 main은 지우고 브랜치는 고침 → 살린다(고친 내용)
  const r4 = run(base, tdoc([tb('a', '하나', 'a'), tb('b', '둘', 'b', { deletedAt: 50 }), tb('c', '셋', 'c')]), tdoc([tb('a', '하나', 'a'), tb('b', '둘 고침', 'b'), tb('c', '셋', 'c')]), 'main')
  check('T4 한쪽은 지우고 한쪽은 고쳤으면 살린다', htmls(r4.out) === '하나|둘 고침|셋', htmls(r4.out))
  // T5 양쪽이 같은 자리에 새 블록 — 순서 키로 둘 다 자리 잡음
  const r5 = run(base, tdoc([...base.textBlocks!, tb('m', '새 main', 'am')]), tdoc([...base.textBlocks!, tb('n', '새 브랜치', 'an')]))
  check('T5 양쪽이 끼워 넣은 블록 둘 다, 순서 키대로', htmls(r5.out) === '하나|새 main|새 브랜치|둘|셋', htmls(r5.out))
  // T6 출발점 없이 올린 브랜치 — 누가 지웠는지 모르면 살린다
  const r6 = run(null, base, tdoc([tb('a', '하나', 'a'), tb('b', '둘', 'b', { deletedAt: 50 }), tb('c', '셋', 'c')]))
  check('T6 출발점이 없으면 지운 것보다 살린다', htmls(r6.out) === '하나|둘|셋', htmls(r6.out))
  check('T6 노트 머지 결과엔 textBlocks가 생기지 않는다', !('textBlocks' in run(null, doc({}), doc({})).out))
}

/* ── 리포트 ─────────────────────────────────────────────────────── */
console.log(`\n브랜치 머지: ${pass}개 통과, ${failures.length}개 실패`)
if (failures.length) {
  console.log('\n실패 항목:')
  failures.forEach((f) => console.log('  ✗ ' + f))
  process.exitCode = 1
} else {
  console.log('모든 머지 시나리오 통과 ✓')
}
