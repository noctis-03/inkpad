import { useEffect, useRef } from 'react'
import { cellNoise, drawPlus, readThumb, type ThumbGrid } from '../motion/thumbCells'

/**
 * 카드 미리보기 타일 효과 캔버스.
 *
 * 머무는 동안 — 가운데는 필기가 또렷하고, 가장자리로 갈수록 필기 칸이 잉크 색 타일 → 빈 사각형 → ＋로 흩어진다
 * (빈 종이 가장자리엔 옅은 ＋가 드문드문). 기호는 고정이고 밝기만 은은하게 물결치듯 일렁인다(보이는 카드만 초당 20번).
 *
 * 등장 — 미리보기가 처음 보일 때 Library가 이 캔버스의 부모(.doc-thumb)에 'thumb-reveal' 이벤트를 보내면,
 * 전체가 흩어진 상태(＋)에서 시작해 가운데부터 풀리고 가장자리는 흩어진 채 멈춘다(끝 상태 = 머무는 상태).
 *
 * 카드를 눌러 여는 창(블러 베일)이 뜨면(open) — 캔버스가 블러 위로 올라와 머무는 효과를 그대로 보인다
 * (블러 위에 똑같은 가장자리). 닫히는 동안(베일이 걷히는 동안)에도 위에 남았다가 내려간다.
 *
 * 카드의 원래 테두리 선(1px) 자리는 그 자리 가장자리 색으로 칠한다(원래 회색 선은 CSS에서 뺀다 — .doc-thumb:has(> .thumb-edge))
 */
export function ThumbEdge({ src, open }: { src: string; open: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const ctl = useRef<{ setOpen: (v: boolean) => void } | null>(null)
  useEffect(() => {
    const cv = ref.current
    const holder = cv?.parentElement
    if (!cv || !holder) return
    let alive = true
    const img = new Image()
    let grid: ThumbGrid | null = null
    let size = { w: 0, h: 0, radius: 0 }
    let reveal = 1 // 등장 진행 0..1 — 1이면 머무는 상태
    let openAmt = 0 // 여는 창 효과 0..1
    let openTarget = false
    let pending = false // 그림을 읽기 전에 등장 요청이 왔다
    let visible = false
    let raf = 0
    const motionOn = () => document.documentElement.dataset.motion !== 'off'
    // 등장 동안 미리보기 <img>는 이 캔버스가 첫 장면을 그린 뒤에 보인다(그 전엔 리빌 대기 클립으로 가려져 있다)
    const showImg = () => holder.querySelector('img[data-reveal]')?.classList.add('is-revealed', 'no-anim')
    const paint = () => {
      const g = cv.getContext('2d')
      if (!g || !grid) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, size.w, size.h)
      // 여는 창 효과가 남아 있는 동안은 블러 베일 위에 둔다(닫히는 동안에도 — 베일 아래로 먼저 떨어지면 끊겨 보인다)
      cv.classList.toggle('is-lifted', openTarget || openAmt > 0)
      paintTiles(g, grid, size.w, size.h, { reveal, time: motionOn() ? performance.now() / 1000 : undefined })
      paintFrame(g, grid, size.w, size.h, size.radius)
    }
    // 하나의 루프 — 등장·여닫기 진행을 옮기고, 보이는 동안 초당 20번 밝기 일렁임
    let last = 0
    let prev = 0
    const loop = (now: number) => {
      raf = 0
      if (!alive) return
      const dt = prev ? now - prev : 16
      prev = now
      let busy = false
      if (reveal < 1) {
        reveal = Math.min(1, reveal + dt / REVEAL_MS)
        busy = true
      }
      const goal = openTarget ? 1 : 0
      if (openAmt !== goal) {
        const stepAmt = dt / (openTarget ? OPEN_MS : CLOSE_MS)
        openAmt = openTarget ? Math.min(1, openAmt + stepAmt) : Math.max(0, openAmt - stepAmt)
        busy = true
      }
      const shimmer = (visible || openAmt > 0) && motionOn()
      if (busy || (shimmer && now - last >= 50)) {
        last = now
        paint()
      }
      if (busy || shimmer) raf = requestAnimationFrame(loop)
      else prev = 0
    }
    const kick = () => {
      if (!raf && alive && grid) {
        prev = 0
        raf = requestAnimationFrame(loop)
      }
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
        kick()
      }
    }
    const play = () => {
      if (!grid) {
        pending = true
        return
      }
      pending = false
      reveal = 0
      paint()
      showImg()
      kick()
    }
    ctl.current = {
      setOpen: (v) => {
        openTarget = v
        if (!motionOn()) openAmt = v ? 1 : 0 // 모션 끄기 — 바로
        paint()
        kick()
      }
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
      if (visible) kick()
    })
    io.observe(holder)
    return () => {
      alive = false
      ctl.current = null
      if (raf) cancelAnimationFrame(raf)
      holder.removeEventListener('thumb-reveal', play)
      ro.disconnect()
      io.disconnect()
    }
  }, [src])
  useEffect(() => ctl.current?.setOpen(open), [open, src])
  return <canvas ref={ref} className="thumb-edge" aria-hidden="true" />
}

