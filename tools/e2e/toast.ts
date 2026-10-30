// 토스트 글자는 라이트·다크 모두 판 위에서 읽힌다 — 테마마다 뒤집히는 토큰(--surface-2)을 글자색으로 쓰던 때
// 다크에서 글자가 판에 묻혔다(1.2:1). 글자·동작 버튼 모두 4.5:1 이상
import { device, sleep, type Ctx } from './lib.ts'

export default async function toast(ctx: Ctx) {
  const { check } = ctx
  const p = await device(ctx)
  for (const theme of ['light', 'dark'] as const) {
    // 앱은 스토어가 바뀔 때마다 설정(기본 '자동' = 기기 외관)으로 테마를 다시 칠한다 — 기기 외관을 바꾼다
    await p.emulateMedia({ colorScheme: theme })
    await sleep(100)
    await p.evaluate(async () => {
      const ui = (await import('/src/app/store.ts')).useUI.getState()
      ui.toast('노트를 휴지통으로 옮겼습니다.', 'info', { label: '되돌리기', run: () => {} }, { sticky: true })
    })
    await sleep(700) // 등장 애니메이션
    const r = await p.evaluate(() => {
      const el = [...document.querySelectorAll('.toast')].at(-1)!
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
      const bg = rgb(getComputedStyle(el).backgroundColor)
      return {
        text: ratio(rgb(getComputedStyle(el.querySelector('span')!).color), bg),
        action: ratio(rgb(getComputedStyle(el.querySelector('button:not(.toast-close)')!).color), bg)
      }
    })
    check(`토스트(${theme}): 테마가 적용됐다`, (await p.evaluate(() => document.documentElement.dataset.theme)) === theme)
    check(`토스트(${theme}): 글자 4.5:1 이상`, r.text >= 4.5, r.text.toFixed(2))
    check(`토스트(${theme}): 동작 버튼 4.5:1 이상`, r.action >= 4.5, r.action.toFixed(2))
  }

  // 자리 — 탭 바 오른쪽 상태 칸 바로 아래, 오른쪽 끝을 맞춰 내려온다. 새 알림이 칸에 가장 가깝다
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().toast('두 번째 알림', 'success', undefined, { sticky: true }))
  await sleep(700)
  const at = await p.evaluate(() => {
    const pill = document.querySelector('.dock-pill')!.getBoundingClientRect()
    const list = [...document.querySelectorAll('.toast')].map((e) => e.getBoundingClientRect())
    const newest = document.querySelectorAll('.toast')[document.querySelectorAll('.toast').length - 1].getBoundingClientRect()
    return { pill: [pill.right, pill.bottom], top: Math.min(...list.map((r) => r.top)), newest: [newest.right, newest.top], docked: !!document.querySelector('.toasts.is-docked') }
  })
  check('토스트 자리: 상태 칸 바로 아래에서 내려온다', at.docked && Math.abs(at.top - (at.pill[1] + 6)) < 1.5, JSON.stringify(at))
  check('토스트 자리: 오른쪽 끝이 상태 칸과 맞고, 새 알림이 칸에 가장 가깝다', Math.abs(at.newest[0] - at.pill[0]) < 1.5 && Math.abs(at.newest[1] - at.top) < 1.5, JSON.stringify(at))

  // 상태 칸의 '알림' 쪽 — 알림이 오면 칸이 그 쪽으로 넘어가 마지막 알림을 보여 주고, 펼치면 지난 알림이 남아 있다
  await sleep(600) // 쪽 넘김(부드럽게)
  const dock = await p.evaluate(() => ({
    label: document.querySelector('.dock')!.getAttribute('aria-label') ?? '',
    text: (document.querySelector('.dock-page:not([aria-hidden="true"]) .dock-text') as HTMLElement | null)?.innerText ?? ''
  }))
  check('알림 쪽: 알림이 오면 상태 칸이 알림 쪽으로 넘어가 마지막 알림을 보인다', dock.label.includes('알림') && dock.text.includes('두 번째 알림'), JSON.stringify(dock))
  await p.evaluate(async () => {
    const ui = (await import('/src/app/store.ts')).useUI.getState()
    for (const t of ui.toasts) ui.dismissToast(t.id)
  })
  await p.click('.dock')
  await p.waitForSelector('.dock-panel')
  await sleep(500)
  const rows = await p.locator('.dock-panel-page:not([aria-hidden="true"]) .dock-row-title').allInnerTexts()
  check('알림 쪽: 토스트가 사라져도 펼치면 지난 알림이 새것부터 남아 있다', rows[0] === '두 번째 알림' && rows.includes('노트를 휴지통으로 옮겼습니다.'), JSON.stringify(rows))
  await p.keyboard.press('Escape')
  await p.context().close()
}
