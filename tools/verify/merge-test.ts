/**
 * 노트 머지(sync/merge.ts) 회귀 테스트 (의존성 없음)
 *
 * 실행:  node --experimental-strip-types --no-warnings tools/verify/merge-test.ts
 *
 * 배경: 머지가 페이지(문서형)·청크(무한 캔버스) 통째로 비교해서
 *  - 같은 페이지에 두 기기가 서로 다른 줄을 쓰면 한쪽 필기가 통째로 사라졌다
 *  - base(마지막 동기화 기록)가 없으면 묻지도 않고 원격으로 덮었다
 *  - 무한 캔버스에서 같은 새 영역에 양쪽이 처음 쓰면 한쪽이 사라졌다
 * 획 ID 단위 머지로 바꾼 뒤 이 경로들이 다시 깨지지 않도록 여기서 잠근다.
 */
import { mergeDocs } from '../../src/sync/merge.ts'
import type { DocFileV1 } from '../../src/sync/pack.ts'
import type { Block, Element, Page, Stroke } from '../../src/shared/model.ts'

let pass = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) pass++
  else failures.push(`${name}${detail ? ' — ' + detail : ''}`)
}
const eqSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',')

/* ── 테스트용 노트 만들기 ─────────────────────────────────────────── */

const stroke = (id: string, z = 1, color = '#000000ff', x = 0): Stroke => ({
  id, type: 'stroke', layer: 'main', z, createdAt: 0, tool: 'pen', color, width: 2,
  points: [x, 0, 0.5, 0, x + 10, 10, 0.5, 16], bbox: [x, 0, x + 10, 10],
  opts: { thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false }
})
const page = (id: string, bg = 'blank'): Page => ({
  id, documentId: 'D', schemaVersion: 2, size: { w: 595, h: 842 },
  background: bg === 'grid' ? { type: 'grid', spacing: 24, color: '#d3d9e2' } : { type: 'blank', color: '#ffffff' },
  createdAt: 0, updatedAt: 0, version: 0
})
type Layout = Record<string, Element[]> // 'pageId|key' → 요소
function doc(layout: Layout, opts: { pages?: Page[]; mode?: 'paged' | 'infinite'; blocks?: Block[]; title?: string } = {}): DocFileV1 {
  const pageIds = [...new Set(Object.keys(layout).map((k) => k.split('|')[0]))]
  const pages = opts.pages ?? pageIds.map((id) => page(id))
  return {
    kind: 'inkpad-doc', schemaVersion: 1,
    doc: { id: 'D', schemaVersion: 2, title: opts.title ?? '노트', mode: opts.mode ?? 'paged', category: null, pageOrder: pages.map((p) => p.id), createdAt: 0, updatedAt: 1 },
    pages,
    chunks: Object.entries(layout).map(([k, elements]) => ({ pageId: k.split('|')[0], key: k.split('|')[1], elements })),
    blocks: opts.blocks ?? [],
    assets: []
  }
}
const P = (pageId: string) => `${pageId}|0_0`
/** 결과에서 획 ID 목록 (어느 청크에 있든) */
const ids = (f: DocFileV1) => f.chunks.flatMap((c) => c.elements.map((e) => e.id))
const idsAt = (f: DocFileV1, chunk: string) => f.chunks.find((c) => `${c.pageId}|${c.key}` === chunk)?.elements.map((e) => e.id) ?? []
const noDuplicates = (f: DocFileV1) => new Set(ids(f)).size === ids(f).length

/* ── T1 · 같은 페이지에 양쪽이 서로 다른 획을 추가 (보고된 증상 ①) ──── */
{
  const base = doc({ [P('p1')]: [stroke('a')] })
  const ours = doc({ [P('p1')]: [stroke('a'), stroke('mine', 2)] })
  const theirs = doc({ [P('p1')]: [stroke('a'), stroke('theirs', 2)] })
  const r = mergeDocs(base, ours, theirs)
  check('T1 양쪽 새 획 모두 남음', eqSet(ids(r.file), ['a', 'mine', 'theirs']), ids(r.file).join(','))
  check('T1 충돌 없음', r.conflicts === 0, String(r.conflicts))
  check('T1 baseless 아님', !r.baseless)
}

