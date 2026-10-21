import { useEffect, useRef } from 'react'
import { cellNoise, drawPlus, readThumb, type ThumbGrid } from '../motion/thumbCells'

/**
 * 카드 미리보기 가장자리 효과 — 늘 유지된다. 가운데는 필기가 그대로 또렷하고, 가장자리로 갈수록
 * 필기 칸이 잉크 색 타일 → 빈 사각형 → ＋로 흩어진다(빈 종이 가장자리엔 옅은 ＋가 드문드문).
 * 칸마다 흩어짐 값이 고정이라 다시 그려도(크기 바뀜 등) 무늬가 같다. 미리보기 <img> 위에 얹는 캔버스
 */
export function ThumbEdge({ src }: { src: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    const holder = cv?.parentElement
    if (!cv || !holder) return
    let alive = true
    const img = new Image()
    const draw = () => {
      if (!alive || !img.naturalWidth) return
      const w = holder.clientWidth
      const h = holder.clientHeight
      const grid = readThumb(img, w, h)
      if (!grid) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      cv.width = Math.ceil(w * dpr)
      cv.height = Math.ceil(h * dpr)
      const g = cv.getContext('2d')
      if (!g) return
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      paintEdge(g, grid, w, h)
    }
    img.onload = draw
    img.src = src
    const ro = new ResizeObserver(() => draw())
    ro.observe(holder)
    return () => {
      alive = false
      ro.disconnect()
    }
  }, [src])
  return <canvas ref={ref} className="thumb-edge" aria-hidden="true" />
}

/** 가장자리에서 이만큼(가운데 0 ~ 가장자리 1) 안쪽부터 흩어지기 시작한다 */
const EDGE_START = 0.72

function paintEdge(g: CanvasRenderingContext2D, grid: ThumbGrid, w: number, h: number) {
  const { cells, cols } = grid
  g.clearRect(0, 0, w, h)
  const inked = (i: number) => (cells[i]?.ink ?? 0) > 0.03
  for (const c of cells) {
    // 가장자리까지 거리 — 둥근 네모(초타원) 기준이라 네 변을 고르게 따라간다
    const nx = Math.abs(((c.x + c.w / 2) / w - 0.5) * 2)
    const ny = Math.abs(((c.y + c.h / 2) / h - 0.5) * 2)
    const d = Math.pow(Math.pow(nx, 4) + Math.pow(ny, 4), 1 / 4)
    const t = (d - EDGE_START) / (1 - EDGE_START) + (cellNoise(c.i) - 0.5) * 0.4
    if (t <= 0) continue // 가운데 — 그대로
    if (c.ink > 0.03) {
      g.fillStyle = c.paper // 원래 필기를 가리고
      g.fillRect(c.x, c.y, c.w, c.h)
      if (t < 0.45) {
        g.globalAlpha = Math.min(1, 0.4 + c.ink * 2.2)
        g.fillStyle = c.color
        g.fillRect(c.x + 0.6, c.y + 0.6, c.w - 1.2, c.h - 1.2)
      } else if (t < 0.85) {
        g.globalAlpha = 0.8
        g.strokeStyle = c.color
        g.lineWidth = 1.1
        g.strokeRect(c.x + 1.2, c.y + 1.2, c.w - 2.4, c.h - 2.4)
      } else if (t < 1.3 && cellNoise(c.i, 1) < 0.6) {
        g.globalAlpha = 0.75
        g.strokeStyle = c.color
        g.lineWidth = 1.2
        drawPlus(g, c.x + c.w / 2, c.y + c.h / 2, c.w * 0.28)
      }
      g.globalAlpha = 1
    } else if (t > 0.5) {
      // 빈 종이 가장자리 — 필기 근처엔 조금 더, 아니면 드문드문 옅은 ＋
      const near = inked(c.i - 1) || inked(c.i + 1) || inked(c.i - cols) || inked(c.i + cols)
      if (cellNoise(c.i, 2) < (near ? 0.35 : 0.1)) {
        g.globalAlpha = near ? 0.55 : 0.3
        g.strokeStyle = grid.inkColor
        g.lineWidth = 1.1
        drawPlus(g, c.x + c.w / 2, c.y + c.h / 2, c.w * 0.24)
        g.globalAlpha = 1
      }
    }
  }
}
