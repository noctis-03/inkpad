import { useEffect, useRef } from 'react'
import { BAYER8, cellNoise, readThumb, THUMB_COLS, type ThumbGrid } from '../motion/thumbCells'

/**
 * 카드 미리보기 디더 캔버스.
 *
 * 머무는 동안 — 미리보기 전체를 1비트 디더(앳킨슨)로 그린다: 점마다 종이색 아니면 그 자리 펜 색, 두 가지뿐.
 * 움직이지 않으므로 다시 그리지 않는다.
 *
 * 등장 — 미리보기가 처음 보일 때 Library가 이 캔버스의 부모(.doc-thumb)에 'thumb-reveal' 이벤트를 보내면,
 * 빈 종이에서 디더 문턱값을 따라 점이 차오르며 나타난다(번지는 앞줄의 점은 펜 색으로 반짝).
 *
 * 카드를 눌러 여는 창(블러 베일)이 뜨면(open) — 캔버스가 블러 위로 올라와 디더 점이 같은 방식으로 걷히며
 * 아래의 원본(블러된)이 드러난다. 닫히면 다시 디더로 채워진다. 모션 끄기면 움직임 없이 바로.
 *
 * 카드의 원래 테두리 선(1px) 자리는 그 자리 가장자리 색으로 칠한다(원래 회색 선은 CSS에서 뺀다 — .doc-thumb:has(> .thumb-dither))
 */
export function ThumbDither({ src, open }: { src: string; open: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const ctl = useRef<{ setOpen: (v: boolean) => void } | null>(null)
  useEffect(() => {
    const cv = ref.current
    const holder = cv?.parentElement
    if (!cv || !holder) return
    let alive = true
    const img = new Image()
    let grid: ThumbGrid | null = null
    let dith: Dither | null = null
    let size = { w: 0, h: 0, radius: 0 }
    let reveal = 1 // 등장 진행 0..1 — 1이면 머무는 상태
    let openAmt = 0 // 여는 창 효과 0..1
    let openTarget = false
    let pending = false // 그림을 읽기 전에 등장 요청이 왔다
    let raf = 0
    const motionOn = () => document.documentElement.dataset.motion !== 'off'
    // 등장 동안 미리보기 <img>는 이 캔버스가 첫 장면을 그린 뒤에 보인다(그 전엔 리빌 대기 클립으로 가려져 있다)
    const showImg = () => holder.querySelector('img[data-reveal]')?.classList.add('is-revealed', 'no-anim')
    const paint = () => {
      const g = cv.getContext('2d')
      if (!g || !grid || !dith) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, size.w, size.h)
      // 여는 창 효과가 남아 있는 동안은 블러 베일 위에 둔다(닫히는 동안에도 — 베일 아래로 먼저 떨어지면 끊겨 보인다)
      cv.classList.toggle('is-lifted', openTarget || openAmt > 0)
      paintDither(g, dith, easeOut(reveal), easeOut(openAmt))
      paintFrame(g, grid, size.w, size.h, size.radius)
    }
    // 등장·여닫기가 움직이는 동안만 도는 루프
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
      paint()
      if (busy) raf = requestAnimationFrame(loop)
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
      dith = grid && makeDither(grid, w, h)
      if (!grid || !dith) {
        if (pending) showImg() // 읽을 수 없으면 효과 없이 그냥 보인다
        pending = false
        return
      }
      size = { w, h, radius: parseFloat(getComputedStyle(holder).borderTopLeftRadius) || 0 }
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      cv.width = Math.ceil(w * dpr)
      cv.height = Math.ceil(h * dpr)
      if (pending) play()
      else paint()
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
    return () => {
      alive = false
      ctl.current = null
      if (raf) cancelAnimationFrame(raf)
      holder.removeEventListener('thumb-reveal', play)
      ro.disconnect()
    }
  }, [src])
  useEffect(() => ctl.current?.setOpen(open), [open, src])
  return <canvas ref={ref} className="thumb-dither" aria-hidden="true" />
}

/** 디더 점 한 변(css px) */
const DOT = 2
/** 등장 길이(ms) */
const REVEAL_MS = 900
/** 여는 창에서 점이 걷히는·다시 차는 시간(ms) */
const OPEN_MS = 520
const CLOSE_MS = 320
/** 번지는 앞줄(반짝이는 점)의 폭 — 문턱값 단위 */
const FRONT = 0.08
/** 종이색에 곱하는 따뜻한 미색 — 흰 종이가 옛 화면처럼 살짝 누렇게 */
const WARM = [250 / 255, 247 / 255, 240 / 255]
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3)

interface Dither {
  cols: number
  rows: number
  dot: Uint8ClampedArray // 머무는 상태의 점 색 rgb(종이색 또는 펜 색)
  spark: Uint8ClampedArray // 번지는 앞줄에서 반짝일 펜 색 rgb
  paper: Uint8ClampedArray // 종이색 rgb
  q: Float32Array // 점마다 디졸브 문턱값 0..1
  buf: HTMLCanvasElement // 점 하나 = 1px 로 그린 뒤 확대한다
  img: ImageData
}

