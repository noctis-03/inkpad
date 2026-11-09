// 공유 탭 바 — 기본 탭 바와 따로 탭을 갖고, Drive의 파일 하나(shared-tabs.json)로 기기끼리 올리고(↑) 불러온다(↓)
//  - 버튼은 모두 상태 칸의 제어 센터 쪽에: 새로고침, 탭 바 모드(기본/공유), 올리기·불러오기
//  - 기본 모드는 지금과 같다: 탭 바에 버튼이 없고, 올리기·불러오기는 막혀 있고, Drive 요청은 없다
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
  /** 상태 칸을 펼쳐 제어 센터 쪽으로 */
  const control = async (p: Page) => {
    await sleep(450) // 닫히는 중인 창이 사라질 때까지
    if (!(await p.locator('.dock-panel').count())) await p.click('.tabbar .dock')
    await p.locator('.dock-panel-head [role="radio"]', { hasText: '제어 센터' }).click()
    await sleep(400)
  }
  const mode = async (p: Page, m: '기본' | '공유') => {
    await control(p)
    await p.locator('.dock-ctl-seg [role="radio"]', { hasText: m }).click()
    await sleep(300)
  }
  /** 제어 센터의 올리기·불러오기를 누르고 끝날 때까지 */
  const act = async (p: Page, label: '공유 탭 올리기' | '공유 탭 불러오기') => {
    await control(p)
    await p.click(`.dock-panel [aria-label="${label}"]`)
    await p.waitForFunction(() => !document.querySelector('.dock-panel [aria-label="공유 탭 올리기"]')?.hasAttribute('disabled'))
    await sleep(300)
  }
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
  await control(A)
  const tabsTitles = await A.locator('.dock-panel-head [role="radio"]').allInnerTexts()
  check('제어 센터: 상태 칸 쪽 목록에 있다', tabsTitles.includes('제어 센터'), JSON.stringify(tabsTitles))
  check('제어 센터: 새로고침 버튼', (await A.locator('.dock-panel .dock-ctl', { hasText: '새로고침' }).count()) === 1)
  const locked =
    (await A.locator('.dock-panel [aria-label="공유 탭 올리기"]').isDisabled()) && (await A.locator('.dock-panel [aria-label="공유 탭 불러오기"]').isDisabled())
  check('기본 모드: 올리기·불러오기는 막혀 있고 탭 바에 표시 없음', locked && !(await A.locator('.tabbar.is-shared').count()))

  // ── 공유 모드로 ──
  await mode(A, '공유')
  await A.waitForSelector('.tabbar.is-shared')
  await A.keyboard.press('Escape')
  await sleep(200)
  check('공유 모드: 공유 탭은 비어 있고 보던 기본 탭에서 홈으로', (await keys(A)).length === 0, JSON.stringify(await keys(A)))
  await control(A)
  check('공유 모드: 올리기·불러오기를 누를 수 있다', !(await A.locator('.dock-panel [aria-label="공유 탭 올리기"]').isDisabled()))
  await go(A, { name: 'editor', docId: N1 })
  await go(A, { name: 'editor', docId: N2 })
  await go(A, { name: 'editor', docId: N3 })
  await sleep(300)
  check('공유 모드: 연 노트가 공유 탭에', JSON.stringify(await keys(A)) === JSON.stringify([`doc:${N1}`, `doc:${N2}`, `doc:${N3}`]), JSON.stringify(await keys(A)))
  check('원칙: 모드를 바꾸고 탭을 열어도 Drive 요청 0', driveReq === 0, String(driveReq))

  // 기본으로 돌아가면 기본 탭 그대로, 다시 공유로 오면 공유 탭 그대로 (새로고침 뒤에도)
  await mode(A, '기본')
  check('기본으로 돌아오면 기본 탭 그대로', JSON.stringify(await keys(A)) === JSON.stringify([`doc:${L}`]), JSON.stringify(await keys(A)))
  await mode(A, '공유')
  await A.locator('.dock-panel .dock-ctl', { hasText: '새로고침' }).click()
  await A.waitForSelector('.tabbar.is-shared')
  await sleep(500)
  check('새로고침해도 공유 모드와 공유 탭이 남는다', (await keys(A)).length === 3, JSON.stringify(await keys(A)))

  // ── 올리기 ──
  await act(A, '공유 탭 올리기')
  const files = () => [...drive.files.values()].filter((f) => f.name === 'shared-tabs.json' && !f.trashed)
  check('올리기: Drive에 shared-tabs.json 하나', files().length === 1, String(files().length))

  // ── B가 불러오기 ──
  await mode(B, '공유')
  await B.waitForSelector('.tabbar.is-shared')
  await act(B, '공유 탭 불러오기')
  check('불러오기: B가 A의 공유 탭을 본다 (B에 없는 노트는 뺀다)', JSON.stringify(await keys(B)) === JSON.stringify([`doc:${N1}`, `doc:${N2}`]), JSON.stringify(await keys(B)))
  const note = await B.evaluate(async () => (await import('/src/shared/notices.ts')).getNotices().map((n) => n.text))
  check('불러오기: 뺀 개수를 알린다', note.some((t) => t.includes('1개는 뺐습니다')), JSON.stringify(note))

  // ── B가 바꿔 올리면 A가 불러와 같은 파일을 돌려 쓴다 ──
  await B.evaluate(async (k) => {
    const s = (await import('/src/app/store.ts')).useUI.getState()
    s.closeTab(s.tabs.find((t) => t.name === 'editor' && t.docId === k)!)
  }, N1)
  await act(B, '공유 탭 올리기')
  check('다시 올려도 파일은 하나 (덮어쓴다)', files().length === 1, String(files().length))
  await act(A, '공유 탭 불러오기')
  check('A가 불러오면 B가 올린 탭', JSON.stringify(await keys(A)) === JSON.stringify([`doc:${N2}`]), JSON.stringify(await keys(A)))

  // 기본 탭은 공유 탭 불러오기와 상관없다
  await mode(A, '기본')
  check('공유 탭을 불러와도 기본 탭은 그대로', JSON.stringify(await keys(A)) === JSON.stringify([`doc:${L}`]), JSON.stringify(await keys(A)))
  await A.context().close()
  await B.context().close()
}
