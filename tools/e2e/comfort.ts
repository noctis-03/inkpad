// 수동 동기화 편의: 앱 열 때 클라우드 확인(켰을 때만·목록만·30분 간격), 편집 화면 노트 칩(올리기·받기),
// 노트를 닫을 때 알림, 라이브러리 할 일 배지, 앱 아이콘 배지
import type { Page } from 'playwright'
import { createFakeDrive } from './fake-drive.ts'
import { addStroke, createDoc, device, drawStroke, logsOf, openEditor, sleep, strokes, type Ctx } from './lib.ts'

const push = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pushNow())
const pull = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pullNow())
const cardState = (p: Page, docId: string) => p.evaluate(async (docId) => (await (await import('/src/sync/sync.ts')).cardSyncStates()).get(docId), docId)
const setSetting = (p: Page, patch: Record<string, unknown>) => p.evaluate(async (patch) => (await import('/src/app/store.ts')).useUI.getState().setSettings(patch), patch)

/** 이 페이지의 Drive 요청을 센다 — 목록·메타(GET)와 본문 받기(alt=media)·쓰기(POST·PATCH·PUT)를 나눠서 */
function watchDrive(p: Page) {
  const log: { method: string; url: string }[] = []
  p.on('request', (r) => {
    if (r.url().includes('googleapis.com') && r.method() !== 'OPTIONS') log.push({ method: r.method(), url: r.url() })
  })
  return {
    reset: () => (log.length = 0),
    total: () => log.length,
    bodies: () => log.filter((l) => l.url.includes('alt=media')).length,
    writes: () => log.filter((l) => l.method !== 'GET').length
  }
}

