import { useEffect, useRef } from 'react'
import { cellNoise, drawPlus, readThumb, type ThumbGrid } from '../motion/thumbCells'

/**
 * 카드 미리보기 가장자리 효과 — 늘 유지된다. 가운데는 필기가 그대로 또렷하고, 가장자리로 갈수록
 * 필기 칸이 잉크 색 타일 → 빈 사각형 → ＋로 흩어진다(빈 종이 가장자리엔 옅은 ＋가 드문드문).
 * 칸마다 흩어짐 값이 고정이라 다시 그려도(크기 바뀜 등) 무늬가 같다. 미리보기 <img> 위에 얹는 캔버스.
 * 가장자리가 흩어져 카드 경계가 흐려지므로, 카드의 원래 테두리 선(1px) 자리를 그 자리 가장자리 색으로 칠한다
 * (원래 회색 테두리 선은 CSS에서 뺀다 — .doc-thumb:has(> .thumb-edge)).
 *
 * 등장 — 미리보기가 처음 보일 때 Library가 이 캔버스의 부모(.doc-thumb)에 'thumb-reveal' 이벤트를 보내면,
 * 전체가 흩어진 상태(＋)에서 시작해 빈 사각형 → 타일 → 또렷한 필기로 가운데부터 풀리고, 가장자리는 흩어진 채 멈춘다
 * (칸마다 지금 단계 t를 '전부 흩어짐(T_START)'에서 '가장자리 상태'로 옮긴다 — 끝 상태가 곧 늘 보이는 상태)
 *
 * 머무는 동안 — 화면에 보이는 카드만 초당 20번쯤 다시 그려 가장자리가 은은하게 일렁이고 ＋·빈 사각형이 반짝인다
 * (칸마다 단계가 조금씩 오르내려 타일↔사각형↔＋가 바뀌고, 기호 진하기가 엇갈려 깜빡인다). 모션 끄기면 멈춘 그림
 */
export function ThumbEdge({ src }: { src: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    const holder = cv?.parentElement
    if (!cv || !holder) return
    let alive = true
    const img = new Image()
    let grid: ThumbGrid | null = null
    let size = { w: 0, h: 0, radius: 0 }
    let progress = 1 // 등장 진행 0..1 — 1이면 늘 보이는 가장자리 상태
    let pending = false // 그림을 읽기 전에 등장 요청이 왔다
    let raf = 0
    let idleRaf = 0
    let visible = false
    // 등장 동안 미리보기 <img>는 이 캔버스가 첫 장면을 그린 뒤에 보인다(그 전엔 리빌 대기 클립으로 가려져 있다)
    const showImg = () => holder.querySelector('img[data-reveal]')?.classList.add('is-revealed', 'no-anim')
    const paint = () => {
      const g = cv.getContext('2d')
      if (!g || !grid) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      paintEdge(g, grid, size.w, size.h, progress, shimmerOn() ? performance.now() / 1000 : undefined)
      paintFrame(g, grid, size.w, size.h, size.radius)
    }
    const layout = () => {
      if (!alive || !img.naturalWidth) return
      const w = holder.clientWidth
      const h = holder.clientHeight
      grid = readThumb(img, w, h)
      if (!grid) {
        if (pending) showImg() // 읽을 수 없으면 효과 없이 그냥 보인다
        pending = false
        return
      }
      size = { w, h, radius: parseFloat(getComputedStyle(holder).borderTopLeftRadius) || 0 }
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      cv.width = Math.ceil(w * dpr)
      cv.height = Math.ceil(h * dpr)
      if (pending) play()
      else {
        paint()
        idle()
      }
    }
    const shimmerOn = () => document.documentElement.dataset.motion !== 'off'
    // 머무는 동안 일렁임 — 보이는 동안만, 초당 20번
    const idle = () => {
      cancelAnimationFrame(idleRaf)
      if (!alive || !visible || !grid || progress < 1 || !shimmerOn()) return
      let last = 0
      const tick = (now: number) => {
        if (!alive || !visible || progress < 1 || !shimmerOn()) return
        if (now - last >= 50) {
          last = now
          paint()
        }
        idleRaf = requestAnimationFrame(tick)
      }
      idleRaf = requestAnimationFrame(tick)
    }
    const play = () => {
      if (!grid) {
        pending = true
        progress = 0
        return
      }
      pending = false
      cancelAnimationFrame(raf)
      const t0 = performance.now()
      const step = (now: number) => {
        if (!alive) return
        progress = Math.min(1, (now - t0) / REVEAL_MS)
        paint()
        if (progress < 1) raf = requestAnimationFrame(step)
        else idle()
      }
      progress = 0
      paint()
      showImg()
      raf = requestAnimationFrame(step)
    }
    holder.addEventListener('thumb-reveal', play)
    img.onload = layout
    img.onerror = () => {
      if (pending) showImg()
    }
    img.src = src
    const ro = new ResizeObserver(() => layout())
    ro.observe(holder)
    const io = new IntersectionObserver(([en]) => {
      visible = en.isIntersecting
      if (visible) idle()
      else cancelAnimationFrame(idleRaf)
    })
    io.observe(holder)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      cancelAnimationFrame(idleRaf)
      io.disconnect()
      holder.removeEventListener('thumb-reveal', play)
      ro.disconnect()
    }
  }, [src])
  return <canvas ref={ref} className="thumb-edge" aria-hidden="true" />
}

