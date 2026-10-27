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
  await p.context().close()
}
