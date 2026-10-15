// 써 보며 공부하기: 받기 = 클라우드로 완전 동기화(덮기·올리기·건너뛰기, 덮기 전 비교), 변경 버리기(네트워크 없음)
import type { Page } from 'playwright'
import { createFakeDrive } from './fake-drive.ts'
import { addStroke, createDoc, device, drawStroke, logsOf, openEditor, sameSet, sleep, strokes, type Ctx } from './lib.ts'

const push = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pushNow())
const pull = (p: Page, choices: { overwrite?: string[]; push?: string[] } = {}) => p.evaluate(async (c) => (await import('/src/sync/sync.ts')).pullNow(c), choices)
const planLocal = (p: Page) => p.evaluate(async () => (await (await import('/src/sync/sync.ts')).planPull()).local)
const lastSnap = (p: Page, docId: string) =>
  p.evaluate(async (D) => {
    const sn = await import('/src/sync/snapshots.ts')
    const s = (await sn.listSnapshots(D))[0]
    return s ? { why: s.why, ids: (await sn.loadSnapshot(s.id)).chunks.flatMap((c) => c.elements.map((e) => e.id)) } : null
  }, docId)
const pending = (p: Page, docId: string) => p.evaluate(async (D) => (await (await import('/src/sync/unchanged.ts')).pendingSeqsFor(D)).length, docId)
const deviceId = (p: Page) => p.evaluate(async () => (await import('/src/sync/token.ts')).getDeviceId())

function watchDrive(p: Page) {
  const log: { method: string; url: string }[] = []
  p.on('request', (r) => {
    if (r.url().includes('googleapis.com') && r.method() !== 'OPTIONS') log.push({ method: r.method(), url: r.url() })
  })
  return { reset: () => (log.length = 0), total: () => log.length, bodies: () => log.filter((l) => l.url.includes('alt=media')).length, writes: () => log.filter((l) => l.method !== 'GET').length }
}