/* ── T2 · base 없이 양쪽이 다름 (보고된 증상 ②) ──────────────────── */
{
  const ours = doc({ [P('p1')]: [stroke('mine')] })
  const theirs = doc({ [P('p1')]: [stroke('theirs')] })
  const r = mergeDocs(null, ours, theirs)
  check('T2 base 없음 — 양쪽 획 모두 남음', eqSet(ids(r.file), ['mine', 'theirs']), ids(r.file).join(','))
  check('T2 base 없음 — baseless로 알림(확인 창 대상)', r.baseless)
  const same = mergeDocs(null, doc({ [P('p1')]: [stroke('x')] }), doc({ [P('p1')]: [stroke('x')] }))
  check('T2 base 없음 — 내용이 같으면 묻지 않음', !same.baseless && same.conflicts === 0)
  const diff = mergeDocs(null, doc({ [P('p1')]: [stroke('x', 1, '#ff0000ff')] }), doc({ [P('p1')]: [stroke('x', 1, '#0000ffff')] }))
  check('T2 base 없음 — 같은 획이 다르면 충돌로 셈', diff.conflicts === 1 && diff.baseless)
}

/* ── T3 · 무한 캔버스: base에 없던 같은 새 영역에 양쪽이 처음 씀 (보고된 증상 ③) ── */
{
  const base = doc({}, { mode: 'infinite', pages: [page('inf')] })
  const ours = doc({ 'inf|1_0': [stroke('mine')] }, { mode: 'infinite', pages: [page('inf')] })
  const theirs = doc({ 'inf|1_0': [stroke('theirs')] }, { mode: 'infinite', pages: [page('inf')] })
  const r = mergeDocs(base, ours, theirs)
  check('T3 새 청크 양쪽 획 모두 남음', eqSet(idsAt(r.file, 'inf|1_0'), ['mine', 'theirs']), ids(r.file).join(','))
  check('T3 충돌 없음', r.conflicts === 0 && !r.baseless)
}

/* ── T4 · 한쪽이 지우고 다른 쪽은 다른 획을 추가 ───────────────────── */
{
  const base = doc({ [P('p1')]: [stroke('a'), stroke('b')] })
  const ours = doc({ [P('p1')]: [stroke('a')] }) // b를 지움
  const theirs = doc({ [P('p1')]: [stroke('a'), stroke('b'), stroke('c')] }) // c 추가
  const r = mergeDocs(base, ours, theirs)
  check('T4 지운 획은 지워지고 새 획은 남음', eqSet(ids(r.file), ['a', 'c']), ids(r.file).join(','))
  check('T4 충돌 없음', r.conflicts === 0)
}

/* ── T5 · 같은 획을 양쪽에서 다르게 고침 → 충돌, 방향은 인자 순서 ──── */
{
  const base = doc({ [P('p1')]: [stroke('a')] })
  const ours = doc({ [P('p1')]: [stroke('a', 1, '#ff0000ff')] })
  const theirs = doc({ [P('p1')]: [stroke('a', 1, '#0000ffff')] })
  const remoteFirst = mergeDocs(base, ours, theirs)
  const localFirst = mergeDocs(base, theirs, ours)
  const color = (f: DocFileV1) => (f.chunks[0].elements[0] as Stroke).color
  check('T5 충돌 1곳', remoteFirst.conflicts === 1 && remoteFirst.details[0]?.kind === 'chunk')
  check('T5 원격 우선이면 원격 색', color(remoteFirst.file) === '#0000ffff')
  check('T5 이 기기 우선이면 이 기기 색', color(localFirst.file) === '#ff0000ff')
}

/* ── T6 · 같은 청크에서 획 여러 개가 충돌해도 1곳으로 센다 ─────────── */
{
  const base = doc({ [P('p1')]: [stroke('a'), stroke('b')] })
  const ours = doc({ [P('p1')]: [stroke('a', 1, '#ff0000ff'), stroke('b', 1, '#ff0000ff')] })
  const theirs = doc({ [P('p1')]: [stroke('a', 1, '#00ff00ff'), stroke('b', 1, '#00ff00ff')] })
  const r = mergeDocs(base, ours, theirs)
  check('T6 충돌 위치 1곳', r.conflicts === 1, String(r.conflicts))
}

/* ── T7 · 올가미로 다른 페이지로 옮긴 획 — 두 군데 생기지 않는다 ──── */
{
  const base = doc({ [P('p1')]: [stroke('a'), stroke('m')], [P('p2')]: [stroke('b')] })
  const ours = doc({ [P('p1')]: [stroke('a')], [P('p2')]: [stroke('b'), stroke('m', 1, '#000000ff', 50)] }) // m을 p2로 옮김
  const theirs = doc({ [P('p1')]: [stroke('a'), stroke('m'), stroke('t')], [P('p2')]: [stroke('b')] }) // p1에 t 추가
  const r = mergeDocs(base, ours, theirs)
  check('T7 옮긴 획은 새 위치에만', eqSet(idsAt(r.file, P('p2')), ['b', 'm']) && eqSet(idsAt(r.file, P('p1')), ['a', 't']), JSON.stringify(r.file.chunks.map((c) => [c.pageId, c.elements.map((e) => e.id)])))
  check('T7 중복 ID 없음', noDuplicates(r.file))
  check('T7 충돌 없음', r.conflicts === 0)
}

