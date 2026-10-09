import { useEffect, useRef, type RefObject } from 'react'

/**
 * 슬라이딩 선택 인디케이터 (명세 5.2).
 * 컨테이너 안 [data-indicator-key] 항목 중 activeKey의 위치로 흰 칩(.motion-ind)을 옮긴다.
 * 세로 배치(left/right 도구바 등)는 axis='y'로 표시하지만, 실제 이동은 translate로 처리하므로
 * 축은 표시용 의미만 갖는다.
 *
 * activeKey 가 null/빈 값이면(선택 해제) 남아 있던 인디케이터를 숨긴다.
 *
 * 이동은 항상 슬라이딩(모핑)으로 한다 — 항목을 누르면 칩이 스프링으로 미끄러져 간다.
 * 단, 칩을 새로 만든 직후(서랍을 다시 열 때 등)와 컨테이너 첫 배치 때는 0,0에서
 * 출발하는 가짜 슬라이드를 막으려고 즉시 배치한다. 슬라이딩이 진행되는 동안에는
 * ResizeObserver·재시도의 즉시 재배치가 트랜지션을 끊지 않게 잠금(hold) 창을 둔다.
 */
export function useIndicator(
  containerRef: RefObject<HTMLElement | null>,
  activeKey: string | number | null | undefined,
  axis: 'x' | 'y' = 'x'
) {
  const first = useRef(true)
  const hold = useRef(0)
  const key = activeKey == null ? '' : String(activeKey)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    // 선택 해제 — 이전 위치에 인디케이터가 남지 않게 숨긴다
    if (!key) {
      const cur = el.querySelector<HTMLElement>(':scope > .motion-ind')
      if (cur) cur.style.opacity = '0'
      first.current = false
      return
    }

    if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
    el.dataset.indAxis = axis

    let ind = el.querySelector<HTMLElement>(':scope > .motion-ind')
    const created = !ind
    if (!ind) {
      ind = document.createElement('span')
      ind.className = 'motion-ind'
      ind.setAttribute('aria-hidden', 'true')
      el.insertBefore(ind, el.firstChild)
    }

    const place = (animate: boolean) => {
      const target = el.querySelector<HTMLElement>(`[data-indicator-key="${CSS.escape(key)}"]`)
      if (!target || !ind) {
        if (ind) ind.style.opacity = '0'
        return
      }
      const prevTransition = ind.style.transition
      if (!animate) ind.style.transition = 'none'
      ind.style.width = `${target.offsetWidth}px`
      ind.style.height = `${target.offsetHeight}px`
      ind.style.transform = `translate(${target.offsetLeft}px, ${target.offsetTop}px)`
      ind.style.opacity = '1'
      if (animate) {
        // 트랜지션이 끝날 때까지 즉시 재배치(리사이즈·재시도)가 덮어쓰지 않게 잠근다
        hold.current = performance.now() + 520
        // 잠금이 풀린 뒤 한 번 실제 위치에 맞춘다 — 애니메이션 중 목록이 바뀐 경우의 보정
        window.setTimeout(() => {
          if (performance.now() >= hold.current) place(false)
        }, 560)
      } else {
        ind.style.transition = prevTransition
        // transition을 되돌린 직후 다음 프레임에는 애니메이션이 가능해야 한다
        requestAnimationFrame(() => {
          if (ind) ind.style.transition = ''
        })
      }
    }

    // 새 칩·첫 배치는 즉시, 이후의 선택 이동은 슬라이딩으로
    place(!created && !first.current)
    first.current = false

    const instant = () => {
      if (performance.now() < hold.current) return
      place(false)
    }
    const ro = new ResizeObserver(instant)
    ro.observe(el)
    const raf = requestAnimationFrame(instant)
    document.fonts?.ready?.then(instant).catch(() => {})

    // 비동기 목록(카테고리·폴더 등)에서 활성 항목이 나중에 붙는 경우를 대비한 소수 재시도
    const retries = [50, 140, 300].map((ms) => window.setTimeout(instant, ms))

    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      retries.forEach((t) => window.clearTimeout(t))
    }
  }, [containerRef, key, axis])
}
