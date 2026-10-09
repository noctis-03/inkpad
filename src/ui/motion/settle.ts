// 카드 settle 효과 (명세 5.3-5): 흰 광택 띠가 한 번 지나가고 카드가 5px 들렸다 내려앉는다.
// 클래스 제거 → reflow → 다시 추가 로 재생한다.
//
// 카드에는 두 애니메이션이 겹친다 — 썸네일 들림(settle-lift, 0.7s)과 광택 띠(sheen, 0.95s).
// 먼저 끝나는 settle-lift 의 animationend 로 클래스를 지우면 광택 띠가 잘리므로,
// 마지막 애니메이션(sheen)이 끝날 때 정리하고, 애니메이션이 아예 없는 카드(썸네일 없음)를 위해
// 안전 타임아웃을 함께 둔다. 재생이 겹쳐도 서로의 정리를 밟지 않도록 토큰으로 구분한다.

export function settle(el: HTMLElement | null | undefined) {
  if (!el) return
  if (document.documentElement.dataset.motion === 'off') return
  const run = () => {
    el.classList.remove('is-settling')
    void el.offsetWidth // reflow — 애니메이션 재시작
    el.classList.add('is-settling')

    const token = String((Number(el.dataset.settleToken) || 0) + 1)
    el.dataset.settleToken = token
    const clear = () => {
      if (el.dataset.settleToken !== token) return // 더 새로운 재생이 시작됨
      el.classList.remove('is-settling')
    }
    const onEnd = (e: AnimationEvent) => {
      if (e.animationName !== 'sheen') return
      el.removeEventListener('animationend', onEnd)
      window.clearTimeout(fallback)
      clear()
    }
    el.addEventListener('animationend', onEnd)
    const fallback = window.setTimeout(() => {
      el.removeEventListener('animationend', onEnd)
      clear()
    }, 1100)
  }
  // 목록에 막 등장한 카드는 다음 프레임에 재생해 레이아웃이 잡히게 한다
  requestAnimationFrame(run)
}
