/**
 * 라이브러리 카드 → 편집 화면 확대 전환에 쓰는 카드 위치.
 *
 * store 의 값을 effect 가 한 번 읽고 지우는 방식은, effect 가 한 번 더 돌거나
 * 다른 경로가 값을 지우면 조용히 '페이드업'으로 떨어져 모핑이 사라졌다.
 * 모듈 변수에 담아 두고 한 번만 꺼내 쓰면 그런 결함이 생기지 않는다.
 */
let pending: DOMRect | null = null

export const setOpenRect = (r: DOMRect | null) => {
  pending = r
}

/** 저장된 카드 위치를 꺼내고 비운다(1회 소비). */
export const takeOpenRect = () => {
  const r = pending
  pending = null
  return r
}
