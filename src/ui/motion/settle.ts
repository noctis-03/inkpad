// 카드 settle 효과 (명세 5.3-5): 흰 광택 띠가 한 번 지나가고 카드가 5px 들렸다 내려앉는다.
// 클래스 제거 → reflow → 다시 추가 로 재생한다.

export function settle(el: HTMLElement | null | undefined) {
  if (!el) return
  if (document.documentElement.dataset.motion === 'off') return
  const run = () => {
    el.classList.remove('is-settling')
    void el.offsetWidth // reflow — 애니메이션 재시작
    el.classList.add('is-settling')
    el.addEventListener('animationend', () => el.classList.remove('is-settling'), { once: true })
  }
  // 목록에 막 등장한 카드는 다음 프레임에 재생해 레이아웃이 잡히게 한다
  requestAnimationFrame(run)
}
