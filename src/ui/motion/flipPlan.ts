/**
 * FLIP 판정 로직 (순수 함수 — DOM/React 없이 테스트 가능).
 *
 * useFlip 이 "무엇을 등장시키고 무엇을 이동시킬지"를 여기서 결정하고,
 * 훅은 그 결과를 실제 애니메이션으로 옮기기만 한다.
 *
 * 핵심 규칙
 *  - prev 에 없는 카드 = 새로 나타난 카드 → 등장(enter).
 *  - prev 에 있는 카드 = 위치가 바뀐 만큼만 이동(move).
 *  - 성능 가드: 한 번의 갱신에서 애니메이션은 FLIP_ANIM_BUDGET 개까지만 건다.
 *    (예전에는 카드가 60개를 넘으면 '통째로 생략'해서 등장 연출까지 사라졌다.)
 */

export type FlipRect = { left: number; top: number }
export type FlipCard = FlipRect & { key: string }

export type FlipAction =
  | { key: string; kind: 'enter'; delay: number }
  | { key: string; kind: 'move'; dx: number; dy: number }

/** 한 번의 갱신에서 거는 애니메이션 최대 개수 (성능 가드). */
export const FLIP_ANIM_BUDGET = 40

/** 이보다 작은 이동은 무시한다 — 서브픽셀 흔들림 방지. */
export const MOVE_EPSILON = 0.5

/** 등장 지연 계단(ms) — 목록 맨 앞 카드부터 차례로 도착한다. */
export const STAGGER_MS = 30
export const STAGGER_MAX_STEPS = 8

/**
 * @param prev  직전 렌더에서 기억한 카드 위치(key → 좌표)
 * @param cards 이번 렌더에 화면에 있는 카드들 (DOM 순서)
 * @param budget 애니메이션 최대 개수
 */
export function planFlip(
  prev: ReadonlyMap<string, FlipRect>,
  cards: readonly FlipCard[],
  budget: number = FLIP_ANIM_BUDGET
): FlipAction[] {
  const out: FlipAction[] = []
  let remaining = Math.max(0, Math.floor(budget))
  let entered = 0

  for (const c of cards) {
    if (remaining <= 0) break
    const old = prev.get(c.key)

    if (!old) {
      // 새 카드 — 카드 수와 무관하게 등장은 살린다(예산 한도 안에서).
      out.push({ key: c.key, kind: 'enter', delay: Math.min(entered, STAGGER_MAX_STEPS) * STAGGER_MS })
      entered++
      remaining--
      continue
    }

    const dx = old.left - c.left
    const dy = old.top - c.top
    if (Math.abs(dx) > MOVE_EPSILON || Math.abs(dy) > MOVE_EPSILON) {
      out.push({ key: c.key, kind: 'move', dx, dy })
      remaining--
    }
  }

  return out
}
