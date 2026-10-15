import type { StrokeOpts } from '../shared/model'
import type { PressureCapability, Settings } from './types'

/** 실제로 획에 적용할 방식 */
export type ResolvedPressure = 'pressure' | 'velocity' | 'constant'

export function resolvePressure(s: Settings, pointerType: string): ResolvedPressure {
  // 손가락·정전식 터치펜·마우스는 필압이 없다
  if (pointerType !== 'pen') return s.pressureMode === 'pressure' || s.pressureMode === 'auto' ? s.fallbackMode : s.pressureMode
  switch (s.pressureMode) {
    case 'pressure':
    case 'velocity':
    case 'constant':
      return s.pressureMode
    case 'auto':
      // 아직 모를 때는 필압으로 시작한다 (Apple Pencil이 대부분). 필압이 없으면 획이 끝날 때 감지되어 다음 획부터 바뀐다.
      return s.pressureCapability === 'no' ? s.fallbackMode : 'pressure'
  }
}

export function strokeOptsFor(mode: ResolvedPressure, s: Settings, tool: 'pen' | 'highlighter'): StrokeOpts {
  if (tool === 'highlighter') {
    return { thinning: 0, smoothing: 0.5, streamline: Math.max(0.4, s.streamline), simulatePressure: false }
  }
  switch (mode) {
    case 'pressure':
      return { thinning: s.thinning, smoothing: s.smoothing, streamline: s.streamline, simulatePressure: false }
    case 'velocity':
      // 속도 기반은 변화가 과하면 어색하므로 폭을 줄인다
      return { thinning: s.thinning * 0.7, smoothing: s.smoothing, streamline: s.streamline, simulatePressure: true }
    case 'constant':
      return { thinning: 0, smoothing: s.smoothing, streamline: s.streamline, simulatePressure: false }
  }
}

export const PRESSURE_LABEL: Record<ResolvedPressure, string> = {
  pressure: '필압',
  velocity: '속도',
  constant: '일정'
}

/**
 * 펜이 필압을 보내는지 감지한다.
 * - 한 획 안에서 필압 값이 여러 가지로 바뀌면 → 지원 (즉시 확정)
 * - 점이 충분히 많은데 필압이 한 값으로 고정된 획이 연속 2번 → 미지원
 *   (Logitech Crayon, 일부 USI 펜은 pointerType이 'pen'이어도 0.5/1.0 고정값을 보낸다)
 */
export class PressureDetector {
  private flatStreak = 0

  constructor(public capability: PressureCapability) {}

  /** 획이 끝날 때 호출. 판정이 바뀌면 새 값을 돌려준다 */
  observe(rawPressures: number[]): PressureCapability | null {
    if (rawPressures.length < 8) return null
    let min = Infinity
    let max = -Infinity
    const distinct = new Set<number>()
    for (const p of rawPressures) {
      if (p < min) min = p
      if (p > max) max = p
      if (distinct.size < 4) distinct.add(Math.round(p * 1000))
    }
    const varies = max - min > 0.02 && distinct.size >= 3
    if (varies) {
      this.flatStreak = 0
      return this.set('yes')
    }
    this.flatStreak++
    if (this.flatStreak >= 2) return this.set('no')
    return null
  }

  reset() {
    this.flatStreak = 0
    this.capability = 'unknown'
  }

  private set(c: PressureCapability) {
    if (c === this.capability) return null
    this.capability = c
    return c
  }
}
