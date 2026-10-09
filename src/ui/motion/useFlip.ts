import { useLayoutEffect, useRef, type RefObject } from 'react'
import { SPRING, dur } from './motion'

/**
 * 목록 변화 FLIP (명세 5.4).
 * deps가 바뀌어 목록이 다시 그려질 때, 각 카드([data-flip-key])의 이동/등장을 부드럽게 잇는다.
 * 화면에 보이는 카드가 많을 때(>60)는 성능을 위해 생략한다.
 */
export function useFlip(containerRef: RefObject<HTMLElement | null>, deps: unknown[]) {
  const prev = useRef<Map<string, DOMRect>>(new Map())
  const first = useRef(true)

  const capture = () => {
    const el = containerRef.current
    if (!el) return
    const m = new Map<string, DOMRect>()
    el.querySelectorAll<HTMLElement>('[data-flip-key]').forEach((c) => {
      const k = c.dataset.flipKey
      if (k) m.set(k, c.getBoundingClientRect())
    })
    prev.current = m
  }

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || document.documentElement.dataset.motion === 'off' || first.current) {
      first.current = false
      capture()
      return
    }
    const cards = [...el.querySelectorAll<HTMLElement>('[data-flip-key]')]
    if (cards.length > 60) {
      capture()
      return
    }
    let appear = 0
    for (const c of cards) {
      const k = c.dataset.flipKey!
      const old = prev.current.get(k)
      if (!old) {
        const delay = Math.min(appear, 8) * 30
        appear++
        c.animate(
          [
            { opacity: 0, transform: 'translateY(12px) scale(.92)' },
            { opacity: 1, transform: 'none' }
          ],
          { duration: dur(380), delay: dur(delay), easing: SPRING, fill: 'backwards' }
        )
        continue
      }
      const r = c.getBoundingClientRect()
      const dx = old.left - r.left
      const dy = old.top - r.top
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        c.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
          duration: dur(500),
          easing: SPRING
        })
      }
    }
    capture()
    // deps는 호출자가 제어한다 (명세: 섹션/검색/정렬/보기 전환 등)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
