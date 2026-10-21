import { useEffect, useRef } from 'react'

/**
 * 카드 미리보기 디더 캔버스 — 미리보기 <img> 위에 얹어 1비트 디더(앳킨슨)로 그린다:
 * 2px 점마다 미색 종이 아니면 그 자리 펜 색, 두 가지뿐.
 * 움직이지 않는다 — 그림을 읽을 때와 카드 크기가 바뀔 때 한 번씩만 그린다.
 * 그림을 읽을 수 없으면(다른 출처 등) 아무것도 그리지 않아 원래 미리보기가 그대로 보인다.
 */
export function ThumbDither({ src }: { src: string }) {
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
      const dith = grid && makeDither(grid, w, h)
      const g = cv.getContext('2d')
      if (!dith || !g) {
        cv.width = 0 // 그리지 못하면 비워서 원래 미리보기가 보이게
        return
      }
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      cv.width = Math.ceil(w * dpr)
      cv.height = Math.ceil(h * dpr)
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.imageSmoothingEnabled = false
      g.drawImage(dith, 0, 0, dith.width * DOT, dith.height * DOT)
    }
    img.onload = draw
    img.src = src
    let lastW = 0
    let lastH = 0
    const ro = new ResizeObserver(() => {
      // 크기가 그대로면 다시 그리지 않는다
      if (holder.clientWidth === lastW && holder.clientHeight === lastH) return
      lastW = holder.clientWidth
      lastH = holder.clientHeight
      draw()
    })
    ro.observe(holder)
    return () => {
      alive = false
      ro.disconnect()
    }
  }, [src])
  return <canvas ref={ref} className="thumb-dither" aria-hidden="true" />
}

/** 디더 점 한 변(css px) */
const DOT = 2
/** 펜 색을 칸 단위로 읽는다 — 가로 칸 수(150px 카드면 칸 하나 약 8px) */
const COLS = 18
/** 종이색에 곱하는 따뜻한 미색 — 흰 종이가 옛 화면처럼 살짝 누렇게(흰 종이면 #faf7f0 = CSS --thumb-cream) */
const WARM = [250 / 255, 247 / 255, 240 / 255]

interface ThumbGrid {
  src: HTMLCanvasElement // 카드 크기(css px)로 다시 그린 미리보기
  cols: number
  rows: number
  cell: number // 칸 한 변(css px)
  inkRgb: ([number, number, number] | null)[] // 칸마다 잉크 평균색 — 잉크가 없으면 null
  allInk: [number, number, number] // 노트 전체 잉크 평균색
  paperL: number // 종이 밝기(0..255)
  paperRgb: [number, number, number] // 종이(잉크가 아닌 픽셀) 평균색
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
          if (t === sum) ink++
          else pa[3]++
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
  return { src, cols, rows, cell, inkRgb, allInk, paperL, paperRgb }
}

/** 미리보기를 DOT 크기 점으로 읽어 앳킨슨 디더로 1비트(종이 / 펜 색)로 만든다 — 점 하나 = 1px 인 캔버스 */
function makeDither(grid: ThumbGrid, w: number, h: number): HTMLCanvasElement | null {
  const sg = grid.src.getContext('2d', { willReadFrequently: true })
  if (!sg) return null
  const sw = grid.src.width
  const sh = grid.src.height
  const data = sg.getImageData(0, 0, sw, sh).data
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
  return out
}

const ATKINSON = [
  [1, 0],
  [2, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
  [0, 2]
]
