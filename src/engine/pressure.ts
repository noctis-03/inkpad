import type { StrokeOpts } from '../shared/model'
import type { PenStyleId } from './types'

/**
 * 펜 스타일 → perfect-freehand 외곽선 파라미터.
 * 값은 고정이다 — 조절 슬라이더는 두지 않는다. 두 스타일이 전부다.
 *  - streamline(라이브러리 내부 위치 평활)으로 손떨림을 눌러 둔다.
 *  - simulatePressure는 끈다. 라이브러리의 속도 추정은 점 사이 "월드" 거리로 하므로
 *    배율이 바뀌면 굵기가 함께 끌려간다. 속도 기반 굵기는 엔진이 "화면" 기준으로 만든다.
 * 이미 그린 획은 자기 opts를 그대로 쓰므로, 이 값을 바꿔도 옛 획 모양은 변하지 않는다.
 */
export function strokeOptsFor(style: PenStyleId, tool: 'pen' | 'highlighter'): StrokeOpts {
  if (tool === 'highlighter') {
    return { thinning: 0, smoothing: 0.5, streamline: 0, simulatePressure: false }
  }
  return {
    thinning: style === 'ballpen' ? 0 : 0.5,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: false
  }
}

/** 이 획의 굵기를 무엇으로 정하는지 — 획을 시작할 때 한 번 정한다 */
export type InkSource = 'pressure' | 'velocity' | 'fixed'

export const PRESSURE_LABEL: Record<InkSource, string> = {
  pressure: '필압',
  velocity: '속도',
  fixed: '일정'
}

/**
 * 이 획의 굵기 원천.
 *  - 볼펜(형광펜 포함)은 일정.
 *  - 펜 입력에서 필압 값이 0보다 크면 필압 (Apple Pencil 등). 필압이 고정값(0.5 등)만
 *    보내는 펜은 굵기도 일정하게 나온다 — 값이 없다고 속도로 흉내 내지 않는다.
 *  - 그 외 입력(손가락·마우스)은 화면 기준 속도로 굵기를 만든다 (quality.velocityPressure).
 */
export function inkSourceFor(style: PenStyleId, pointerType: string, firstPressure: number): InkSource {
  if (style === 'ballpen') return 'fixed'
  if (pointerType === 'pen' && firstPressure > 0) return 'pressure'
  return 'velocity'
}