/* ── T8 · 이 기기는 옮기고 원격은 색을 바꿈 → 충돌이지만 한 군데에만 ── */
{
  const base = doc({ [P('p1')]: [stroke('m')], [P('p2')]: [] })
  const ours = doc({ [P('p1')]: [], [P('p2')]: [stroke('m', 1, '#000000ff', 50)] })
  const theirs = doc({ [P('p1')]: [stroke('m', 1, '#ff0000ff')], [P('p2')]: [] })
  const r = mergeDocs(base, ours, theirs)
  check('T8 충돌 1곳', r.conflicts === 1)
  check('T8 중복 ID 없음', noDuplicates(r.file) && ids(r.file).filter((i) => i === 'm').length === 1)
}

/* ── T9 · 원격이 페이지를 지웠고 이 기기는 손대지 않음 → 조용히 지움 ── */
{
  const base = doc({ [P('p1')]: [stroke('a')], [P('p2')]: [stroke('b')] })
  const ours = doc({ [P('p1')]: [stroke('a')], [P('p2')]: [stroke('b')] })
  const theirs = doc({ [P('p1')]: [stroke('a')] })
  const r = mergeDocs(base, ours, theirs)
  check('T9 페이지 삭제 반영', r.file.pages.map((p) => p.id).join() === 'p1' && eqSet(ids(r.file), ['a']))
  check('T9 충돌 없음', r.conflicts === 0)
}

/* ── T10 · 원격이 지운 페이지에 이 기기가 필기를 더함 → 충돌로 알림 ── */
{
  const base = doc({ [P('p1')]: [stroke('a')], [P('p2')]: [stroke('b')] })
  const ours = doc({ [P('p1')]: [stroke('a')], [P('p2')]: [stroke('b'), stroke('new', 2)] })
  const theirs = doc({ [P('p1')]: [stroke('a')] })
  const remoteFirst = mergeDocs(base, ours, theirs)
  check('T10 페이지 충돌 1곳', remoteFirst.conflicts === 1 && remoteFirst.details[0]?.kind === 'page', JSON.stringify(remoteFirst.details))
  check('T10 원격 우선 — 페이지 삭제', !remoteFirst.file.pages.some((p) => p.id === 'p2'))
  const localFirst = mergeDocs(base, theirs, ours)
  check('T10 이 기기 우선 — 페이지와 그 안 필기 전부 되살림', localFirst.file.pages.some((p) => p.id === 'p2') && eqSet(idsAt(localFirst.file, P('p2')), ['b', 'new']), ids(localFirst.file).join(','))
  check('T10 되살린 페이지가 페이지 순서에 있음', localFirst.file.doc.pageOrder.includes('p2'))
}

/* ── T11 · 한쪽은 속지를 바꾸고 다른 쪽은 그 페이지에 필기 → 둘 다 반영 ── */
{
  const base = doc({ [P('p1')]: [stroke('a')] })
  const ours = doc({ [P('p1')]: [stroke('a')] }, { pages: [{ ...page('p1', 'grid'), updatedAt: 99 }] })
  const theirs = doc({ [P('p1')]: [stroke('a'), stroke('t', 2)] })
  const r = mergeDocs(base, ours, theirs)
  check('T11 속지 변경 유지', r.file.pages[0].background.type === 'grid')
  check('T11 필기 추가 유지', eqSet(ids(r.file), ['a', 't']))
  check('T11 충돌 없음', r.conflicts === 0)
}

/* ── T12 · 양쪽이 서로 다른 새 페이지 추가 → 둘 다, 순서에도 둘 다 ── */
{
  const base = doc({ [P('p1')]: [] })
  const ours = doc({ [P('p1')]: [], [P('pA')]: [stroke('x')] })
  const theirs = doc({ [P('p1')]: [], [P('pB')]: [stroke('y')] })
  const r = mergeDocs(base, ours, theirs)
  check('T12 새 페이지 둘 다', eqSet(r.file.pages.map((p) => p.id), ['p1', 'pA', 'pB']))
  check('T12 순서에 둘 다', eqSet(r.file.doc.pageOrder, ['p1', 'pA', 'pB']))
  check('T12 필기 둘 다', eqSet(ids(r.file), ['x', 'y']))
}

