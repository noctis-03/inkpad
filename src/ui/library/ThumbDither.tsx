import { useEffect, useRef } from 'react'

/**
 * 카드 미리보기 디더 캔버스 — 미리보기 <img> 위에 얹어 1비트 디더(앳킨슨)로 그린다:
 * 2px 점마다 미색 종이 아니면 그 자리 펜 색, 두 가지뿐. 움직이지 않는다.
 *
 * 가볍게 하려고:
 * - 캔버스는 점 하나 = 1px 크기로 만들고 CSS로 DOT배 키운다(image-rendering: pixelated) — 화면 해상도로 만들면 카드 80장에 약 48MB
 * - 화면 근처에 온 카드만 만든다(IntersectionObserver)
 * - 만드는 일은 줄을 세워 한 번에 8ms까지만 하고 쉰다 — 한꺼번에 몰려 화면이 멈추지 않게
 * - 만든 것은 cacheKey(노트 id + 미리보기 만든 시각) + 카드 크기로 기억한다 — 편집 화면에서 돌아와도 다시 만들지 않는다
 * 그림을 읽을 수 없으면(다른 출처 등) 아무것도 그리지 않아 원래 미리보기가 그대로 보인다.
 */
export function ThumbDither({ src, cacheKey }: { src: string; cacheKey: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    const holder = cv?.parentElement
    if (!cv || !holder) return
    let alive = true
    let img: HTMLImageElement | null = null
    let seen = false // 화면 근처에 온 적이 있다 — 그 뒤로는 크기가 바뀌면 다시 그린다
    let drawn = '' // 지금 캔버스에 그린 것의 열쇠
    const paint = (r: Dithered | null, key: string) => {
      drawn = key
      cv.classList.add('is-ready')
      // 카드 테두리 선을 미리보기 대표색으로(CSS --thumb-ring) — 대표색이 없으면 원래 회색 선
      if (r?.main) holder.style.setProperty('--thumb-ring', r.main)
      else holder.style.removeProperty('--thumb-ring')
      if (!r) {
        cv.width = 0 // 그리지 못하면 비워서 원래 미리보기가 보이게
        return
      }
      const d = r.dots
      cv.width = d.width
      cv.height = d.height
      cv.style.width = d.width * DOT + 'px'
      cv.style.height = d.height * DOT + 'px'
      cv.getContext('2d')?.drawImage(d, 0, 0)
    }
    const request = () => {
      const w = holder.clientWidth
      const h = holder.clientHeight
      if (!w || !h) return
      const key = `${cacheKey}|${w}x${h}`
      if (key === drawn) return
      const hit = cache.get(key)
      if (hit !== undefined) return paint(hit, key)
      const compute = () => {
        if (!alive || holder.clientWidth !== w || holder.clientHeight !== h) return // 그 사이 크기가 바뀌면 새 요청이 다시 온다
        const d = makeDither(img!, w, h)
        remember(key, d)
        paint(d, key)
      }
      if (img?.complete && img.naturalWidth) return enqueue(compute)
      img = new Image()
      img.onload = () => enqueue(compute)
      img.onerror = () => alive && paint(null, key) // 읽지 못하면 원본(<img>)이 보이게
      img.src = src
    }
    const unwatch = watchNear(holder, () => {
      seen = true
      request()
    })
    const ro = new ResizeObserver(() => seen && request())
    ro.observe(holder)
    return () => {
      alive = false
      unwatch()
      ro.disconnect()
    }
  }, [src, cacheKey])
  return <canvas ref={ref} className="thumb-dither" width={0} height={0} aria-hidden="true" />
}

/** 만든 디더 — 점 하나 = 1px 캔버스와 미리보기 대표색(카드 테두리 선 색, 없으면 null) */
interface Dithered {
  dots: HTMLCanvasElement
  main: string | null
}

// ── 만든 디더 기억 — 열쇠마다 점 하나 = 1px 캔버스(150px 카드면 약 30KB). 오래 안 쓴 것부터 버린다 ──
const CACHE_MAX = 300
const cache = new Map<string, Dithered | null>()
function remember(key: string, d: Dithered | null) {
  cache.delete(key)
  cache.set(key, d)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
}

// ── 만드는 일 줄 — 한 번에 8ms까지만 하고 다음 틈으로 넘긴다 ──
const jobs: (() => void)[] = []
let pumping = false
function enqueue(job: () => void) {
  jobs.push(job)
  if (pumping) return
  pumping = true
  setTimeout(pump, 0)
}
function pump() {
  const t0 = performance.now()
  while (jobs.length && performance.now() - t0 < 8) jobs.shift()!()
  if (jobs.length) setTimeout(pump, 0)
  else pumping = false
}

