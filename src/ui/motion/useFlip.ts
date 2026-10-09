import { useLayoutEffect, useRef, type RefObject } from 'react'
import { SPRING, dur } from './motion'

/**
 * 목록 변화 FLIP (명세 5.4).
 * deps가 바뀌어 목록이 다시 그려질 때, 각 카드([data-flip-key])의 이동/등장을 부드럽게 잇는다.
 * 화면에 보이는 카드가 많을 때(>60)는 성능을 위해 생략한다.
 *
 * resetKey(보통 현재 섹션 키)가 바뀌면 이전 위치 기억을 버려 카드를 '등장'으로 취급한다.
 * 목록이 비어 컨테이너가 사라진 경우에도 기억을 버린다 — 그러지 않으면 다시 나타난 카드가
 * 이전 위치와 같다는 이유로 '이동 0px'으로 판정돼 아무 애니메이션도 나오지 않는다.
 */
export function useFlip(containerRef: RefObject<HTMLElement | null>, deps: unknown[], resetKey?: string) {
  const prev = useRef<Map<string, DOMRect>>(new Map())
  const first = useRef(true)
  const prevReset = useRef(resetKey)

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
    const sectionChanged = prevReset.current !== resetKey
    prevReset.current = resetKey

    if (!el) {
      // 목록이 비어 컨테이너가 사라졌다 — 이전 위치 기억을 버리고 '첫 목록' 표시도 내린다.
      // 그래야 다시 목록이 나타날 때 카드가 등장 애니메이션으로 들어온다.
      prev.current = new Map()
      first.current = false
      return
    }
    if (document.documentElement.dataset.motion === 'off' || first.current) {
      first.current = false
      capture()
      return
    }
    // 섹션 전환의 '등장'은 Library 의 data-enter(CSS)가 담당한다.
    // 여기서 WAAPI 로 또 등장을 걸면 두 애니메이션이 겹쳐 어긋난다 — 위치만 기억하고 끝낸다.
    if (sectionChanged) {
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