/** 미리보기를 DOT 크기 점으로 읽어 앳킨슨 디더로 1비트(종이 / 펜 색)로 만든다 */
function makeDither(grid: ThumbGrid, w: number, h: number): Dither | null {
  const sg = grid.src.getContext('2d', { willReadFrequently: true })
  if (!sg) return null
  const sw = grid.src.width
  const sh = grid.src.height
  let data: Uint8ClampedArray
  try {
    data = sg.getImageData(0, 0, sw, sh).data
  } catch {
    return null
  }
  const cols = Math.ceil(w / DOT)
  const rows = Math.ceil(h / DOT)
  const n = cols * rows
  // 점마다 진하기 0..1 — 종이 밝기에서 얼마나 어두운지 + 채도(형광펜·색 펜도 잉크로)
  const tone = new Float32Array(n)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let L = 0
      let sat = 0
      let k = 0
      for (let yy = y * DOT; yy < Math.min(sh, y * DOT + DOT); yy++) {
        for (let xx = x * DOT; xx < Math.min(sw, x * DOT + DOT); xx++) {
          const i = (yy * sw + xx) * 4
          L += data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11
          sat += Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2])
          k++
        }
      }
      if (!k) continue
      const dark = Math.max(0, grid.paperL - L / k) / 255
      tone[y * cols + x] = Math.min(1, (dark * 1.6 + (sat / k / 255) * 0.5) * 2.4)
    }
  }
  const paper: [number, number, number] = [grid.paperRgb[0] * WARM[0], grid.paperRgb[1] * WARM[1], grid.paperRgb[2] * WARM[2]]
  const dot = new Uint8ClampedArray(n * 3)
  const spark = new Uint8ClampedArray(n * 3)
  const q = new Float32Array(n)
  const cell = w / THUMB_COLS
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      // 앳킨슨 — 오차의 6/8만 이웃에 나눠 밝은 쪽이 깔끔하게 비고 선이 또렷하다
      const on = tone[i] > 0.5
      const err = (tone[i] - (on ? 1 : 0)) / 8
      for (const [dx, dy] of ATKINSON) {
        const X = x + dx
        const Y = y + dy
        if (X >= 0 && X < cols && Y < rows) tone[Y * cols + X] += err
      }
      // 점 색은 그 칸(약 8px)의 잉크 평균색 — 얇은 획도 원래 펜 색 그대로
      const cx = Math.min(grid.cols - 1, Math.floor(((x + 0.5) * DOT) / cell))
      const cy = Math.min(grid.rows - 1, Math.floor(((y + 0.5) * DOT) / cell))
      const ink = grid.cells[cy * grid.cols + cx]?.inkRgb ?? grid.inkRgb
      const c = on ? deepen(ink, 0.8) : paper
      dot.set(c, i * 3)
      spark.set(deepen(ink, 0.7), i * 3)
      q[i] = (BAYER8[(y & 7) * 8 + (x & 7)] + 0.5) / 64 * 0.8 + cellNoise((y >> 2) * 4099 + (x >> 2), 9) * 0.2
    }
  }
  const buf = document.createElement('canvas')
  buf.width = cols
  buf.height = rows
  const bg = buf.getContext('2d')
  if (!bg) return null
  return { cols, rows, dot, spark, paper: Uint8ClampedArray.from(paper), q, buf, img: bg.createImageData(cols, rows) }
}

const ATKINSON = [
  [1, 0],
  [2, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
  [0, 2]
]
const deepen = (c: readonly number[], k: number): [number, number, number] => [c[0] * k, c[1] * k, c[2] * k]

/**
 * 디더 그리기 — 점마다 문턱값 q와 번지는 앞줄을 견줘 정한다.
 * - reveal(0..1): 등장 — 빈 종이에서 디더 점으로(앞줄은 펜 색으로 반짝)
 * - open(0..1): 여는 창 — 디더 점이 걷히고 아래의 원본이 드러난다(투명)
 */
function paintDither(g: CanvasRenderingContext2D, d: Dither, reveal: number, open: number) {
  const out = d.img.data
  const rf = reveal * (1 + FRONT * 2) - FRONT
  const of = open * (1 + FRONT * 2) - FRONT
  for (let i = 0, n = d.cols * d.rows; i < n; i++) {
    const q = d.q[i]
    const o = i * 4
    // 앞줄을 지난 점부터: 여는 창이면 걷힘(투명) → 반짝 → 디더 / 등장이면 디더 → 반짝 → 빈 종이
    const src = q < of - FRONT ? null : q < of ? d.spark : q < rf - FRONT ? d.dot : q < rf ? d.spark : d.paper
    if (!src) {
      out[o + 3] = 0 // 아래의 원본이 보인다
      continue
    }
    const k = src === d.paper ? 0 : i * 3
    out[o] = src[k]
    out[o + 1] = src[k + 1]
    out[o + 2] = src[k + 2]
    out[o + 3] = 255
  }
  const bg = d.buf.getContext('2d')
  if (!bg) return
  bg.putImageData(d.img, 0, 0)
  g.imageSmoothingEnabled = false
  g.drawImage(d.buf, 0, 0, d.cols * DOT, d.rows * DOT)
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
