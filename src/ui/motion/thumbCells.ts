// 카드 미리보기를 칸으로 나눠 읽는다 — 칸마다 잉크 양·잉크 평균색·종이색.
// 등장 동작(tileReveal)과 디더 미리보기(ThumbDither)가 함께 쓴다.

export const THUMB_COLS = 18 // 가로 칸 수 — 칸 크기는 카드 폭에 맞춘다(격자 150px 카드면 약 8px)

export interface ThumbCell {
  i: number // 칸 번호(위에서부터 줄 순서) — 칸마다 고정된 흩어짐 값을 만들 때 쓴다
  x: number
  y: number
  w: number
  h: number
  ink: number // 0..1 잉크 비율
  color: string // 잉크 평균색 rgb() — 잉크가 없으면 종이색
  paper: string // 종이(잉크가 아닌 픽셀) 평균색 rgb()
  avg: [number, number, number] // 칸 전체 평균색(잉크+종이)
  inkRgb: [number, number, number] | null // 잉크 평균색 — 잉크가 없으면 null
}

export interface ThumbGrid {
  src: HTMLCanvasElement // 카드 크기(css px)로 다시 그린 미리보기
  cells: ThumbCell[]
  cols: number
  rows: number
  inkColor: string // 노트 전체 잉크 평균색
  inkRgb: [number, number, number] // 노트 전체 잉크 평균색(숫자)
  paperL: number // 종이 밝기(0..255)
  paperRgb: [number, number, number] // 종이(잉크가 아닌 픽셀) 평균색
}

/**
 * img를 w×h 카드에 object-fit: cover; object-position: top 으로 놓은 모습 그대로 칸을 읽는다.
 * 종이 밝기는 밝은 쪽 90% 지점 — 줄·모눈 속지나 PDF 바탕도 종이로 본다. 읽을 수 없으면 null
 */
export function readThumb(img: HTMLImageElement, w: number, h: number): ThumbGrid | null {
  if (!w || !h || !img.naturalWidth) return null
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight)
  const dw = img.naturalWidth * s
  const dh = img.naturalHeight * s
  const src = document.createElement('canvas')
  src.width = Math.ceil(w)
  src.height = Math.ceil(h)
  const sg = src.getContext('2d', { willReadFrequently: true })
  if (!sg) return null
  sg.drawImage(img, (w - dw) / 2, 0, dw, dh)
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

  const size = w / THUMB_COLS
  const cells: ThumbCell[] = []
  let ar = 0
  let ag = 0
  let ab = 0
  let an = 0
  const pa = [0, 0, 0, 0]
  let rows = 0
  for (let y = 0; y < h - 0.5; y += size) {
    rows++
    for (let x = 0; x < w - 0.5; x += size) {
      const cw = Math.min(size, w - x)
      const ch = Math.min(size, h - y)
      let ink = 0
      let n = 0
      const sum = [0, 0, 0]
      const psum = [0, 0, 0]
      for (let yy = Math.floor(y); yy < y + ch; yy += 2) {
        for (let xx = Math.floor(x); xx < x + cw; xx += 2) {
          const i = (yy * src.width + xx) * 4
          n++
          const L = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11
          const sat = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2])
          const t = paperL - L > 38 || sat > 70 ? sum : psum
          if (t === sum) ink++
          t[0] += data[i]
          t[1] += data[i + 1]
          t[2] += data[i + 2]
        }
      }
      const rgb = (v: number[], k: number) => `rgb(${(v[0] / k) | 0},${(v[1] / k) | 0},${(v[2] / k) | 0})`
      const paper = n - ink ? rgb(psum, n - ink) : 'rgb(255,255,255)'
      pa[0] += psum[0]
      pa[1] += psum[1]
      pa[2] += psum[2]
      pa[3] += n - ink
      if (ink) {
        ar += sum[0]
        ag += sum[1]
        ab += sum[2]
        an += ink
      }
      const avg: [number, number, number] = n ? [(sum[0] + psum[0]) / n, (sum[1] + psum[1]) / n, (sum[2] + psum[2]) / n] : [255, 255, 255]
      const inkRgb: [number, number, number] | null = ink ? [sum[0] / ink, sum[1] / ink, sum[2] / ink] : null
      cells.push({ i: cells.length, x, y, w: cw, h: ch, ink: n ? ink / n : 0, color: ink ? rgb(sum, ink) : paper, paper, avg, inkRgb })
    }
  }
  const inkColor = an ? `rgb(${(ar / an) | 0},${(ag / an) | 0},${(ab / an) | 0})` : 'rgb(60,60,60)'
  const inkRgb: [number, number, number] = an ? [ar / an, ag / an, ab / an] : [60, 60, 60]
  const paperRgb: [number, number, number] = pa[3] ? [pa[0] / pa[3], pa[1] / pa[3], pa[2] / pa[3]] : [255, 255, 255]
  return { src, cells, cols: Math.ceil(w / size - 0.01), rows, inkColor, inkRgb, paperL, paperRgb }
}

/** 8×8 베이어 행렬(0..63) — 디더 점이 고르게 흩어지는 문턱값 순서. 카드 디더·카테고리 색 번짐이 함께 쓴다 */
export const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9,
  41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21
]

/** 칸마다 고정된 0..1 값(다시 그려도 같은 무늬) */
export const cellNoise = (i: number, salt = 0) => {
  let x = (i + 1) * 374761393 + salt * 668265263
  x = (x ^ (x >>> 13)) * 1274126177
  return ((x ^ (x >>> 16)) >>> 0) / 4294967295
}

/** ＋ 하나 */
export function drawPlus(g: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  g.beginPath()
  g.moveTo(cx - r, cy)
  g.lineTo(cx + r, cy)
  g.moveTo(cx, cy - r)
  g.lineTo(cx, cy + r)
  g.stroke()
}
