import { useLayoutEffect, useRef, type RefObject } from 'react'
import { SPRING, dur } from './motion'
import { planFlip, type FlipCard, type FlipRect } from './flipPlan'

/**
 * 목록 변화 FLIP (명세 5.4).
 * deps가 바뀌어 목록이 다시 그려질 때, 각 카드([data-flip-key])의 이동/등장을 부드럽게 잇는다.
 *
 * 판정은 flipPlan(planFlip)이 하고, 여기서는 그 결과를 애니메이션으로 옮기기만 한다.
 *
 * 결함 이력 — "모핑이 한 방향으로만 되는" 증상:
 *  1) 목록이 비면 컨테이너(<section ref=gridRef>)가 언마운트되는데, 그때 위치 기억(prev)을
 *     갱신하지 않아 남아 있었다. 다시 나타난 카드가 prev 에 있으니 '제자리 이동(dx=0)'으로
 *     판정돼 등장 분기를 타지 못했고, 아무 연출도 나오지 않았다 → 컨테이너가 없으면 기억을 버린다.
 *  2) 카드가 60개를 넘으면 성능 가드로 '통째로 생략'해서 등장 연출까지 사라졌다.
 *     카드가 많은 '전체'로 돌아가는 방향만 조용히 모핑이 빠지던 원인이다
 *     → 이제 이동만 예산으로 줄이고 등장은 카드 수와 무관하게 살린다.
 */
export function useFlip(containerRef: RefObject<HTMLElement | null>, deps: unknown[]) {
  const prev = useRef<Map<string, FlipRect>>(new Map())
  const first = useRef(true)

  const capture = () => {
    const el = containerRef.current
    if (!el) return
    const m = new Map<string, FlipRect>()
    el.querySelectorAll<HTMLElement>('[data-flip-key]').forEach((c) => {
      const k = c.dataset.flipKey
      if (!k) return
      const r = c.getBoundingClientRect()
      m.set(k, { left: r.left, top: r.top })
    })
    prev.current = m
  }

  useLayoutEffect(() => {
    const el = containerRef.current

    // 목록이 비어 컨테이너가 사라졌다 — 기억을 버려 다시 나타날 때 '등장'으로 처리한다.
    // (남겨 두면 돌아온 카드가 dx=0 으로 판정돼 등장 연출이 조용히 빠진다.)
    if (!el) {
      prev.current = new Map()
      first.current = false
      return
    }

    if (document.documentElement.dataset.motion === 'off' || first.current) {
      first.current = false
      capture()
      return
    }

    const geom: FlipCard[] = []
    const nodes = new Map<string, HTMLElement>()
    for (const c of el.querySelectorAll<HTMLElement>('[data-flip-key]')) {
      const k = c.dataset.flipKey
      if (!k) continue
      const r = c.getBoundingClientRect()
      geom.push({ key: k, left: r.left, top: r.top })
      nodes.set(k, c)
    }

    for (const a of planFlip(prev.current, geom)) {
      const node = nodes.get(a.key)
      if (!node) continue
      if (a.kind === 'enter') {
        node.animate(
          [
            { opacity: 0, transform: 'translateY(12px) scale(.92)' },
            { opacity: 1, transform: 'none' }
          ],
          { duration: dur(380), delay: dur(a.delay), easing: SPRING, fill: 'backwards' }
        )
      } else {
        node.animate([{ transform: `translate(${a.dx}px, ${a.dy}px)` }, { transform: 'none' }], {
          duration: dur(500),
          easing: SPRING
        })
      }
    }

    // 이번 렌더의 위치를 다음 판정을 위해 기억한다 (geom 을 그대로 써서 측정을 두 번 하지 않는다)
    const next = new Map<string, FlipRect>()
    for (const g of geom) next.set(g.key, { left: g.left, top: g.top })
    prev.current = next

    // deps는 호출자가 제어한다 (명세: 섹션/검색/정렬/보기 전환 등)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
