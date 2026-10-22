// 카드 여는 판: 격자에서 노트 카드를 누르면 큰 '편집'과 작은 '보기'·'낙서'. 판은 카드 아래쪽, 위쪽 미리보기는 흐리지 않는다.
// 카드 종이는 테마와 상관없이 밝으므로 판도 다크에서 먹·종이 그대로(예전엔 다크에서 글자가 종이에 묻혔다)
import type { Page } from 'playwright'
import { createDoc, device, sleep, type Ctx } from './lib.ts'

const revealed = (p: Page) => p.locator('.doc-card.is-revealed')
const tapTopOf = async (p: Page, sel: string) => {
  const box = (await p.locator(sel).boundingBox())!
  await p.mouse.click(box.x + box.width / 2, box.y + box.height * 0.15)
}

export default async function openpanel(ctx: Ctx) {
  const { base, check } = ctx
  const A = await device(ctx, { name: 'iPad' })
  await createDoc(A, '판 노트', 2)
  await A.goto(base + '/')
  const card = A.locator('.doc-card', { hasText: '판 노트' })
  await card.waitFor()
  await card.locator('.doc-thumb').click()
  await revealed(A).waitFor()
  await sleep(450) // 판이 떠오르는 움직임이 끝나게

  const main = revealed(A).locator('.doc-open-main')
  const subs = revealed(A).locator('.doc-open-sub')
  const texts = { main: (await main.innerText()).trim(), subs: (await subs.allInnerTexts()).map((t) => t.replace(/\s+/g, '')) }
  check('판: 큰 편집 하나와 보기·낙서', texts.main === '편집' && texts.subs.join(',') === '보기,낙서', JSON.stringify(texts))
  check('판: 낙서는 점선으로 구분', (await revealed(A).locator('.doc-open-sub.is-scratch').count()) === 1)
  check('판: 버튼 이름은 모드를 말한다(화면 낭독기)', (await revealed(A).getByRole('button', { name: '편집모드' }).count()) === 1 && (await revealed(A).getByRole('button', { name: '낙서모드' }).count()) === 1)
  const heights = await A.evaluate(() => [...document.querySelectorAll('.doc-card.is-revealed .doc-open-main, .doc-card.is-revealed .doc-open-sub')].map((e) => Math.round(e.getBoundingClientRect().height)))
  check('판: 누르기 넉넉한 크기(편집 44 · 보기/낙서 40)', heights.join(',') === '44,40,40', heights.join(','))

  // 다크에서도 판은 먹·종이 — 테마를 따라 뒤집히지 않는다
  await A.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  const dark = await A.evaluate(() => {
    const cs = (sel: string) => getComputedStyle(document.querySelector(`.doc-card.is-revealed ${sel}`)!)
    return { meta: cs('.doc-open-meta').color, metaBg: cs('.doc-open-meta').backgroundColor, main: cs('.doc-open-main').backgroundColor }
  })
  check('판: 다크에서도 먹색 글자 · 종이 바탕', dark.meta === 'rgb(43, 42, 38)' && dark.metaBg === 'rgb(255, 255, 255)' && dark.main === 'rgb(43, 42, 38)', JSON.stringify(dark))
  await A.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))

  // 흐리지 않은 위쪽을 눌러도 닫힌다(버튼 밖)
  await tapTopOf(A, '.doc-card.is-revealed .doc-thumb')
  await sleep(200)
  check('판: 위쪽을 누르면 닫힌다', (await revealed(A).count()) === 0)

  // 보기 → 읽기 전용으로 연다
  await card.locator('.doc-thumb').click()
  await revealed(A).waitFor()
  await sleep(450)
  await revealed(A).getByRole('button', { name: '뷰어보드' }).click()
  await A.waitForFunction(() => !!(window as unknown as { inkpad?: unknown }).inkpad && !document.querySelector('.doc-skeleton'), null, { timeout: 15000 })
  await sleep(500) // 편집 잠금 판정(읽기 전용) 뒤에 툴바가 바뀐다
  // 읽기 전용이면 이름 바꾸기 연필과 노트 동기화 칩이 없다 (편집모드라면 둘 다 있다)
  const ro = { titleEdit: await A.locator('.doc-title-edit').count(), hash: await A.evaluate(() => location.hash) }
  check('판: 보기는 읽기 전용(뷰어보드)으로 연다', ro.titleEdit === 0 && ro.hash.startsWith('#/doc/'), JSON.stringify(ro))

  await A.context().close()
}