export default async function study(ctx: Ctx) {
  const { base, check } = ctx
  const drive = createFakeDrive()
  const A = await device(ctx, { drive, name: 'iPad' })
  const B = await device(ctx, { drive, name: 'PC' })
  const net = watchDrive(A)
  const devA = await deviceId(A)

  const D = await createDoc(A, '공부 노트')
  await addStroke(A, D, 'note')
  await push(A)
  await pull(B)

  // ── 변경 버리기: 써 보고 원래대로 — 네트워크 없음 ──
  await addStroke(A, D, 'practice1')
  net.reset()
  const r1 = await A.evaluate(async (D) => (await import('/src/sync/sync.ts')).discardLocalChanges(D), D)
  check('변경 버리기: 마지막 동기화 상태로', r1 === 'reverted' && sameSet(await strokes(A, D), ['note']))
  check('변경 버리기: Drive 요청 0', net.total() === 0, String(net.total()))
  check('변경 버리기: 올리기 대기도 없어진다', (await pending(A, D)) === 0)
  const s1 = await lastSnap(A, D)
  check('변경 버리기: 쓴 것은 스냅샷에 남는다', s1?.why === 'discard' && s1.ids.includes('practice1'), JSON.stringify(s1))

  // ── 받기 미리보기: 이 기기 변경이 있는 노트는 덮기·올리기·건너뛰기 ──
  await addStroke(A, D, 'practice2')
  const l1 = await planLocal(A)
  check('받기 미리보기: 덮이는 노트로 보인다 — 쓴 획 +1, 클라우드는 그대로', l1.length === 1 && l1[0].docId === D && l1[0].sync === 'push' && !l1[0].remoteChanged && l1[0].changes?.added === 1, JSON.stringify(l1))
  net.reset()
  await pull(A, { overwrite: [D] })
  check('덮기(클라우드 그대로): 원래대로', sameSet(await strokes(A, D), ['note']))
  check('덮기(클라우드 그대로): 노트를 내려받지 않는다', net.bodies() === 0 && net.writes() === 0, JSON.stringify({ b: net.bodies(), w: net.writes() }))
  check('덮기: 쓴 것은 스냅샷에', (await lastSnap(A, D))?.ids.includes('practice2') === true)

  // 클라우드도 바뀐 노트를 덮기 — main을 받고, 이 기기 것은 브랜치에 올리지 않는다
  await addStroke(A, D, 'practice3')
  await addStroke(B, D, 'pc-note')
  await push(B)
  const l2 = await planLocal(A)
  check('받기 미리보기: 클라우드도 바뀐 노트', l2[0]?.sync === 'diverged' && l2[0].remoteChanged, JSON.stringify(l2))
  await pull(A, { overwrite: [D] })
  check('덮기(클라우드 바뀜): main 내용으로', sameSet(await strokes(A, D), ['note', 'pc-note']))
  check('덮기: 이 기기 것은 브랜치에 올리지 않는다', !drive.branchOf(D, devA) || !drive.fileStrokes(drive.branchOf(D, devA)!).includes('practice3'))
  check('덮기: 받은 뒤 최신', (await planLocal(A)).length === 0)

  // 올리기를 고르면 이 기기 것을 올린다, 건너뛰면 그대로
  await addStroke(A, D, 'real-note')
  await pull(A, { push: [D] })
  check('올리기 고름: main에 들어간다', drive.headStrokes(D).includes('real-note'))
  await addStroke(A, D, 'keep-me')
  await pull(A)
  check('건너뜀(고르지 않음): 이 기기 것 그대로', (await strokes(A, D)).includes('keep-me'))

  // ── 화면: 받기 미리보기 → 비교 → 덮기 ──
  await openEditor(A, base, D)
  await A.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setPanel('sync'))
  await A.locator('#sync-panel .sync-big.g-recv').click()
  const row = A.locator('.pull-local-row', { hasText: '공부 노트' })
  await row.waitFor({ timeout: 15000 })
  check('화면: 덮이는 노트 행 — 쓴 획 +1', (await row.innerText()).includes('+1'))
  await row.getByRole('button', { name: '비교' }).click()
  await A.waitForSelector('.changes-sheet .changes-chip.add')
  check('화면: 비교 화면에 쓴 획 +1', (await A.locator('.changes-sheet .changes-chip.add').innerText()).includes('+1'))
  check('화면: 바뀐 페이지를 그린다', (await A.locator('.changes-sheet .merge-canvas').count()) >= 1)
  await A.locator('.changes-sheet').getByRole('button', { name: '닫기' }).first().click()
  await A.getByRole('button', { name: /건 맞추기/ }).click()
  await A.waitForFunction(() => !document.querySelector('.pull-local-row'), null, { timeout: 15000 })
  await sleep(500)
  check('화면: 덮기(기본)로 원래대로', !(await strokes(A, D)).includes('keep-me'))
  await A.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setPanel('none'))

  // ── 화면: 노트 칩 '변경 버리기…' ──
  await drawStroke(A)
  await A.waitForFunction(() => document.querySelector('.note-sync')?.textContent?.includes('올리기 필요'), null, { timeout: 15000 })
  const n = (await strokes(A, D)).length
  await A.locator('.note-sync').click()
  await A.getByRole('menuitem', { name: '변경 버리기…' }).click()
  await A.waitForSelector('.changes-sheet .changes-chip.add')
  await A.locator('.changes-sheet').getByRole('button', { name: '변경 버리기' }).click()
  await A.waitForFunction(() => document.querySelector('.note-sync')?.textContent?.includes('동기화됨'), null, { timeout: 15000 })
  check('화면: 칩의 변경 버리기로 그린 획이 사라진다', (await strokes(A, D)).length === n - 1)

  const warn = [...logsOf(A), ...logsOf(B)].filter((t) => /노트 보호\(withDocExclusive\) 밖|미구현/.test(t))
  check('경고 없음', warn.length === 0, warn.join(' | '))
  await A.context().close()
  await B.context().close()
}