/** 가장자리에서 이만큼(가운데 0 ~ 가장자리 1) 안쪽부터 흩어지기 시작한다 */
const EDGE_START = 0.72
/** 등장 길이(ms) */
const REVEAL_MS = 900
/** 등장 시작 때 모든 칸의 단계 — ＋ 단계(1.3 미만) 바로 안쪽에서 시작한다 */
const T_START = 1.25
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3)

/** 머무는 동안 칸 단계가 오르내리는 폭(일렁임) */
const SHIMMER = 0.16

/** progress: 등장 진행(1이면 머무는 상태). time(초)을 주면 일렁임·반짝임을 넣는다 */
function paintEdge(g: CanvasRenderingContext2D, grid: ThumbGrid, w: number, h: number, progress = 1, time?: number) {
  const { cells, cols } = grid
  g.clearRect(0, 0, w, h)
  const inked = (i: number) => (cells[i]?.ink ?? 0) > 0.03
  for (const c of cells) {
    // 가장자리까지 거리 — 둥근 네모(초타원) 기준이라 네 변을 고르게 따라간다
    const nx = Math.abs(((c.x + c.w / 2) / w - 0.5) * 2)
    const ny = Math.abs(((c.y + c.h / 2) / h - 0.5) * 2)
    const d = Math.pow(Math.pow(nx, 4) + Math.pow(ny, 4), 1 / 4)
    let t = (d - EDGE_START) / (1 - EDGE_START) + (cellNoise(c.i) - 0.5) * 0.4
    // 반짝임 — 칸마다 빠르기·위상이 달라 엇갈려 깜빡인다(0.45..1)
    let tw = 1
    if (time !== undefined && t > -0.3) {
      const w1 = 1.1 + cellNoise(c.i, 5) * 1.3
      const ph = cellNoise(c.i, 6) * Math.PI * 2
      t += SHIMMER * Math.sin(time * w1 + ph)
      tw = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(time * (w1 * 1.7) + ph * 1.3))
    }
    if (progress < 1) {
      // 등장 중 — 칸마다 조금씩 엇갈려(최대 25%) '전부 흩어짐'에서 제 자리 상태로. 가운데일수록 멀리 가서 먼저 풀린다
      const q = Math.min(1, Math.max(0, (progress - cellNoise(c.i, 3) * 0.25) / 0.75))
      t = T_START + (t - T_START) * easeOut(q)
    }
    if (t <= 0) continue // 가운데 — 그대로
    if (c.ink > 0.03) {
      g.fillStyle = c.paper // 원래 필기를 가리고
      g.fillRect(c.x, c.y, c.w, c.h)
      if (t < 0.45) {
        g.globalAlpha = Math.min(1, 0.4 + c.ink * 2.2)
        g.fillStyle = c.color
        g.fillRect(c.x + 0.6, c.y + 0.6, c.w - 1.2, c.h - 1.2)
      } else if (t < 0.85) {
        g.globalAlpha = 0.8 * (0.6 + 0.4 * tw)
        g.strokeStyle = c.color
        g.lineWidth = 1.1
        g.strokeRect(c.x + 1.2, c.y + 1.2, c.w - 2.4, c.h - 2.4)
      } else if (t < 1.3 && cellNoise(c.i, 1) < 0.6) {
        g.globalAlpha = 0.75 * tw
        g.strokeStyle = c.color
        g.lineWidth = 1.2
        drawPlus(g, c.x + c.w / 2, c.y + c.h / 2, c.w * 0.28)
      }
      g.globalAlpha = 1
    } else if (t > 0.5) {
      // 빈 종이 가장자리 — 필기 근처엔 조금 더, 아니면 드문드문 옅은 ＋
      const near = inked(c.i - 1) || inked(c.i + 1) || inked(c.i - cols) || inked(c.i + cols)
      if (cellNoise(c.i, 2) < (near ? 0.35 : 0.1)) {
        g.globalAlpha = (near ? 0.55 : 0.3) * tw
        g.strokeStyle = grid.inkColor
        g.lineWidth = 1.1
        drawPlus(g, c.x + c.w / 2, c.y + c.h / 2, c.w * 0.24)
        g.globalAlpha = 1
      }
    }
  }
}

