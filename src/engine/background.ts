import type { Background } from '../shared/model'

/**
 * 속지 패턴을 선분/점 목록으로 만든다. 캔버스 렌더링과 PDF 내보내기(벡터)가 같은 결과를 쓴다.
 * 좌표는 페이지 왼쪽 위 기준 (pt).
 */
export interface PatternGeom {
  lines: [number, number, number, number][]
  dots: [number, number][]
  lineWidth: number
  dotRadius: number
  color: string
  accent?: { lines: [number, number, number, number][]; color: string; width: number }
}

export function patternGeometry(bg: Background, w: number, h: number): PatternGeom | null {
  if (bg.type === 'blank') return null
  const sp = bg.spacing
  // 예전 기본 색으로 저장된 페이지는 새 기본 색으로 바꿔 그린다 (D-2).
  // 사용자가 지정한 색은 그대로 둔다. 캔버스와 PDF 내보내기가 같은 함수를 쓰므로 함께 바뀐다.
  const LEGACY_DEFAULT: Record<string, string> = { '#c7d2e0': '#d3d9e2', '#9aa3ad': '#a9b1bc' }
  const out: PatternGeom = { lines: [], dots: [], lineWidth: 0.5, dotRadius: 0.8, color: LEGACY_DEFAULT[bg.color] ?? bg.color }
  const top = sp * 3
  switch (bg.type) {
    case 'lined':
      for (let y = top; y < h - sp * 0.5; y += sp) out.lines.push([0, y, w, y])
      out.accent = { lines: [[sp * 3, 0, sp * 3, h]], color: '#e9a3a0', width: 0.6 }
      break
    case 'grid':
      for (let y = sp; y < h; y += sp) out.lines.push([0, y, w, y])
      for (let x = sp; x < w; x += sp) out.lines.push([x, 0, x, h])
      out.lineWidth = 0.4
      break
    case 'dot':
      for (let y = sp; y < h; y += sp) for (let x = sp; x < w; x += sp) out.dots.push([x, y])
      break
    case 'cornell': {
      const cue = w * 0.3
      const summary = h * 0.8
      for (let y = top; y < summary - sp * 0.5; y += sp) out.lines.push([cue, y, w, y])
      out.accent = {
        lines: [
          [0, top - sp, w, top - sp],
          [cue, top - sp, cue, summary],
          [0, summary, w, summary]
        ],
        color: '#9fb0c8',
        width: 0.9
      }
      break
    }
  }
  return out
}

export function drawPattern(ctx: CanvasRenderingContext2D, bg: Background, w: number, h: number, pxPerPt: number) {
  const g = patternGeometry(bg, w, h)
  if (!g) return
  // 너무 축소하면 선이 뭉개지므로 생략 (LOD)
  if (bg.type !== 'cornell' && 'spacing' in bg && bg.spacing * pxPerPt < 3) return
  ctx.lineCap = 'butt'
  if (g.lines.length) {
    ctx.beginPath()
    for (const [x1, y1, x2, y2] of g.lines) {
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
    }
    ctx.strokeStyle = g.color
    ctx.lineWidth = Math.max(g.lineWidth, 0.6 / pxPerPt)
    ctx.stroke()
  }
  if (g.dots.length) {
    ctx.fillStyle = g.color
    const r = Math.max(g.dotRadius, 0.7 / pxPerPt)
    ctx.beginPath()
    for (const [x, y] of g.dots) {
      ctx.moveTo(x + r, y)
      ctx.arc(x, y, r, 0, Math.PI * 2)
    }
    ctx.fill()
  }
  if (g.accent) {
    ctx.beginPath()
    for (const [x1, y1, x2, y2] of g.accent.lines) {
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
    }
    ctx.strokeStyle = g.accent.color
    ctx.lineWidth = Math.max(g.accent.width, 0.8 / pxPerPt)
    ctx.stroke()
  }
}