/* ── T13 · 블록: 양쪽 새 블록 / base 없이 같은 블록이 다름 ────────── */
{
  const blk = (id: string, text: string, updatedAt = 1): Block => ({
    id, documentId: 'D', pageId: 'p1', schemaVersion: 1, x: 0, y: 0, w: 200, z: 1, createdAt: 0, updatedAt,
    type: 'memo', data: { text, color: 'yellow', collapsed: false }
  })
  const base = doc({ [P('p1')]: [] }, { blocks: [] })
  const r = mergeDocs(base, doc({ [P('p1')]: [] }, { blocks: [blk('m1', 'a')] }), doc({ [P('p1')]: [] }, { blocks: [blk('m2', 'b')] }))
  check('T13 양쪽 새 블록 모두', eqSet((r.file.blocks ?? []).map((b) => b.id), ['m1', 'm2']))
  const nb = mergeDocs(null, doc({ [P('p1')]: [] }, { blocks: [blk('m', 'mine', 5)] }), doc({ [P('p1')]: [] }, { blocks: [blk('m', 'theirs', 3)] }))
  check('T13 base 없이 같은 블록이 다르면 충돌', nb.conflicts === 1 && nb.details[0]?.kind === 'block' && nb.baseless)
}

/* ── T14 · 청크 안 순서: z순, 같은 z는 ID순 (결과가 늘 같다) ─────── */
{
  const base = doc({ [P('p1')]: [] })
  const ours = doc({ [P('p1')]: [stroke('b', 5), stroke('c', 1)] })
  const theirs = doc({ [P('p1')]: [stroke('a', 5)] })
  const r1 = mergeDocs(base, ours, theirs)
  check('T14 z순·ID순', idsAt(r1.file, P('p1')).join() === 'c,a,b', idsAt(r1.file, P('p1')).join())
}

/* ── T15 · 무작위 편집 1,000회 — 불변식 ─────────────────────────── */
{
  // 고정 시드 난수 (재현 가능)
  let seed = 20261013
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]
  let bad = 0
  let firstBad = ''
  for (let round = 0; round < 1000; round++) {
    const pagesIds = ['p1', 'p2', 'p3']
    const baseLayout: Layout = {}
    let n = 0
    for (const p of pagesIds) baseLayout[P(p)] = Array.from({ length: 3 }, () => stroke(`b${n++}`))
    const base = doc(baseLayout)
    // 양쪽이 서로 겹치지 않는 편집을 한다: ours는 짝수 획만, theirs는 홀수 획만 지운다. 새 획은 각자 이름이 다르다.
    const edit = (tag: string, parity: number) => {
      const lay: Layout = JSON.parse(JSON.stringify(baseLayout))
      const deleted: string[] = []
      const added: string[] = []
      for (let k = 0; k < 3; k++) {
        const pg = P(pick(pagesIds))
        const op = rnd()
        if (op < 0.5) {
          const victims = lay[pg].filter((e) => Number(e.id.slice(1)) % 2 === parity)
          if (victims.length) {
            const v = pick(victims)
            lay[pg] = lay[pg].filter((e) => e.id !== v.id)
            deleted.push(v.id)
          }
        } else {
          const id = `${tag}${round}_${k}`
          lay[pg].push(stroke(id, 10 + k))
          added.push(id)
        }
      }
      return { file: doc(lay), deleted, added }
    }
    const o = edit('o', 0)
    const t = edit('t', 1)
    const r = mergeDocs(base, o.file, t.file)
    const got = new Set(ids(r.file))
    const expect = new Set<string>([...Object.values(baseLayout).flat().map((e) => e.id), ...o.added, ...t.added])
    for (const d of [...o.deleted, ...t.deleted]) expect.delete(d)
    const ok = r.conflicts === 0 && noDuplicates(r.file) && got.size === expect.size && [...expect].every((x) => got.has(x))
    if (!ok) {
      bad++
      if (!firstBad) firstBad = `round ${round}: expect ${[...expect].sort()} got ${[...got].sort()} conflicts ${r.conflicts}`
    }
  }
  check('T15 겹치지 않는 편집 1,000회 — 추가는 모두 남고 삭제는 모두 반영, 충돌·중복 없음', bad === 0, firstBad)
}

/* ── 리포트 ─────────────────────────────────────────────────────── */
console.log(`\n노트 머지: ${pass}개 통과, ${failures.length}개 실패`)
if (failures.length) {
  console.log('\n실패 항목:')
  failures.forEach((f) => console.log('  ✗ ' + f))
  process.exitCode = 1
} else {
  console.log('모든 머지 시나리오 통과 ✓')
}