/** 테두리 두께(px) — 원래 카드 테두리 선과 같은 1px */
const FRAME = 1

/**
 * 미리보기 둘레 테두리 — 둘레를 따라 놓인 칸들의 평균색을 둘레 방향으로 고르게(앞뒤 2칸) 섞어
 * 그 자리 가장자리 색으로 칠한다(위가 남색이면 위 테두리도 남색 계열, 흰 종이면 옅은 회색).
 * 종이와 같은 색이면 안 보이므로 살짝 어둡게. 모서리는 카드처럼 둥글게
 */
function paintFrame(g: CanvasRenderingContext2D, grid: ThumbGrid, w: number, h: number, radius: number) {
  const { cells, cols, rows } = grid
  const at = (cx: number, cy: number) => cells[cy * cols + cx]
  // 둘레 칸 — 시계 방향
  const ring: { c: (typeof cells)[number]; side: 'top' | 'right' | 'bottom' | 'left' }[] = []
  for (let x = 0; x < cols; x++) ring.push({ c: at(x, 0), side: 'top' })
  for (let y = 1; y < rows; y++) ring.push({ c: at(cols - 1, y), side: 'right' })
  for (let x = cols - 2; x >= 0; x--) ring.push({ c: at(x, rows - 1), side: 'bottom' })
  for (let y = rows - 2; y > 0; y--) ring.push({ c: at(0, y), side: 'left' })
  const n = ring.length
  if (n < 4 || ring.some((r) => !r.c)) return
  g.save()
  // 둥근 테두리 띠만 칠해지게 자른다
  const rr = (inset: number) => {
    const r = Math.max(0, radius - inset)
    g.roundRect(inset, inset, w - inset * 2, h - inset * 2, r)
  }
  g.beginPath()
  rr(0)
  rr(FRAME)
  g.clip('evenodd')
  for (let k = 0; k < n; k++) {
    let r = 0
    let gg = 0
    let b = 0
    for (let j = -2; j <= 2; j++) {
      const a = ring[(k + j + n) % n].c.avg
      r += a[0]
      gg += a[1]
      b += a[2]
    }
    const dim = 0.84 // 종이색과 같으면 안 보이니 살짝 어둡게
    g.fillStyle = `rgb(${((r / 5) * dim) | 0},${((gg / 5) * dim) | 0},${((b / 5) * dim) | 0})`
    const { c, side } = ring[k]
    // 그 칸이 맡은 둘레 구간(모서리 칸은 두 변을 함께 칠하도록 넉넉히)
    const pad = 2
    if (side === 'top') g.fillRect(c.x - pad, 0, c.w + pad * 2, FRAME + radius)
    else if (side === 'bottom') g.fillRect(c.x - pad, h - FRAME - radius, c.w + pad * 2, FRAME + radius)
    else if (side === 'right') g.fillRect(w - FRAME - radius, c.y - pad, FRAME + radius, c.h + pad * 2)
    else g.fillRect(0, c.y - pad, FRAME + radius, c.h + pad * 2)
  }
  g.restore()
}