/** 가장자리에서 이만큼(가운데 0 ~ 가장자리 1) 안쪽부터 흩어진다 */
const EDGE_START = 0.84
/** 등장 길이(ms) */
const REVEAL_MS = 900
/** 여는 창이 뜨고·걷히는 동안(ms) — 이 동안 캔버스를 블러 베일 위에 둔다(베일의 페이드와 맞춘다) */
const OPEN_MS = 320
const CLOSE_MS = 340
/** 등장 시작 때 모든 칸의 단계 — ＋ 단계(1.3 미만) 바로 안쪽에서 시작한다 */
const T_START = 1.25
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3)

/**
 * 칸 타일 그리기 — 칸마다 단계 t(0 이하 = 그대로, 0..0.45 채운 타일, ..0.85 빈 사각형, ..1.3 ＋)를 정해 그린다.
 * - 기본: 가장자리 상태(가운데는 그대로, 가장자리일수록 흩어짐)
 * - reveal(0..1): 등장 — '전부 흩어짐'에서 가장자리 상태로(가운데 칸이 멀리 가서 먼저 풀린다)
 * - time(초): 밝기만 물결치듯 일렁인다(기호는 고정)
 */
function paintTiles(g: CanvasRenderingContext2D, grid: ThumbGrid, w: number, h: number, o: { reveal: number; time?: number }) {
  const { cells, cols } = grid
  const inked = (i: number) => (cells[i]?.ink ?? 0) > 0.03
  for (const c of cells) {
    // 가장자리까지 거리 — 둥근 네모(초타원) 기준이라 네 변을 고르게 따라간다
    const fx = (c.x + c.w / 2) / w
    const fy = (c.y + c.h / 2) / h
    const nx = Math.abs((fx - 0.5) * 2)
    const ny = Math.abs((fy - 0.5) * 2)
    const d = Math.pow(Math.pow(nx, 4) + Math.pow(ny, 4), 1 / 4)
    let t = (d - EDGE_START) / (1 - EDGE_START) + (cellNoise(c.i) - 0.5) * 0.3
    if (o.reveal < 1) {
      const q = Math.min(1, Math.max(0, (o.reveal - cellNoise(c.i, 3) * 0.25) / 0.75))
      t = T_START + (t - T_START) * easeOut(q)
    }
    if (t <= 0) continue
    // 밝기 일렁임 — 카드를 가로지르는 잔물결 + 칸마다 약간의 엇갈림(0.16..1)
    const tw = o.time === undefined ? 1 : 0.58 + 0.42 * Math.sin(o.time * 1.7 - (fx * 2.4 + fy * 3.1) + cellNoise(c.i, 6) * 1.2)
    if (c.ink > 0.03) {
      g.fillStyle = c.paper // 원래 필기를 가리고
      g.fillRect(c.x, c.y, c.w, c.h)
      if (t < 0.45) {
        g.globalAlpha = Math.min(1, 0.4 + c.ink * 2.2) * tw
        g.fillStyle = c.color
        g.fillRect(c.x + 0.6, c.y + 0.6, c.w - 1.2, c.h - 1.2)
      } else if (t < 0.85) {
        g.globalAlpha = 0.8 * tw
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
