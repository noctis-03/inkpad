/**
 * 기기별 브랜치(sync/branch.ts) 회귀 테스트 (의존성 없음)
 *
 * 실행:  node --experimental-strip-types --no-warnings tools/verify/branch-test.ts
 *
 * 배경 (docs/branch-merge.md):
 *  - 올리기는 내 브랜치에 올리고, main이 내 출발점 그대로일 때만 main을 따라간다(fast-forward)
 *  - 출발점 비교는 main을 쓸 때마다 새로 뽑는 신원(mid)으로 한다 — 세대 번호만으로는 동시에 따라간 두 기기를 가리지 못한다
 *  - 옛 앱은 mid를 모른 채 appProperties를 덮어쓴다(Drive는 없는 키를 남긴다) → midU로 옛 앱이 쓴 main을 알아본다
 *  - 브랜치에는 출발점 대비 '고친 것'과 고치기 전 해시를 싣는다 — 머지 관리가 누가 고쳤는지 가린다
 */
import {
  branchFileName,
  computeModified,
  genOf,
  isUnmerged,
  mainMidOf,
  mainProps,
  mergedOf,
  midOfFile,
  newDeviceId,
  newMid,
  shortHash,
  elementSig,
  type MainFile
} from '../../src/sync/branch.ts'
import type { DocFileV1 } from '../../src/sync/pack.ts'
import type { Block, Element, Page, Stroke } from '../../src/shared/model.ts'

let pass = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) pass++
  else failures.push(`${name}${detail ? ' — ' + detail : ''}`)
}
/** Drive appProperties 한 항목(키+값) 상한 — src/sync/drive.ts APP_PROPERTY_MAX_BYTES와 같은 값 (drive.ts는 브라우저 모듈이라 불러오지 않는다) */
const APP_PROPERTY_MAX_BYTES = 124
const keys = (o: object) => Object.keys(o).sort().join(',')

/* ── 테스트용 노트 ─────────────────────────────────────────────── */

const stroke = (id: string, x = 0, color = '#000000ff'): Stroke => ({
  id, type: 'stroke', layer: 'main', z: 1, createdAt: 0, tool: 'pen', color, width: 2,
  points: [x, 0, 0.5, 0, x + 10, 10, 0.5, 16], bbox: [x, 0, x + 10, 10],
  opts: { thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false }
})
const page = (id: string, bg: 'blank' | 'grid' = 'blank', updatedAt = 0): Page => ({
  id, documentId: 'D', schemaVersion: 2, size: { w: 595, h: 842 },
  background: bg === 'grid' ? { type: 'grid', spacing: 24, color: '#d3d9e2' } : { type: 'blank', color: '#ffffff' },
  createdAt: 0, updatedAt, version: 0
})
const memo = (id: string, text: string): Block =>
  ({ id, type: 'memo', documentId: 'D', pageId: 'p1', schemaVersion: 1, x: 0, y: 0, w: 100, h: 50, z: 1, createdAt: 0, updatedAt: 0, data: { text } }) as unknown as Block
function doc(layout: Record<string, Element[]>, opts: { pages?: Page[]; title?: string; order?: string[]; blocks?: Block[] } = {}): DocFileV1 {
  const pageIds = [...new Set(Object.keys(layout).map((k) => k.split('|')[0]))]
  const pages = opts.pages ?? pageIds.map((id) => page(id))
  return {
    kind: 'inkpad-doc', schemaVersion: 1,
    doc: { id: 'D', schemaVersion: 2, title: opts.title ?? '노트', mode: 'paged', category: null, pageOrder: opts.order ?? pages.map((p) => p.id), createdAt: 0, updatedAt: 1 },
    pages,
    chunks: Object.entries(layout).map(([k, elements]) => ({ pageId: k.split('|')[0], key: k.split('|')[1], elements })),
    blocks: opts.blocks ?? [],
    assets: []
  }
}

/* ── B1 · 고친 목록 ───────────────────────────────────────────── */
{
  const base = doc({ 'p1|0_0': [stroke('a'), stroke('b')], 'p2|0_0': [stroke('c')] }, { blocks: [memo('m', '안녕')] })
  check('B1 그대로면 비어 있다', keys(computeModified(base, base)) === '')

  const moved = doc({ 'p1|0_0': [stroke('a', 50), stroke('b')], 'p2|0_0': [stroke('c')] }, { blocks: [memo('m', '안녕')] })
  const m1 = computeModified(base, moved)
  check('B1 옮긴 획은 고침', keys(m1) === 'el:a', keys(m1))
  check('B1 값은 고치기 전 내용의 해시', m1['el:a'] === shortHash(elementSig('p1', '0_0', stroke('a'))))

  const recolor = doc({ 'p1|0_0': [stroke('a'), stroke('b', 0, '#ff0000ff')], 'p2|0_0': [stroke('c')] }, { blocks: [memo('m', '안녕')] })
  check('B1 색을 바꾼 획은 고침', keys(computeModified(base, recolor)) === 'el:b')

  const otherPage = doc({ 'p1|0_0': [stroke('a')], 'p2|0_0': [stroke('c'), stroke('b')] }, { blocks: [memo('m', '안녕')] })
  check('B1 다른 페이지로 옮긴 획도 고침', keys(computeModified(base, otherPage)) === 'el:b')

  const added = doc({ 'p1|0_0': [stroke('a'), stroke('b'), stroke('new')], 'p2|0_0': [stroke('c')] }, { blocks: [memo('m', '안녕')] })
  check('B1 새로 그린 획은 싣지 않는다(있다/없다로 판정)', keys(computeModified(base, added)) === '')
  const removed = doc({ 'p1|0_0': [stroke('a')], 'p2|0_0': [stroke('c')] }, { blocks: [memo('m', '안녕')] })
  check('B1 지운 획도 싣지 않는다(머지에는 삭제가 없다)', keys(computeModified(base, removed)) === '')

  const bg = doc({ 'p1|0_0': [stroke('a'), stroke('b')], 'p2|0_0': [stroke('c')] }, { pages: [page('p1', 'grid'), page('p2')], blocks: [memo('m', '안녕')] })
  check('B1 속지를 바꾼 페이지는 고침', keys(computeModified(base, bg)) === 'page:p1')
  const touched = doc({ 'p1|0_0': [stroke('a'), stroke('b')], 'p2|0_0': [stroke('c')] }, { pages: [page('p1', 'blank', 999), page('p2')], blocks: [memo('m', '안녕')] })
  check('B1 페이지 updatedAt만 바뀐 것은 고침이 아니다', keys(computeModified(base, touched)) === '')

  const meta = doc({ 'p1|0_0': [stroke('a'), stroke('b')], 'p2|0_0': [stroke('c')] }, { title: '새 제목', order: ['p2', 'p1'], blocks: [memo('m', '안녕')] })
  check('B1 제목·페이지 순서', keys(computeModified(base, meta)) === 'doc:pageOrder,doc:title', keys(computeModified(base, meta)))

  const blk = doc({ 'p1|0_0': [stroke('a'), stroke('b')], 'p2|0_0': [stroke('c')] }, { blocks: [memo('m', '잘 가')] })
  check('B1 블록 내용을 바꾸면 고침', keys(computeModified(base, blk)) === 'block:m')
}

