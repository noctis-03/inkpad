// 노트 열기·닫기 '카드 이동' 모션(App Panes)이 카드를 보낼 페이지 자리.
// 편집 화면(Editor)이 엔진을 만든 뒤 등록하고, 닫히면 지운다. 화면에 편집 화면이 하나뿐이라 한 곳이면 된다.

let getter: (() => DOMRect | null) | null = null

/** 편집 화면이 등록한다 — 지우는 함수를 돌려준다 */
export function providePageRect(fn: () => DOMRect | null) {
  getter = fn
  return () => {
    if (getter === fn) getter = null
  }
}

/** 편집 화면이 보여 주는 페이지의 화면 위치 — 아직 준비되지 않았거나 페이지가 없는 노트(무한·문서)면 null */
export const pageRectNow = () => getter?.() ?? null
