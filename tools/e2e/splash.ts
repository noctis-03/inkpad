// 시작 화면: 노트 카드 → 줄 → 파란 획 → 'Inkpad'. 앱이 준비되고 모션 한 번(1.2초)이 끝나면 사라진다.
// 자동화된 브라우저는 기다리지 않게 바로 치운다 — ?splash 를 붙이면 그대로 보인다
import { device, sleep, type Ctx } from './lib.ts'

export default async function splash(ctx: Ctx) {
  const { base, check } = ctx
  const A = await device(ctx, { name: 'iPad' })
  check('테스트(자동화) 브라우저에서는 시작 화면이 없다', (await A.locator('#splash').count()) === 0)

  const shot = (name: string) => (process.env.MERGE_SHOT_DIR ? A.screenshot({ path: `${process.env.MERGE_SHOT_DIR}/${name}.png`, clip: { x: 400, y: 300, width: 400, height: 300 } }) : Promise.resolve())
  const t0 = Date.now()
  await A.goto(base + '/?splash')
  await A.waitForSelector('#splash')
  check('시작 화면이 뜬다', (await A.locator('#splash .sp-wave').count()) === 1)
  await sleep(250)
  await shot('splash-1')
  await sleep(450)
  await shot('splash-2')
  await sleep(500)
  await shot('splash-3')
  check('앱이 준비돼도 모션 한 번(1.2초)은 보인다', (await A.locator('#splash:not(.out)').count()) === 1 || Date.now() - t0 >= 1200)
  await A.waitForSelector('#splash', { state: 'detached', timeout: 5000 })
  check('그 뒤 사라진다', (await A.locator('#splash').count()) === 0 && (await A.locator('#root *').count()) > 0)

  // 다크 모드
  await A.evaluate(() => localStorage.setItem('inkpad.settings.v2', JSON.stringify({ ...JSON.parse(localStorage.getItem('inkpad.settings.v2') || '{}'), theme: 'dark' })))
  await A.goto(base + '/?splash')
  await A.waitForSelector('#splash')
  await sleep(1150)
  await shot('splash-dark')
  const bg = await A.evaluate(() => getComputedStyle(document.getElementById('splash')!).backgroundColor)
  check('다크 모드에서는 어두운 바탕', bg === 'rgb(22, 21, 19)', bg)
  await A.context().close()
}
