// 카드를 탭 바로 끌기: 꾹 누르면 원형 메뉴, 가운데서 더 누르고 있으면 카드가 집힌다.
// 탭 바에 놓으면 그 자리에 탭이 생긴다(열리지 않는다). 다른 곳에 놓으면 아무것도 바뀌지 않는다
import type { Page } from 'playwright'
import { createDoc, device, sleep, type Ctx } from './lib.ts'

const card = (p: Page, title: string) => p.locator('.doc-card', { hasText: title })
const tabKeys = (p: Page) => p.locator('.tabbar .tab[data-tab]').evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.tab))

/** 카드를 꾹(원형 메뉴 + 더 누르기) 눌러 집고 (x, y)로 옮겨 놓는다. mid는 놓기 직전에 확인할 것 */
async function dragCard(p: Page, title: string, x: number, y: number, mid?: () => Promise<void>) {
  const b = (await card(p, title).locator('.doc-thumb').boundingBox())!
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await p.mouse.down()
  await sleep(1150)
  await p.mouse.move(x, y, { steps: 12 })
  await sleep(120)
  if (mid) await mid()
  await p.mouse.up()
  await sleep(400)
}

export default async function cardtab(ctx: Ctx) {
  const { base, check } = ctx
  const A = await device(ctx, { name: 'iPad' })
  const ids: Record<string, string> = {}
  for (const t of ['가 노트', '나 노트', '다 노트']) ids[t] = await createDoc(A, t)
  await A.goto(base + '/')
  await A.waitForSelector('.doc-card')
  await sleep(400)
  const before = await tabKeys(A)

  // 다른 곳에 놓으면: 제자리로 — 탭은 그대로
  await dragCard(A, '가 노트', 400, 600)
  check('탭 바 밖에 놓기: 탭이 바뀌지 않는다', JSON.stringify(await tabKeys(A)) === JSON.stringify(before), JSON.stringify(await tabKeys(A)))
  check('탭 바 밖에 놓기: 끌던 모습이 남지 않는다', (await A.locator('.card-drag, .tab-drop-line, .doc-card.is-drag-source').count()) === 0)
  check('탭 바 밖에 놓기: 선택 모드가 아니다', (await A.locator('.library-header.is-selecting').count()) === 0)

  // 탭 바에 놓으면: 탭이 생기고 화면은 그대로 라이브러리
  const bar = (await A.locator('.tabbar .tabbar-scroll').boundingBox())!
  await dragCard(A, '가 노트', bar.x + 40, bar.y + bar.height / 2, async () => {
    check('탭 바 위: 들어갈 자리 선이 뜬다', (await A.locator('.tab-drop-line.is-on').count()) === 1)
    check('탭 바 위: 탭 바가 놓을 곳으로 보인다', (await A.locator('.tabbar.is-drop-target').count()) === 1)
    if (process.env.MERGE_SHOT_DIR) await A.screenshot({ path: `${process.env.MERGE_SHOT_DIR}/cardtab-over.png`, clip: { x: 0, y: 0, width: 900, height: 400 } })
  })
  let keys = await tabKeys(A)
  check('탭 바에 놓기: 탭이 생긴다', keys.includes('doc:' + ids['가 노트']), JSON.stringify(keys))
  check('탭 바에 놓기: 열리지 않는다(라이브러리 그대로)', !A.url().includes('/doc/') && (await A.locator('.tab.is-active[data-tab]').count()) === 0, A.url())
  check('탭 바에 놓기: 탭 제목이 붙는다', (await A.locator(`.tab[data-tab="doc:${ids['가 노트']}"] .tab-title`).innerText()) === '가 노트')

  // 두 번째 카드를 첫 탭 앞에 놓기 → 맨 앞
  const first = (await A.locator('.tabbar .tab[data-tab]').first().boundingBox())!
  await dragCard(A, '나 노트', first.x + 4, first.y + first.height / 2)
  keys = await tabKeys(A)
  check('놓은 자리에 들어간다(맨 앞)', keys[0] === 'doc:' + ids['나 노트'], JSON.stringify(keys))

  // 이미 있는 탭을 다시 끌어 놓으면 둘이 되지 않는다
  const last = (await A.locator('.tabbar .tab[data-tab]').last().boundingBox())!
  await dragCard(A, '나 노트', last.x + last.width - 4, last.y + last.height / 2)
  keys = await tabKeys(A)
  check('이미 있는 탭: 하나만 — 놓은 자리로 옮긴다', keys.filter((k) => k === 'doc:' + ids['나 노트']).length === 1 && keys[keys.length - 1] === 'doc:' + ids['나 노트'], JSON.stringify(keys))

  // 원형 메뉴에서 방향으로 밀었다가 가운데로 돌아와 기다려도 집히지 않는다(마킹·선택 고르기 그대로)
  const b = (await card(A, '다 노트').locator('.doc-thumb').boundingBox())!
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  await A.mouse.move(cx, cy)
  await A.mouse.down()
  await sleep(650)
  await A.mouse.move(cx + 60, cy, { steps: 3 })
  await A.mouse.move(cx, cy, { steps: 3 })
  await sleep(700)
  check('밀었다 돌아오면 집히지 않는다', (await A.locator('.card-drag').count()) === 0 && (await A.locator('.radial').count()) === 1)
  await A.mouse.up()
  await sleep(250)
  check('그대로 가운데서 떼면 선택 모드', (await A.locator('.library-header.is-selecting').count()) === 1)
}