// ── 화면 근처(위아래 한 화면 남짓)에 처음 들어오면 한 번 알린다 — 카드마다 따로 만들지 않고 하나를 같이 쓴다 ──
const nearCbs = new Map<Element, () => void>()
let nearIo: IntersectionObserver | null = null
function watchNear(el: Element, cb: () => void) {
  nearIo ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const f = nearCbs.get(e.target)
        nearCbs.delete(e.target)
        nearIo!.unobserve(e.target)
        f?.()
      }
    },
    { rootMargin: '100% 0px' }
  )
  nearCbs.set(el, cb)
  nearIo.observe(el)
  return () => {
    nearCbs.delete(el)
    nearIo?.unobserve(el)
  }
}

/** 대표색을 종이색에서 얼마나 떨어뜨릴지(가장 먼 채널 기준, 0..255) */
const INK_REACH = 190
/** 카드 테두리 선에 쓰는 대표색의 진하기 */
const RING_ALPHA = 0.75
/** 디더 점 한 변(css px) */
const DOT = 2
/** 펜 색을 칸 단위로 읽는다 — 가로 칸 수(150px 카드면 칸 하나 약 8px) */
const COLS = 18
/** 종이색에 곱하는 따뜻한 미색 — 흰 종이가 옛 화면처럼 살짝 누렇게(흰 종이면 #faf7f0 = CSS --thumb-cream) */
const WARM = [250 / 255, 247 / 255, 240 / 255]

interface ThumbGrid {
  data: Uint8ClampedArray // 카드 크기(css px)로 다시 그린 미리보기 픽셀
  sw: number
  sh: number
  cols: number
  rows: number
  cell: number // 칸 한 변(css px)
  inkRgb: ([number, number, number] | null)[] // 칸마다 잉크 평균색 — 잉크가 없으면 null
  allInk: [number, number, number] // 노트 전체 잉크 평균색
  paperL: number // 종이 밝기(0..255)
  paperRgb: [number, number, number] // 종이(잉크가 아닌 픽셀) 평균색
  main: [number, number, number] | null // 대표색 — 잉크가 없으면 null (pickMain)
}

/**
 * img를 w×h 카드에 object-fit: cover; object-position: top 으로 놓은 모습 그대로 칸을 읽는다.
 * 종이 밝기는 밝은 쪽 90% 지점 — 줄·모눈 속지나 PDF 바탕도 종이로 본다. 읽을 수 없으면 null
 */
function readThumb(img: HTMLImageElement, w: number, h: number): ThumbGrid | null {
  if (!w || !h || !img.naturalWidth) return null
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight)
  const src = document.createElement('canvas')
  src.width = Math.ceil(w)
  src.height = Math.ceil(h)
  const sg = src.getContext('2d', { willReadFrequently: true })
  if (!sg) return null
  sg.drawImage(img, (w - img.naturalWidth * s) / 2, 0, img.naturalWidth * s, img.naturalHeight * s)
  let data: Uint8ClampedArray
  try {
    data = sg.getImageData(0, 0, src.width, src.height).data
  } catch {
    return null // 다른 출처 그림 등
  }
  const lum: number[] = []
  for (let i = 0; i < data.length; i += 4 * 7) lum.push(data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11)
  lum.sort((a, b) => a - b)
  const paperL = lum[Math.floor(lum.length * 0.9)] ?? 255

  const cell = w / COLS
  const cols = Math.ceil(w / cell - 0.01)
  const rows = Math.ceil(h / cell - 0.01)
  const inkRgb: ([number, number, number] | null)[] = []
  const all = [0, 0, 0, 0]
  const pa = [0, 0, 0, 0]
  const hist = new Hist()
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const sum = [0, 0, 0]
      let ink = 0
      for (let yy = Math.floor(cy * cell); yy < Math.min(src.height, (cy + 1) * cell); yy += 2) {
        for (let xx = Math.floor(cx * cell); xx < Math.min(src.width, (cx + 1) * cell); xx += 2) {
          const i = (yy * src.width + xx) * 4
          const L = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11
          const sat = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2])
          const t = paperL - L > 38 || sat > 70 ? sum : pa
          if (t === sum) {
            ink++
            hist.add(data[i], data[i + 1], data[i + 2], sat > 60)
          } else pa[3]++
          t[0] += data[i]
          t[1] += data[i + 1]
          t[2] += data[i + 2]
        }
      }
      inkRgb.push(ink ? [sum[0] / ink, sum[1] / ink, sum[2] / ink] : null)
      all[0] += sum[0]
      all[1] += sum[1]
      all[2] += sum[2]
      all[3] += ink
    }
  }
  const allInk: [number, number, number] = all[3] ? [all[0] / all[3], all[1] / all[3], all[2] / all[3]] : [60, 60, 60]
  const paperRgb: [number, number, number] = pa[3] ? [pa[0] / pa[3], pa[1] / pa[3], pa[2] / pa[3]] : [255, 255, 255]
  return { data, sw: src.width, sh: src.height, cols, rows, cell, inkRgb, allInk, paperL, paperRgb, main: hist.pick(paperRgb) }
}

