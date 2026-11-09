// 공유 탭 바 — 기본 탭 바와 따로 탭을 갖고, Drive의 파일 하나(shared-tabs.json)로 기기끼리 올리고(↑) 불러온다(↓)
//  - 기본 모드는 지금과 같다: 버튼 하나(모드 전환)만 보이고 Drive 요청은 없다
//  - 공유 모드로 바꾸면 공유 탭이 따로 보이고, 기본으로 돌아오면 기본 탭이 그대로다
//  - A가 올리면 B가 불러와 같은 탭을 본다. B에 없는 항목은 빼고 알린다. 다시 올리면 같은 파일을 덮는다
import { createFakeDrive } from './fake-drive.ts'
import { createDoc, device, sleep, type Ctx } from './lib.ts'
import type { Page } from 'playwright'

export default async function sharedtabs(ctx: Ctx) {
  const { check } = ctx
  const drive = createFakeDrive()
  const A = await device(ctx, { drive, name: 'A' })
  const B = await device(ctx, { drive, name: 'B' })
  let driveReq = 0
  A.context().on('request', (r) => {
    if (r.url().includes('googleapis.com')) driveReq++
  })

  const go = (p: Page, r: object) => p.evaluate(async (r) => (await import('/src/app/store.ts')).useUI.getState().navigate(r as never), r)
  const keys = (p: Page) => p.locator('.tabbar .tab[data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab))
  const push = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pushNow())
  const pull = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pullNow())

  const N1 = await createDoc(A, '공유 노트 1')
  const N2 = await createDoc(A, '공유 노트 2')
  const L = await createDoc(A, '기본 노트')
  await push(A)
  await pull(B)
  const N3 = await createDoc(A, 'A에만 있는 노트')

  // ── 기본 모드 ──
  await go(A, { name: 'editor', docId: L })
  await A.waitForSelector('.pane-main .editor')
  await sleep(300)
  driveReq = 0
  const basic = (await A.locator('.tabbar-share .tabbar-btn').count()) === 1 && !(await A.locator('.tabbar.is-shared').count())
  check('기본 모드: 모드 전환 버튼만 보인다 (올리기·불러오기 없음)', basic)

  // ── 공유 모드로 ──
  await A.click('.tabbar-share .tabbar-btn[aria-pressed]')
  await A.waitForSelector('.tabbar.is-shared')
  await sleep(200)
  check('공유 모드: 공유 탭은 비어 있고 보던 기본 탭에서 홈으로', (await keys(A)).length === 0, JSON.stringify(await keys(A)))
  check('공유 모드: 올리기·불러오기 버튼', (await A.locator('[aria-label="공유 탭 올리기"]').count()) === 1 && (await A.locator('[aria-label="공유 탭 불러오기"]').count()) === 1)
  await go(A, { name: 'editor', docId: N1 })
  await go(A, { name: 'editor', docId: N2 })
  await go(A, { name: 'editor', docId: N3 })
  await sleep(300)
  check('공유 모드: 연 노트가 공유 탭에', JSON.stringify(await keys(A)) === JSON.stringify([`doc:${N1}`, `doc:${N2}`, `doc:${N3}`]), JSON.stringify(await keys(A)))
  check('원칙: 모드를 바꾸고 탭을 열어도 Drive 요청 0', driveReq === 0, String(driveReq))

  // 기본으로 돌아가면 기본 탭 그대로, 다시 공유로 오면 공유 탭 그대로 (새로고침 뒤에도)
  await A.click('.tabbar-share .tabbar-btn[aria-pressed]')
  await sleep(300)
  check('기본으로 돌아오면 기본 탭 그대로', JSON.stringify(await keys(A)) === JSON.stringify([`doc:${L}`]), JSON.stringify(await keys(A)))
  await A.click('.tabbar-share .tabbar-btn[aria-pressed]')
  await A.reload()
  await A.waitForSelector('.tabbar.is-shared')
  await sleep(500)
  check('새로고침해도 공유 모드와 공유 탭이 남는다', (await keys(A)).length === 3, JSON.stringify(await keys(A)))

  // ── 올리기 ──
  await A.click('[aria-label="공유 탭 올리기"]')
  await A.waitForFunction(() => !document.querySelector('[aria-label="공유 탭 올리기"]')?.hasAttribute('disabled'))
  await sleep(300)
  const files = () => [...drive.files.values()].filter((f) => f.name === 'shared-tabs.json' && !f.trashed)
  check('올리기: Drive에 shared-tabs.json 하나', files().length === 1, String(files().length))

  // ── B가 불러오기 ──
  await B.click('.tabbar-share .tabbar-btn[aria-pressed]')
  await B.waitForSelector('.tabbar.is-shared')
  await B.click('[aria-label="공유 탭 불러오기"]')
  await B.waitForFunction(() => document.querySelectorAll('.tabbar .tab[data-tab]').length > 0)
  await sleep(300)
  check('불러오기: B가 A의 공유 탭을 본다 (B에 없는 노트는 뺀다)', JSON.stringify(await keys(B)) === JSON.stringify([`doc:${N1}`, `doc:${N2}`]), JSON.stringify(await keys(B)))
  const note = await B.locator('.dock-notice-text, .toast').allInnerTexts()
  check('불러오기: 뺀 개수를 알린다', note.some((t) => t.includes('1개는 뺐습니다')), JSON.stringify(note))

  // ── B가 바꿔 올리면 A가 불러와 같은 파일을 돌려 쓴다 ──
  await B.evaluate(async (k) => {
    const s = (await import('/src/app/store.ts')).useUI.getState()
    s.closeTab(s.tabs.find((t) => t.name === 'editor' && t.docId === k)!)
  }, N1)
  await B.click('[aria-label="공유 탭 올리기"]')
  await B.waitForFunction(() => !document.querySelector('[aria-label="공유 탭 올리기"]')?.hasAttribute('disabled'))
  await sleep(300)
  check('다시 올려도 파일은 하나 (덮어쓴다)', files().length === 1, String(files().length))
  await A.click('[aria-label="공유 탭 불러오기"]')
  await A.waitForFunction(() => document.querySelectorAll('.tabbar .tab[data-tab]').length === 1)
  check('A가 불러오면 B가 올린 탭', JSON.stringify(await keys(A)) === JSON.stringify([`doc:${N2}`]), JSON.stringify(await keys(A)))

  // 기본 탭은 공유 탭 불러오기와 상관없다
  await A.click('.tabbar-share .tabbar-btn[aria-pressed]')
  await sleep(300)
  check('공유 탭을 불러와도 기본 탭은 그대로', JSON.stringify(await keys(A)) === JSON.stringify([`doc:${L}`]), JSON.stringify(await keys(A)))
  await A.context().close()
  await B.context().close()
}