/* ── B2 · 해시·신원 ───────────────────────────────────────────── */
check('B2 해시는 같은 입력에 같은 값', shortHash('가나다') === shortHash('가나다') && shortHash('가나다').length === 16)
check('B2 다른 입력은 다른 값', shortHash('a') !== shortHash('b') && shortHash('') !== shortHash(' '))
check('B2 기기 ID·main 신원은 매번 다르다', newDeviceId() !== newDeviceId() && newMid() !== newMid())
check('B2 브랜치 파일 이름', branchFileName('DOC', 'dev1') === 'branches/DOC@dev1.json')

/* ── B3 · main 신원 (옛 앱 호환) ──────────────────────────────── */
{
  const props = mainProps({ gen: 3, mid: 'abc', merged: { pad: 2, pc: 5 }, updatedAt: 1000 })
  check('B3 새 앱이 쓴 main', mainMidOf({ ...props, updatedAt: '1000' }) === 'abc')
  // 옛 앱이 덮어쓰면 updatedAt만 새로 달리고 mid·midU는 낡은 채 남는다(Drive는 PATCH에 없는 키를 남긴다)
  check('B3 옛 앱이 덮어쓴 main은 옛 신원으로', mainMidOf({ ...props, updatedAt: '2000' }) === 'legacy:2000')
  check('B3 표식이 없는 옛 main', mainMidOf({ updatedAt: '5' }) === 'legacy:5' && mainMidOf(undefined) === 'legacy:0')
  const body = { doc: { updatedAt: 2000 } } as unknown as MainFile
  check('B3 본문 신원 — 옛 앱 본문은 목록 표식과 같은 규칙', midOfFile(body) === mainMidOf({ ...props, updatedAt: '2000' }))
  const newBody = { doc: { updatedAt: 1000 }, main: { gen: 3, mid: 'abc', merged: {}, made: { kind: 'ff', deviceId: 'pc', device: 'PC', at: 0 } } } as unknown as MainFile
  check('B3 본문 신원 — 새 앱 본문', midOfFile(newBody) === 'abc')
  check('B3 세대', genOf(props) === 3 && genOf(undefined) === 0 && genOf({ gen: 'x' }) === 0)
  check('B3 반영된 브랜치를 그대로 읽는다', JSON.stringify(mergedOf({ ...props, docId: 'D' })) === JSON.stringify({ pad: 2, pc: 5 }))
  const over = Object.entries(mainProps({ gen: 99999, mid: newMid(), merged: { [newDeviceId()]: 123456 }, updatedAt: Date.now() })).filter(
    ([k, v]) => new TextEncoder().encode(k + v).length > APP_PROPERTY_MAX_BYTES
  )
  check('B3 표식은 appProperties 크기 제한 안', over.length === 0)
}

/* ── B4 · 머지 안 된 내 브랜치 ─────────────────────────────────── */
{
  const st = (seq: number, resolved?: number) => ({ seq, baseMid: 'M', baseGen: 1, ...(resolved ? { resolved } : {}) })
  check('B4 올린 적 없으면 아니다', !isUnmerged(undefined, {}, 'pad') && !isUnmerged(st(0), {}, 'pad'))
  check('B4 main에 내 seq가 있으면 아니다', !isUnmerged(st(3), { pad: 3 }, 'pad'))
  check('B4 main에 내 seq가 없으면 머지 안 됨', isUnmerged(st(4), { pad: 3 }, 'pad'))
  check('B4 다른 기기 seq는 상관없다', isUnmerged(st(1), { pc: 9 }, 'pad'))
  check('B4 버린 것(맞추기)으로 표시했으면 아니다', !isUnmerged(st(4, 4), { pad: 3 }, 'pad'))
}

/* ── 리포트 ─────────────────────────────────────────────────────── */
console.log(`\n브랜치: ${pass}개 통과, ${failures.length}개 실패`)
if (failures.length) {
  console.log('\n실패 항목:')
  failures.forEach((f) => console.log('  ✗ ' + f))
  process.exitCode = 1
} else {
  console.log('모든 브랜치 시나리오 통과 ✓')
}