/**
 * 잉크 색 모으기 — 색을 칸(채널마다 8단계, 512칸)으로 나눠 세고, 대표색을 고른다:
 * 색 펜(파랑·빨강·형광펜 등, 채도 높은 잉크)이 잉크의 10% 이상이면 그중에서, 아니면(거의 검은 펜) 잉크 전체에서 고른다.
 * 그냥 가장 많은 칸을 고르면 가는 획 가장자리의 옅은 픽셀이 이겨 색이 바랜다 — 개수에 진하기(색 펜은 채도, 아니면 어둡기)의 제곱을 곱해 견준다.
 * 카드 크기에선 펜 획이 1px도 안 돼 픽셀이 종이와 섞여 있으므로, 고른 색을 종이색에서 멀어지는 쪽으로 늘려 원래 펜 진하기에 가깝게 한다
 */
class Hist {
  all = new Float64Array(512 * 4) // 칸마다 [개수, r합, g합, b합]
  col = new Float64Array(512 * 4)
  n = 0
  nCol = 0
  add(r: number, g: number, b: number, colored: boolean) {
    const k = ((r >> 5) * 64 + (g >> 5) * 8 + (b >> 5)) * 4
    for (const h of colored ? [this.all, this.col] : [this.all]) {
      h[k]++
      h[k + 1] += r
      h[k + 2] += g
      h[k + 3] += b
    }
    this.n++
    if (colored) this.nCol++
  }
  pick(paper: [number, number, number]): [number, number, number] | null {
    if (!this.n) return null
    const colored = this.nCol >= this.n * 0.1
    const h = colored ? this.col : this.all
    let best = -1
    let bestScore = 0
    for (let k = 0; k < h.length; k += 4) {
      const c = h[k]
      if (!c) continue
      const r = h[k + 1] / c
      const g = h[k + 2] / c
      const b = h[k + 3] / c
      const strength = colored ? (Math.max(r, g, b) - Math.min(r, g, b)) / 255 : 1 - (r * 0.3 + g * 0.59 + b * 0.11) / 255
      const score = c * strength * strength
      if (score > bestScore) {
        bestScore = score
        best = k
      }
    }
    if (best < 0) return null
    const c = h[best]
    const v = [h[best + 1] / c - paper[0], h[best + 2] / c - paper[1], h[best + 3] / c - paper[2]]
    const far = Math.max(...v.map(Math.abs)) || 1
    const k = Math.min(3, INK_REACH / far) // 종이에서 가장 먼 채널이 INK_REACH만큼 떨어지게(최대 3배)
    const ch = (i: number) => Math.max(0, Math.min(255, paper[i] + v[i] * k))
    return [ch(0), ch(1), ch(2)]
  }
}

/** 미리보기를 DOT 크기 점으로 읽어 앳킨슨 디더로 1비트(종이 / 펜 색)로 만든다 — 점 하나 = 1px 인 캔버스와 대표색. 읽을 수 없으면 null */
function makeDither(img: HTMLImageElement, w: number, h: number): Dithered | null {
  const grid = readThumb(img, w, h)
  if (!grid) return null
  const { data, sw, sh } = grid
  const cols = Math.ceil(w / DOT)
  const rows = Math.ceil(h / DOT)
  // 점마다 진하기 0..1 — 종이 밝기에서 얼마나 어두운지 + 채도(형광펜·색 펜도 잉크로)
  const tone = new Float32Array(cols * rows)
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
  const out = document.createElement('canvas')
  out.width = cols
  out.height = rows
  const og = out.getContext('2d')
  if (!og) return null
  const im = og.createImageData(cols, rows)
  const px = im.data
  const paper = [grid.paperRgb[0] * WARM[0], grid.paperRgb[1] * WARM[1], grid.paperRgb[2] * WARM[2]]
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
      // 점 색은 그 칸(약 8px)의 잉크 평균색을 조금 진하게 — 얇은 획도 원래 펜 색 그대로
      let c = paper
      if (on) {
        const cx = Math.min(grid.cols - 1, Math.floor(((x + 0.5) * DOT) / grid.cell))
        const cy = Math.min(grid.rows - 1, Math.floor(((y + 0.5) * DOT) / grid.cell))
        const ink = grid.inkRgb[cy * grid.cols + cx] ?? grid.allInk
        c = [ink[0] * 0.8, ink[1] * 0.8, ink[2] * 0.8]
      }
      px[i * 4] = c[0]
      px[i * 4 + 1] = c[1]
      px[i * 4 + 2] = c[2]
      px[i * 4 + 3] = 255
    }
  }
  og.putImageData(im, 0, 0)
  const m = grid.main
  return { dots: out, main: m && `rgb(${m[0] | 0} ${m[1] | 0} ${m[2] | 0} / ${RING_ALPHA})` }
}

const ATKINSON = [
  [1, 0],
  [2, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
  [0, 2]
]
