// 모션 토큰과 설정.
// WAAPI(element.animate)와 CSS transition에서 함께 쓰는 곡선/지속시간 헬퍼.

export const SPRING = 'cubic-bezier(.2,.9,.25,1.05)'
export const EASE = 'cubic-bezier(.2,.8,.2,1)'

export type MotionLevel = 'off' | 'normal' | 'rich'

/** 현재 적용 중인 모션 단계. App.tsx가 <html data-motion>에 반영한다. */
export const motionLevel = (): MotionLevel => {
  const v = document.documentElement.dataset.motion
  return v === 'off' || v === 'rich' ? v : 'normal'
}

/** 모션 "끄기"면 0, 아니면 ms (transition/animation 지속시간) */
export const dur = (ms: number) => (motionLevel() === 'off' ? 0 : ms)

/** "풍부" 단계에서만 켜지는 장식의 지속시간 */
export const durRich = (ms: number) => (motionLevel() === 'rich' ? ms : 0)

/** 이 화면이 지금 App Panes의 크로스페이드로 나타나는 중인가 (홈 ↔ 노트) — 그때는 화면 자체 등장 효과를 겹치지 않는다 */
export const crossfading = (el: Element) => !!el.closest('.panes')?.querySelector(':scope > .pane-leaving')
