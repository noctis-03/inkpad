import { useEffect, useRef } from 'react'

/**
 * 카드 미리보기 망점 캔버스 — 미리보기 <img> 위에 얹어 선 망점(가로줄 하프톤)으로 그린다:
 * LINE px마다 가로줄 하나, 줄 굵기가 그 자리 필기의 진하기. 줄 색은 그 자리 펜 색. 움직이지 않는다.
 *
 * 가볍게 하려고:
 * - 캔버스는 가로 COL px = 1px, 세로 1/SUB px = 1px로 만들고 CSS로 맞춘다(image-rendering: pixelated) — 화면 해상도로 만들면 카드 80장에 약 48MB, 이렇게 하면 13MB 안팎
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
    const paint = (d: HTMLCanvasElement | null, key: string) => {
      drawn = key
      cv.classList.add('is-ready')
      cv.classList.toggle('is-failed', !d)
      if (!d) {
        cv.width = 0 // 그리지 못하면 비워서 원래 미리보기가 보이게
        return
      }
      cv.width = d.width
      cv.height = d.height
      cv.style.width = d.width * COL + 'px'
      cv.style.height = d.height / SUB + 'px'
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
        const d = makeScreen(img!, w, h)
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

// ── 만든 망점 기억 — 열쇠마다 작은 캔버스(175px 카드면 약 160KB). 오래 안 쓴 것부터 버린다 ──
const CACHE_MAX = 150
const cache = new Map<string, HTMLCanvasElement | null>()
function remember(key: string, d: HTMLCanvasElement | null) {
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

/** 가로줄 간격(css px) — 줄 하나가 이 띠 안에서 굵어졌다 가늘어진다 */
const LINE = 4
/** 줄 굵기 최대(css px) — 띠마다 1px 이상 비워 줄이 붙어 덩어리가 되지 않게 */
const MAX_TH = 3
/** 가로 해상도(css px) — 줄 굵기·색을 이만큼씩 읽는다. 2px 계단이 픽셀 결을 남긴다 */
const COL = 2
/** 세로 해상도 — css px 하나를 몇 행으로. 줄 굵기를 0.5px(레티나 화면 1점)씩 또렷하게 */
const SUB = 2
/** 종이색에 곱하는 따뜻한 미색 — 흰 종이가 아닌 종이(색 종이·PDF)를 칠할 때. 흰 종이는 비워 두고 CSS --thumb-cream이 비친다 */
const WARM = [250 / 255, 247 / 255, 240 / 255]

interface Thumb {
  tone: Float32Array // css px마다 필기 진하기 0..1 — 속지 줄·모눈은 0
  data: Uint8ClampedArray // 카드 크기(css px)로 다시 그린 미리보기 픽셀
  sw: number
  sh: number
  paperL: number // 종이 밝기(0..255)
  paperRgb: [number, number, number] // 종이(잉크가 아닌 픽셀) 평균색
}

/**
 * img를 w×h 카드에 object-fit: cover; object-position: top 으로 놓은 모습 그대로 읽는다.
 * 종이 밝기는 밝은 쪽 90% 지점 — 줄·모눈 속지나 PDF 바탕도 종이로 본다.
 * 진하기는 종이보다 25 넘게 어두운 만큼 + 채도(형광펜·색 펜) — 옅은 속지 선은 0이라 줄로 찍히지 않는다. 읽을 수 없으면 null
 */
function readThumb(img: HTMLImageElement, w: number, h: number): Thumb | null {
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
  const sw = src.width
  const sh = src.height
  const lum: number[] = []
  for (let i = 0; i < data.length; i += 4 * 7) lum.push(data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11)
  lum.sort((a, b) => a - b)
  const paperL = lum[Math.floor(lum.length * 0.9)] ?? 255

  const tone = new Float32Array(sw * sh)
  const pa = [0, 0, 0, 0]
  for (let p = 0; p < sw * sh; p++) {
    const i = p * 4
    const L = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11
    const sat = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2])
    const t = Math.min(1, Math.max(0, (paperL - L - 25) / 80) + Math.max(0, (sat - 60) / 140))
    tone[p] = t
    if (t === 0) {
      pa[0] += data[i]
      pa[1] += data[i + 1]
      pa[2] += data[i + 2]
      pa[3]++
    }
  }
  const paperRgb: [number, number, number] = pa[3] ? [pa[0] / pa[3], pa[1] / pa[3], pa[2] / pa[3]] : [255, 255, 255]
  return { tone, data, sw, sh, paperL, paperRgb }
}

