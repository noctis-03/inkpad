// 알림(토스트) — 탭 바 오른쪽 상태 칸이 그 자리에서 알림창으로 커진다(알림 쪽으로 넘어가며).
// 알림이 모두 사라지면 다시 칸으로 줄어들고, 칸에는 마지막 알림이 남는다. 알림창을 누르면 자세히 보는 창(알림 쪽).
// 글자·동작 버튼은 라이트·다크 모두 알림창 위에서 4.5:1 이상
import { device, sleep, type Ctx } from './lib.ts'

export default async function toast(ctx: Ctx) {
  const { check } = ctx
  const p = await device(ctx)
  const say = (text: string, kind: 'info' | 'success' | 'error', action?: boolean) =>
    p.evaluate(
      async ([text, kind, action]) => {
        const ui = (await import('/src/app/store.ts')).useUI.getState()
        ui.toast(text as string, kind as 'info', action ? { label: '되돌리기', run: () => {} } : undefined, { sticky: true })
      },
      [text, kind, action] as const
    )
  const clearAll = () =>
    p.evaluate(async () => {
      const ui = (await import('/src/app/store.ts')).useUI.getState()
      for (const t of ui.toasts) ui.dismissToast(t.id)
    })

  for (const theme of ['light', 'dark'] as const) {
    // 앱은 스토어가 바뀔 때마다 설정(기본 '자동' = 기기 외관)으로 테마를 다시 칠한다 — 기기 외관을 바꾼다
    await p.emulateMedia({ colorScheme: theme })
    await sleep(100)
    await say('노트를 휴지통으로 옮겼습니다.', 'info', true)
    await sleep(700) // 커지는 애니메이션
    const r = await p.evaluate(() => {
      const card = document.querySelector('.dock-notice')!
      const row = [...card.querySelectorAll('.toast')][0]
      const rgb = (s: string) => {
        const v = (s.match(/[\d.]+/g) ?? []).map(Number)
        return s.startsWith('color(srgb') ? v.slice(0, 3).map((x) => x * 255) : v.slice(0, 3)
      }
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
      }
      const ratio = (a: number[], b: number[]) => {
        const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x)
        return (l1 + 0.05) / (l2 + 0.05)
      }
      const bg = rgb(getComputedStyle(card).backgroundColor)
      const btn = row.querySelector('.dock-notice-action')!
      return {
        text: ratio(rgb(getComputedStyle(row.querySelector('.dock-notice-text')!).color), bg),
        action: ratio(rgb(getComputedStyle(btn).color), rgb(getComputedStyle(btn).backgroundColor))
      }
    })
    check(`알림창(${theme}): 테마가 적용됐다`, (await p.evaluate(() => document.documentElement.dataset.theme)) === theme)
    check(`알림창(${theme}): 글자 4.5:1 이상`, r.text >= 4.5, r.text.toFixed(2))
    check(`알림창(${theme}): 동작 버튼 4.5:1 이상`, r.action >= 4.5, r.action.toFixed(2))
    await clearAll()
    await sleep(700)
  }

  // ── 칸이 알림창이 된다 — 칸 자리(오른쪽 위 모서리)에서 커지고, 그동안 칸은 숨는다 ──
  await p.emulateMedia({ colorScheme: 'light' })
  const pillBox = await p.evaluate(() => document.querySelector('.dock-pill')!.getBoundingClientRect().toJSON())
  await say('첫 번째 알림', 'info')
  const grow: number[] = []
  for (let i = 0; i < 6; i++) {
    const w = await p.evaluate(() => document.querySelector('.dock-notice')?.getBoundingClientRect().width ?? 0)
    if (w) grow.push(w)
    await sleep(40)
  }
  await sleep(600)
  const at = await p.evaluate(() => {
    const c = document.querySelector('.dock-notice')!.getBoundingClientRect()
    return { right: c.right, top: c.top, width: c.width, hidden: !!document.querySelector('.dock.is-noticing'), legacy: document.querySelectorAll('.toasts').length }
  })
  check('알림창: 칸 크기에서 시작해 커진다', grow.length > 1 && grow[0] < at.width * 0.8, JSON.stringify({ grow, final: at.width, pill: pillBox.width }))
  check('알림창: 칸 자리(오른쪽 위 모서리)에 붙어 있다', Math.abs(at.right - pillBox.right) < 1.5 && Math.abs(at.top - pillBox.top) < 1.5, JSON.stringify({ at, pillBox }))
  check('알림창: 커진 동안 칸은 숨고, 따로 뜨는 알림 판은 없다', at.hidden && at.legacy === 0, JSON.stringify(at))

  // 새 알림은 맨 위, 알림창은 그만큼 길어진다
  await say('두 번째 알림', 'success')
  await sleep(500)
  const rows = await p.locator('.dock-notice .dock-notice-text').allInnerTexts()
  check('알림창: 새 알림이 맨 위에 더해진다', rows[0] === '두 번째 알림' && rows[1] === '첫 번째 알림', JSON.stringify(rows))

  // 닫기(×)로 하나씩 — 모두 닫히면 칸으로 줄어들고 칸에는 마지막 알림이 남는다
  await p.locator('.dock-notice .toast', { hasText: '첫 번째 알림' }).getByRole('button', { name: '닫기' }).click()
  await sleep(400)
  check('닫기: 그 알림만 닫힌다', (await p.locator('.dock-notice .toast').count()) === 1)
  await clearAll()
  await sleep(700)
  const back = await p.evaluate(() => ({
    card: document.querySelectorAll('.dock-notice').length,
    hidden: !!document.querySelector('.dock.is-noticing'),
    label: document.querySelector('.dock')!.getAttribute('aria-label') ?? '',
    text: (document.querySelector('.dock-page:not([aria-hidden="true"]) .dock-text') as HTMLElement | null)?.innerText ?? ''
  }))
  check('다 사라지면 칸으로 줄어든다', back.card === 0 && !back.hidden, JSON.stringify(back))
  check('…칸은 알림 쪽에 마지막 알림을 남긴다', back.label.includes('알림') && back.text.includes('두 번째 알림'), JSON.stringify(back))

  // 알림창을 누르면 그 자리에서 자세히 보는 창(알림 쪽) — 지난 알림이 새것부터
  await say('세 번째 알림', 'info')
  await sleep(700)
  await p.click('.dock-notice .dock-notice-text')
  await p.waitForSelector('.dock-panel')
  await sleep(600)
  const list = await p.locator('.dock-panel-page:not([aria-hidden="true"]) .dock-row-title').allInnerTexts()
  check('알림창을 누르면 자세히 보는 창의 알림 쪽 — 지난 알림이 새것부터', list[0] === '세 번째 알림' && list.includes('두 번째 알림') && list.includes('노트를 휴지통으로 옮겼습니다.'), JSON.stringify(list))
  check('…알림창은 닫힌다', (await p.locator('.dock-notice').count()) === 0)

  // 펼친 창이 열린 동안 온 알림은 알림창 없이 창의 알림 쪽에 바로 쌓인다
  await say('네 번째 알림', 'info')
  await sleep(400)
  const list2 = await p.locator('.dock-panel-page:not([aria-hidden="true"]) .dock-row-title').allInnerTexts()
  check('펼친 창이 열려 있으면 알림창 없이 알림 쪽에 쌓인다', (await p.locator('.dock-notice').count()) === 0 && list2[0] === '네 번째 알림', JSON.stringify(list2))
  await p.keyboard.press('Escape')
  await p.context().close()
}