export default async function comfort(ctx: Ctx) {
  const { base, check } = ctx
  const drive = createFakeDrive()
  const A = await device(ctx, { drive, name: 'PC' })
  const B = await device(ctx, { drive, name: 'iPad' })
  const netB = watchDrive(B)

  const D = await createDoc(A, '편의 노트')
  await addStroke(A, D, 'a')
  await push(A)
  await pull(B)
  await addStroke(A, D, 'b')
  await push(A) // B에게는 '받을 것'이 생긴다

  // ── 앱 열 때 확인: 꺼져 있으면(기본) 아무 요청도 없다 ──
  netB.reset()
  await B.reload()
  await B.waitForSelector('#root *')
  await sleep(800)
  check('열 때 확인(끔): 앱을 다시 열어도 Drive 요청 0', netB.total() === 0, String(netB.total()))

  // ── 켜면 목록만 읽어 판정을 새로 한다 ──
  await setSetting(B, { cloudCheckOnOpen: true })
  // waitForFunction은 async 조건을 기다려 주지 않는다(Promise가 곧 참) — 기록이 생길 때까지 직접 본다
  for (let i = 0; i < 75 && !(await B.evaluate(async () => !!(await (await import('/src/sync/folders.ts')).getSync('cloudCheck')))); i++) await sleep(200)
  check('열 때 확인(켬): 목록·메타만 읽는다 — 본문 받기·쓰기 없음', netB.total() > 0 && netB.bodies() === 0 && netB.writes() === 0, JSON.stringify({ t: netB.total(), b: netB.bodies(), w: netB.writes() }))
  check('열 때 확인(켬): 라이브러리 점이 받을 것으로', (await cardState(B, D)) === 'remote-new', String(await cardState(B, D)))
  check('열 때 확인(켬): 받지는 않는다', !(await strokes(B, D)).includes('b'))
  netB.reset()
  await B.reload()
  await B.waitForSelector('#root *')
  await sleep(800)
  check('열 때 확인(켬): 30분 안에 다시 열면 확인하지 않는다', netB.total() === 0, String(netB.total()))

  // ── 편집 화면의 노트 칩: 받기 ──
  await openEditor(B, base, D)
  const chipB = B.locator('.note-sync')
  await chipB.waitFor()
  check('노트 칩: 받을 것이면 "새 버전"', (await chipB.innerText()).includes('새 버전'), await chipB.innerText())
  await chipB.click()
  check('노트 칩 메뉴: 버전 기록·동기화 패널은 없다(툴바 메뉴에 있다)', (await B.getByRole('menuitem', { name: '버전 기록' }).count()) === 0 && (await B.getByRole('menuitem', { name: '동기화 패널' }).count()) === 0)
  await B.getByRole('menuitem', { name: '이 노트 받기' }).click()
  await B.waitForFunction(() => document.querySelector('.note-sync')?.textContent?.includes('동기화됨'), null, { timeout: 15000 })
  check('노트 칩: 받기로 새 버전을 받았다', (await strokes(B, D)).includes('b'))

  // ── 노트 칩: 그리면 '올리기 필요' → 올리기 ──
  await openEditor(A, base, D)
  const chipA = A.locator('.note-sync')
  await chipA.waitFor()
  await drawStroke(A)
  await A.waitForFunction(() => document.querySelector('.note-sync')?.textContent?.includes('올리기 필요'), null, { timeout: 15000 })
  check('노트 칩: 그린 뒤 "올리기 필요"', true)
  if (process.env.MERGE_SHOT_DIR) await A.screenshot({ path: `${process.env.MERGE_SHOT_DIR}/note-chip.png`, clip: { x: 0, y: 0, width: 1200, height: 140 } })
  const before = drive.headStrokes(D).length
  await chipA.click()
  await A.getByRole('menuitem', { name: '이 노트 올리기' }).or(A.getByRole('button', { name: '이 노트 올리기' })).first().click()
  await A.waitForFunction(() => document.querySelector('.note-sync')?.textContent?.includes('동기화됨'), null, { timeout: 15000 })
  check('노트 칩: 올리기로 main이 따라간다', drive.headStrokes(D).length === before + 1)

  // ── 노트를 닫을 때 알림 ──
  await drawStroke(A, 80)
  await sleep(700) // 저장
  await A.getByRole('button', { name: '문서 목록' }).click()
  const toast = A.locator('.toast', { hasText: '올리지 않은 변경이 있습니다' })
  await toast.waitFor({ timeout: 5000 })
  check('닫을 때 알림: 올리지 않은 변경이 있으면 알린다', (await toast.count()) === 1)

  // ── 라이브러리 할 일 배지 ──
  await A.waitForSelector('.library-header')
  await A.waitForSelector('.sync-btn .sync-badge', { timeout: 5000 })
  check('라이브러리 배지: 올릴 노트 1', (await A.locator('.sync-btn .sync-badge').innerText()) === '1')
  if (process.env.MERGE_SHOT_DIR) await A.screenshot({ path: `${process.env.MERGE_SHOT_DIR}/library-badge.png` })
  await toast.getByRole('button', { name: '정리' }).click() // 비교 화면에서 올리기
  await A.waitForSelector('.changes-sheet .changes-chip.add')
  check('닫을 때 알림: "정리"는 비교 화면 — 쓴 획이 보인다', (await A.locator('.changes-sheet .changes-chip.add').innerText()).includes('+1'))
  await A.locator('.changes-sheet').getByRole('button', { name: '올리기' }).click()
  await A.waitForSelector('.sync-btn .sync-badge', { state: 'detached', timeout: 15000 })
  check('닫을 때 알림: 비교 화면에서 올리면 배지가 사라진다', drive.headStrokes(D).length === before + 2)

  // ── 앱 아이콘 배지 (Badging API — 테스트에서는 흉내) ──
  const badge = await A.evaluate(async (D) => {
    const w = window as unknown as { __badge?: number | null }
    const nav = navigator as unknown as { setAppBadge: (n: number) => Promise<void>; clearAppBadge: () => Promise<void> }
    nav.setAppBadge = async (n: number) => void (w.__badge = n)
    nav.clearAppBadge = async () => void (w.__badge = null)
    const r = await import('/src/storage/repo.ts')
    const d = await r.loadDocument(D)
    await r.saveBatch({ documentId: D, chunks: [{ pageId: d.pages[0].id, key: '0_0', elements: d.chunks[0].elements.slice(0, 1) }] }) // 올리지 않은 변경 하나
    const rem = await import('/src/app/syncReminders.ts')
    await rem.refreshAppBadge()
    const withPending = w.__badge
    ;(await import('/src/app/store.ts')).useUI.getState().setSettings({ appBadge: false })
    await rem.refreshAppBadge()
    return { withPending, off: w.__badge }
  }, D)
  check('앱 아이콘 배지: 올릴 노트 수', badge.withPending === 1, JSON.stringify(badge))
  check('앱 아이콘 배지: 끄면 지운다', badge.off === null)

  const warn = [...logsOf(A), ...logsOf(B)].filter((t) => /노트 보호\(withDocExclusive\) 밖|미구현|열 때 확인을 하지 못했/.test(t))
  check('경고 없음', warn.length === 0, warn.join(' | '))
  await A.context().close()
  await B.context().close()
}