/**
 * 선 망점 — LINE px 띠마다 가로줄 하나. 칸(COL px)마다 둘레(띠 + 위아래 1px, 좌우 1px)의 진하기를 모아
 * 평균에 최대를 조금 더해(얇은 획도 끊기지 않게) 줄 굵기 0..MAX_TH px(1/SUB px 단위)로, 그 자리 펜 색으로 칠한다.
 * 점 하나 = 가로 COL px · 세로 1/SUB px 인 캔버스. 읽을 수 없으면 null
 */
function makeScreen(img: HTMLImageElement, w: number, h: number): HTMLCanvasElement | null {
  const th = readThumb(img, w, h)
  if (!th) return null
  const { tone, data, sw, sh } = th
  const cols = Math.ceil(w / COL)
  const rows = Math.ceil(h) * SUB
  const out = document.createElement('canvas')
  out.width = cols
  out.height = rows
  const og = out.getContext('2d')
  if (!og) return null
  const im = og.createImageData(cols, rows)
  const px = im.data
  // 흰 종이면 종이 자리는 비워 둔다 — 카드 바탕(CSS --thumb-cream)이 비쳐 라이트·다크마다 다른 미색이 된다.
  // 색 종이·어두운 PDF처럼 흰 종이가 아니면 그 종이색 그대로 칠한다
  const [pr, pg, pb] = th.paperRgb
  const clearPaper = th.paperL > 230 && Math.max(pr, pg, pb) - Math.min(pr, pg, pb) < 18
  if (!clearPaper) {
    for (let i = 0; i < cols * rows; i++) {
      px[i * 4] = pr * WARM[0]
      px[i * 4 + 1] = pg * WARM[1]
      px[i * 4 + 2] = pb * WARM[2]
      px[i * 4 + 3] = 255
    }
  }
  for (let y0 = 0; y0 < sh; y0 += LINE) {
    for (let x = 0; x < cols; x++) {
      let sum = 0
      let max = 0
      let n = 0
      let cr = 0
      let cg = 0
      let cb = 0
      let cw = 0
      for (let yy = Math.max(0, y0 - 1); yy < Math.min(sh, y0 + LINE + 1); yy++) {
        for (let xx = Math.max(0, x * COL - 1); xx < Math.min(sw, x * COL + COL + 1); xx++) {
          const t = tone[yy * sw + xx]
          sum += t
          n++
          if (t > max) max = t
          if (t > 0.2) {
            // 펜 색은 진한 픽셀일수록 크게 — 번진 가장자리의 옅은 색에 끌려가지 않게
            const k = t * t * t
            const i = (yy * sw + xx) * 4
            cr += data[i] * k
            cg += data[i + 1] * k
            cb += data[i + 2] * k
            cw += k
          }
        }
      }
      if (!n) continue
      const t = Math.min(1, (sum / n) * 1.8 + max * 0.2)
      if (t < 0.06 || !cw) continue
      const thick = Math.round(Math.min(MAX_TH, LINE * t * 0.95) * SUB) // 행 수
      if (!thick) continue
      // 얇은 획은 미리보기에서 회색으로 번진다 — 펜 색 그대로 진하게: 무채색은 먹(밝기 50), 색 펜은 밝기 110까지
      let r = cr / cw
      let g = cg / cw
      let b = cb / cw
      const L = r * 0.3 + g * 0.59 + b * 0.11
      const k = Math.min(1, (Math.max(r, g, b) - Math.min(r, g, b) < 30 ? 50 : 110) / Math.max(1, L))
      r *= k
      g *= k
      b *= k
      // 줄은 띠 가운데에
      const top = y0 * SUB + Math.floor((LINE * SUB - thick) / 2)
      for (let y = top; y < Math.min(rows, top + thick); y++) {
        const i = (y * cols + x) * 4
        px[i] = r
        px[i + 1] = g
        px[i + 2] = b
        px[i + 3] = 255
      }
    }
  }
  og.putImageData(im, 0, 0)
  return out
}
