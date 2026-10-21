import { BAYER8 } from '../motion/thumbCells'

/** 디더 점 한 변(css px) — 카드 미리보기 디더와 같은 크기 */
const DOT = 2
/** 번짐 높이(css px) — .section-tint 높이와 같게 */
const WASH_H = 340

let cached: { dpr: number; url: string } | null = null

/**
 * 카테고리 색 번짐(.section-tint)의 마스크 — 위에서 아래로 디더 점이 성겨진다(베이어 8×8).
 * 색은 CSS가 칠하고(var(--tint)) 이건 점 모양만 정하므로 모든 카테고리 색이 같은 그림을 쓴다.
 * 화면 픽셀 그대로(css 16×340px를 dpr배로) 그려 확대·흐림 없이 점이 또렷하다
 */
export function ditherWashMask(): string {
  const dpr = Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)))
  if (cached?.dpr === dpr) return cached.url
  const cols = 8 // 베이어 한 바퀴 — 가로로 이어 붙여도 이음매가 없다
  const rows = WASH_H / DOT
  const c = document.createElement('canvas')
  c.width = cols * DOT * dpr
  c.height = WASH_H * dpr
  const g = c.getContext('2d')
  if (!g) return 'none'
  g.fillStyle = '#000'
  const s = DOT * dpr
  for (let y = 0; y < rows; y++) {
    const f = Math.pow(1 - y / rows, 1.8) * 0.5 // 맨 위 절반 → 아래로 갈수록 0
    for (let x = 0; x < cols; x++) if ((BAYER8[(y & 7) * 8 + x] + 0.5) / 64 < f) g.fillRect(x * s, y * s, s, s)
  }
  cached = { dpr, url: `url(${c.toDataURL()})` }
  return cached.url
}
