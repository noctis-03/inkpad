// 선택 모드·마킹: 카드를 꾹 누르면 선택 모드(상단 바가 바뀐다), 고른 카드에 ○·✕·! 중 하나를 붙인다 — 이 기기에만 저장
import type { Page } from 'playwright'
import { createDoc, device, sleep, type Ctx } from './lib.ts'

const card = (p: Page, title: string) => p.locator('.doc-card', { hasText: title })
const marksOf = (p: Page) => p.evaluate(async () => (await import('/src/storage/repo.ts')).getMarks())
async function longPress(p: Page, title: string, ms = 700) {
  const b = (await card(p, title).locator('.doc-thumb').boundingBox())!
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await p.mouse.down()
  await sleep(ms)
  await p.mouse.up()
  await sleep(250)
}

/** 꾹 누른 채로 (dx, dy)만큼 밀고 뗀다 — 원형 메뉴. mid는 떼기 직전에 확인할 것 */
async function swipe(p: Page, title: string, dx: number, dy: number, mid?: () => Promise<void>) {
  const b = (await card(p, title).locator('.doc-thumb').boundingBox())!
  const x = b.x + b.width / 2
  const y = b.y + b.height / 2
  await p.mouse.move(x, y)
  await p.mouse.down()
  await sleep(700)
  await p.mouse.move(x + dx / 2, y + dy / 2, { steps: 3 })
  await p.mouse.move(x + dx, y + dy, { steps: 3 })
  await sleep(80)
  if (mid) await mid()
  await p.mouse.up()
  await sleep(250)
}

