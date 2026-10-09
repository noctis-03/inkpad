import { useEffect, useRef, type RefObject } from 'react'

/**
 * 슬라이딩 선택 인디케이터 (명세 5.2).
 * 컨테이너 안 [data-indicator-key] 항목 중 activeKey의 위치로 흰 칩(.motion-ind)을 옮긴다.
 * 세로 배치(left/right 도구바 등)는 axis='y'로 표시하지만, 실제 이동은 translate로 처리하므로
 * 축은 표시용 의미만 갖는다.
 *
 * activeKey 가 null/빈 값이면(선택 해제) 남아 있던 인디케이터를 숨긴다.
 */
export function useIndicator(
  containerRef: RefObject<HTMLElement | null>,
  activeKey: string | number | null | undefined,
  axis: 'x' | 'y' = 'x'
) {
  const first = useRef(true)
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
      if (!animate) {
        ind.style.transition = prevTransition
        // transition을 되돌린 직후 다음 프레임에는 애니메이션이 가능해야 한다
        requestAnimationFrame(() => {
          if (ind) ind.style.transition = ''
        })
      }
    }

    place(!first.current)
    first.current = false

    const ro = new ResizeObserver(() => place(false))
    ro.observe(el)
    const raf = requestAnimationFrame(() => place(false))
    document.fonts?.ready?.then(() => place(false)).catch(() => {})

    // 비동기 목록(카테고리·폴더 등)에서 활성 항목이 나중에 붙는 경우를 대비한 소수 재시도
    const retries = [50, 140, 300].map((ms) => window.setTimeout(() => place(false), ms))

    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      retries.forEach((t) => window.clearTimeout(t))
    }
  }, [containerRef, key, axis])
}
