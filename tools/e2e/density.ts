// 밀도 — 설정 > 밀도: 넉넉하게(기본) / 촘촘하게. <html data-density>로 크기 토큰(--h-control·--h-row·--fs-base)을 바꾼다
import type { Page } from 'playwright'
import { device, logsOf, sleep, type Ctx } from './lib.ts'

const sizes = (p: Page) =>
  p.evaluate(() => {
    const cs = getComputedStyle(document.documentElement)
    const h = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().height ?? 0
    return {
      density: document.documentElement.dataset.density,
      control: cs.getPropertyValue('--h-control').trim(),
      row: cs.getPropertyValue('--h-row').trim(),
      font: cs.getPropertyValue('--fs-base').trim(),
      tabbar: h('.tabbar'),
      dock: h('.dock'),
      pill: h('.dock-pill')
    }
  })

export default async function density(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  await p.waitForSelector('.tabbar .dock')

  const a = await sizes(p)
  check('기본은 넉넉하게', a.density === 'comfortable' && a.control === '38px' && a.row === '40px' && a.font === '14px', JSON.stringify(a))
  check('…탭 바가 컨트롤 높이를 따른다', a.tabbar === 38, JSON.stringify(a))
  check('…상태 칸: 누르는 자리는 32px 이상, 알약은 30px', a.dock >= 32 && a.pill === 30, JSON.stringify(a))
  const opt = await p.evaluate(async () => (await import('/src/engine/types.ts')).DEFAULT_SETTINGS.density)
  check('…설정 기본값도 넉넉하게', opt === 'comfortable')

  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setSettings({ density: 'compact' }))
  await sleep(100)
  const b = await sizes(p)
  check('촘촘하게: 예전 크기로', b.density === 'compact' && b.control === '34px' && b.row === '32px' && b.font === '13px' && b.tabbar === 34 && b.pill === 26, JSON.stringify(b))

  // 다시 열어도 첫 화면부터 그 밀도 (앱 코드가 뜨기 전 index.html이 맞춘다)
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' })
  const early = await p.evaluate(() => document.documentElement.dataset.density)
  check('다시 열어도 첫 화면부터 촘촘하게', early === 'compact', String(early))

  // 설정 화면에서 바꾸기
  await p.waitForSelector('.tabbar .dock')
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setPanel('settings'))
  const radio = p.getByRole('radio', { name: '넉넉하게' })
  if (await radio.count()) {
    await radio.click()
    await sleep(100)
    check('설정 화면의 밀도 고르기', (await sizes(p)).density === 'comfortable')
  } else {
    // 라이브러리에서는 설정이 시트로 열린다
    await p.locator('[aria-label="설정"]').first().click()
    await p.getByRole('radio', { name: '넉넉하게' }).click()
    await sleep(100)
    check('설정 화면의 밀도 고르기', (await sizes(p)).density === 'comfortable')
  }

  check('밀도: 콘솔 오류 없음', !logsOf(p).some((l) => /error/i.test(l) && !/favicon|401|Failed to load resource/.test(l)), logsOf(p).join('\n'))
  await p.context().close()
}