export default async function marks(ctx: Ctx) {
  const { base, check } = ctx
  const A = await device(ctx, { name: 'iPad' })
  const ids: Record<string, string> = {}
  for (const t of ['가 노트', '나 노트', '다 노트']) ids[t] = await createDoc(A, t)
  const metaOf = () => A.evaluate(async () => (await (await import('/src/storage/repo.ts')).listDocuments()).map((d) => [d.id, d.updatedAt]).sort().join())
  const meta0 = await metaOf()
  await A.goto(base + '/')
  await A.waitForSelector('.doc-card')
  await sleep(400)

  // 짧게 누르면 지금처럼 여는 창(오버레이) — 선택 모드가 아니다
  await longPress(A, '가 노트', 120)
  check('짧게 누름: 선택 모드가 아니고 여는 창이 뜬다', (await A.locator('.library-header.is-selecting').count()) === 0 && (await card(A, '가 노트').evaluate((e) => e.classList.contains('is-revealed'))))
  await A.keyboard.press('Escape')
  await A.mouse.click(5, 300)
  await sleep(300)

  // 꾹 누름 → 선택 모드, 누른 카드가 선택된다(열리지 않는다)
  await longPress(A, '가 노트')
  check('꾹 누름: 상단 바가 선택 모드로 바뀐다', (await A.locator('.library-header.is-selecting').count()) === 1 && (await A.locator('.search-box').count()) === 0)
  check('꾹 누름: 누른 카드가 선택되고 여는 창은 뜨지 않는다', (await A.locator('.doc-card.is-selected').count()) === 1 && (await card(A, '가 노트').evaluate((e) => e.classList.contains('is-selected') && !e.classList.contains('is-revealed'))))
  check('선택 모드: "1개 선택됨"', (await A.locator('.sel-title').innerText()).replace(/\s/g, '') === '1개선택됨')
  if (process.env.MERGE_SHOT_DIR) await A.screenshot({ path: `${process.env.MERGE_SHOT_DIR}/marks-select.png`, clip: { x: 0, y: 0, width: 1200, height: 420 } })

  // 탭은 선택/해제
  await card(A, '나 노트').click()
  await sleep(150)
  check('선택 모드에서 탭: 열지 않고 선택에 더한다', (await A.locator('.doc-card.is-selected').count()) === 2 && A.url().endsWith('/'))

  // ○ 붙이기 → 둘 다 ○
  await A.getByRole('button', { name: '동그라미' }).click()
  await sleep(200)
  let m = await marksOf(A)
  check('○: 고른 카드 둘에 붙는다', m['doc:' + ids['가 노트']] === 'o' && m['doc:' + ids['나 노트']] === 'o' && !m['doc:' + ids['다 노트']], JSON.stringify(m))
  check('○: 카드에 표시', (await A.locator('.card-mark.mark-o').count()) === 2)
  // ✕ → 하나만 붙는다(○가 ✕로 바뀐다)
  await A.getByRole('button', { name: '엑스' }).click()
  await sleep(200)
  m = await marksOf(A)
  check('✕: 하나만 — ○가 ✕로 바뀐다', m['doc:' + ids['가 노트']] === 'x' && m['doc:' + ids['나 노트']] === 'x' && (await A.locator('.card-mark.mark-o').count()) === 0 && (await A.locator('.card-mark.mark-x').count()) === 2)
  check('✕: 버튼이 눌린 상태로 보인다', (await A.getByRole('button', { name: '엑스' }).getAttribute('aria-pressed')) === 'true')
  // 이미 모두 ✕인데 ✕ → 뗀다
  await A.getByRole('button', { name: '엑스' }).click()
  await sleep(200)
  check('같은 마킹을 한 번 더: 뗀다', Object.keys(await marksOf(A)).length === 0 && (await A.locator('.card-mark').count()) === 0)
  // ! 붙이고 하나만 해제한 뒤 마킹 지우기
  await A.getByRole('button', { name: '느낌표' }).click()
  await sleep(150)
  await card(A, '가 노트').click() // 선택 해제
  await sleep(100)
  await A.getByRole('button', { name: '마킹 지우기' }).click()
  await sleep(200)
  m = await marksOf(A)
  check('마킹 지우기: 고른 카드만 뗀다', m['doc:' + ids['가 노트']] === '!' && !m['doc:' + ids['나 노트']], JSON.stringify(m))
  if (process.env.MERGE_SHOT_DIR) await A.screenshot({ path: `${process.env.MERGE_SHOT_DIR}/marks-after.png`, clip: { x: 0, y: 0, width: 1200, height: 420 } })

  // 전체 선택
  await A.getByRole('button', { name: '전체 선택' }).click()
  await sleep(100)
  check('전체 선택', (await A.locator('.doc-card.is-selected').count()) === 3 && (await A.locator('.sel-title').innerText()).startsWith('3'))
  await A.getByRole('button', { name: '모두 해제' }).click()
  await sleep(100)
  check('모두 해제: 선택 모드는 그대로', (await A.locator('.doc-card.is-selected').count()) === 0 && (await A.locator('.library-header.is-selecting').count()) === 1)

  // 완료 → 평소 상단 바, 탭은 다시 여는 창
  await A.getByRole('button', { name: '완료' }).click()
  await sleep(200)
  check('완료: 평소 상단 바로', (await A.locator('.library-header.is-selecting').count()) === 0 && (await A.locator('.search-box').count()) === 1 && (await A.locator('.card-check').count()) === 0)

  // 이 기기에만 — 노트(수정 시각)를 건드리지 않고, 다시 열어도 남는다
  check('마킹은 노트를 건드리지 않는다(수정 시각 그대로)', (await metaOf()) === meta0)
  await A.reload()
  await A.waitForSelector('.doc-card')
  await sleep(300)
  check('다시 열어도 마킹이 남는다', (await card(A, '가 노트').locator('.card-mark.mark-ex').count()) === 1)
  check('마킹한 카드는 테두리가 마킹 색', (await card(A, '가 노트').locator('.doc-thumb').evaluate((e) => getComputedStyle(e).boxShadow)).includes('rgb(217, 119, 6)'))

  // ── 원형 메뉴: 꾹 누른 채로 밀어 떼면 바로 마킹 ──
  const markOf = async (t: string) => (await marksOf(A))['doc:' + ids[t]]
  const notSelecting = async () => (await A.locator('.library-header.is-selecting').count()) === 0
  await swipe(A, '나 노트', 0, -70, async () => {
    check('원형 메뉴: 꾹 누르면 뜨고, 위로 밀면 ○가 강조된다', (await A.locator('.radial').count()) === 1 && (await A.locator('.radial-item.at-up.is-hot.mark-o').count()) === 1)
  })
  check('원형 메뉴 위 → ○ (선택 모드로 가지 않는다)', (await markOf('나 노트')) === 'o' && (await notSelecting()) && (await A.locator('.radial').count()) === 0)
  await swipe(A, '나 노트', 0, -70, async () => {
    check('원형 메뉴: 이미 붙은 마킹은 테두리로 표시', (await A.locator('.radial-item.at-up.is-current').count()) === 1)
  })
  check('원형 메뉴: 같은 마킹 쪽으로 떼면 뗀다', (await markOf('나 노트')) === undefined)
  await swipe(A, '다 노트', 70, 0)
  check('원형 메뉴 오른쪽 → ✕', (await markOf('다 노트')) === 'x')
  await swipe(A, '다 노트', -70, 0)
  check('원형 메뉴 왼쪽 → 지우기', (await markOf('다 노트')) === undefined)
  await swipe(A, '다 노트', 0, 260)
  check('원형 메뉴: 멀리 나가 떼면 취소', (await markOf('다 노트')) === undefined && (await notSelecting()))
  check('원형 메뉴: 떼고 나면 카드가 열리지 않는다', (await A.locator('.doc-card.is-revealed').count()) === 0 && (await A.locator('.editor, .canvas-root, #canvas-root').count()) === 0)
  // 선택 모드에서 선택된 카드를 밀면 선택된 카드 전부에
  await longPress(A, '나 노트')
  await card(A, '다 노트').click()
  await sleep(150)
  await swipe(A, '나 노트', 0, 70)
  check('선택 모드: 선택된 카드에서 아래 → 선택된 카드 모두 !', (await markOf('나 노트')) === '!' && (await markOf('다 노트')) === '!' && (await A.locator('.library-header.is-selecting').count()) === 1)
  await A.getByRole('button', { name: '완료' }).click()
  await sleep(200)

  // 영구 삭제한 노트의 마킹은 정리된다
  await A.evaluate(async (id) => (await import('/src/storage/repo.ts')).purgeDocument(id), ids['가 노트'])
  await A.reload()
  await A.waitForSelector('.doc-card')
  await sleep(300)
  check('영구 삭제한 노트의 마킹은 정리', !(('doc:' + ids['가 노트']) in (await marksOf(A))))
  await A.context().close()

  // ── 터치(아이패드처럼): 손가락으로 꾹 누른 채 밀어도 스크롤되지 않고 원형 메뉴가 고른다 ──
  const B = await device(ctx, { name: 'iPad', touch: true })
  const tid: Record<string, string> = {}
  for (let i = 0; i < 30; i++) tid['t' + i] = await createDoc(B, '터치 노트 ' + String(i).padStart(2, '0'))
  await B.goto(base + '/')
  await B.waitForSelector('.doc-card')
  await sleep(400)
  const cdp = await B.context().newCDPSession(B)
  const tb = (await card(B, '터치 노트 29').locator('.doc-thumb').boundingBox())!
  const tx = tb.x + tb.width / 2
  const ty = tb.y + tb.height / 2
  const scrollTop = () => B.evaluate(() => Math.max(...[...document.querySelectorAll('.library-main, .library-body, html')].map((e) => e.scrollTop)))
  const s0 = await scrollTop()
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx, y: ty }] })
  await sleep(700)
  for (let k = 1; k <= 6; k++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tx, y: ty - k * 12 }] })
    await sleep(30)
  }
  const hot = await B.locator('.radial-item.at-up.is-hot').count()
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(300)
  check('터치: 꾹 누른 채 위로 밀면 ○가 강조된다', hot === 1)
  check('터치: 떼면 ○ — 화면은 스크롤되지 않는다', (await marksOf(B))['doc:' + tid['t29']] === 'o' && (await scrollTop()) === s0)
  await B.context().close()
}
