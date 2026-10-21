// 카드 미리보기 등장 — 필기가 있는 칸만 그 잉크 색 타일로 맞춰지며 나타난다.
// 미리보기 그림을 칸으로 나눠 잉크 양·색을 한 번 읽고, 칸마다 (아래쪽 먼저) ＋ → 빈 사각형 → 채운 타일 → 실제 그림
// 순서로 바뀐다. 빈 종이 칸은 조금 늦게 그대로 드러난다. 끝나면 캔버스를 걷고 <img>를 보인다.

const DURATION = 680 // ms
const COLS = 18 // 가로 칸 수 — 칸 크기는 카드 폭에 맞춘다(격자 150px 카드면 약 8px)

interface Cell {
  x: number
  y: number
  w: number
  h: number
  ink: number // 0..1 잉크 비율
  color: string // 잉크 평균색(rgb)
  t0: number // 시작 시각(0..1)
  spark: boolean // 시작 직전 ＋를 보일지
}

/** img를 칸 타일로 맞춰지며 보이게 한다. 끝나면 done(). 모션을 끌 땐 부르지 않는다 */
export function tileReveal(img: HTMLImageElement, done: () => void) {
  const start = () => {
    const holder = img.parentElement
    const w = img.clientWidth
    const h = img.clientHeight
    if (!holder || !w || !h || !img.naturalWidth) return done()

    // object-fit: cover; object-position: top 과 같은 배치로 그린다
    const s = Math.max(w / img.naturalWidth, h / img.naturalHeight)
    const dw = img.naturalWidth * s
    const dh = img.naturalHeight * s
    const dx = (w - dw) / 2

    // 분석용(css px 그대로)
    const src = document.createElement('canvas')
    src.width = Math.ceil(w)
    src.height = Math.ceil(h)
    const sg = src.getContext('2d', { willReadFrequently: true })
    if (!sg) return done()
    sg.drawImage(img, dx, 0, dw, dh)
    let data: Uint8ClampedArray
    try {
      data = sg.getImageData(0, 0, src.width, src.height).data
    } catch {
      return done() // 다른 출처 그림 등
    }

    // 종이 밝기 — 밝은 쪽 90% 지점(줄·모눈 속지나 PDF 바탕도 종이로 본다)
    const lum: number[] = []
    for (let i = 0; i < data.length; i += 4 * 7) lum.push(data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11)
    lum.sort((a, b) => a - b)
    const paper = lum[Math.floor(lum.length * 0.9)] ?? 255

    const size = w / COLS
    const cells: Cell[] = []
    for (let y = 0; y < h; y += size) {
      for (let x = 0; x < w; x += size) {
        const cw = Math.min(size, w - x)
        const ch = Math.min(size, h - y)
        let ink = 0
        let n = 0
        let r = 0
        let g = 0
        let b = 0
        for (let yy = Math.floor(y); yy < y + ch; yy += 2) {
          for (let xx = Math.floor(x); xx < x + cw; xx += 2) {
            const i = (yy * src.width + xx) * 4
            n++
            const L = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11
            const sat = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2])
            if (paper - L > 38 || sat > 70) {
              ink++
              r += data[i]
              g += data[i + 1]
              b += data[i + 2]
            }
          }
        }
        const cov = n ? ink / n : 0
        const color = ink ? `rgb(${(r / ink) | 0},${(g / ink) | 0},${(b / ink) | 0})` : 'rgb(0,0,0)'
        // 아래쪽부터 — 위로 갈수록 늦게, 조금씩 흩어서
        const t0 = (1 - (y + ch / 2) / h) * 0.48 + Math.random() * 0.16
        cells.push({ x, y, w: cw, h: ch, ink: cov, color, t0, spark: Math.random() < 0.55 })
      }
    }

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const cv = document.createElement('canvas')
    cv.className = 'thumb-tiles'
    cv.width = Math.ceil(w * dpr)
    cv.height = Math.ceil(h * dpr)
    cv.style.width = `${w}px`
    cv.style.height = `${h}px`
    holder.insertBefore(cv, img.nextSibling)
    const g = cv.getContext('2d')
    if (!g) {
      cv.remove()
      return done()
    }
    g.scale(dpr, dpr)
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3355c8'

    const t = performance.now()
    const frame = (now: number) => {
      if (!cv.isConnected) return done()
      const p = Math.min(1, (now - t) / DURATION)
      g.clearRect(0, 0, w, h)
      for (const c of cells) {
        const ph = (p - c.t0) / 0.3 // 칸의 진행(0..1 동안 바뀐다)
        const inked = c.ink > 0.03
        if (!inked) {
          // 빈 종이 — 조금 늦게 그대로
          if (ph >= 0.55) g.drawImage(src, c.x, c.y, c.w, c.h, c.x, c.y, c.w, c.h)
          continue
        }
        if (ph >= 1) {
          g.drawImage(src, c.x, c.y, c.w, c.h, c.x, c.y, c.w, c.h)
        } else if (ph >= 0.45) {
          // 채운 타일 — 잉크 색
          g.globalAlpha = Math.min(1, 0.45 + c.ink * 2.2)
          g.fillStyle = c.color
          g.fillRect(c.x + 0.6, c.y + 0.6, c.w - 1.2, c.h - 1.2)
          g.globalAlpha = 1
        } else if (ph >= 0) {
          // 빈 사각형
          g.strokeStyle = c.color
          g.globalAlpha = 0.85
          g.lineWidth = 1.1
          g.strokeRect(c.x + 1.2, c.y + 1.2, c.w - 2.4, c.h - 2.4)
          g.globalAlpha = 1
        } else if (ph > -0.4 && c.spark) {
          // 직전 ＋ 반짝이
          const cx = c.x + c.w / 2
          const cy = c.y + c.h / 2
          const r = c.w * 0.28
          g.strokeStyle = accent
          g.globalAlpha = 0.9 * (1 + ph / 0.4)
          g.lineWidth = 1.2
          g.beginPath()
          g.moveTo(cx - r, cy)
          g.lineTo(cx + r, cy)
          g.moveTo(cx, cy - r)
          g.lineTo(cx, cy + r)
          g.stroke()
          g.globalAlpha = 1
        }
      }
      if (p < 1) requestAnimationFrame(frame)
      else {
        done()
        // 실제 <img>가 보인 다음 프레임에 걷어 깜빡임이 없게
        requestAnimationFrame(() => cv.remove())
      }
    }
    requestAnimationFrame(frame)
  }
  if (img.complete) start()
  else img.addEventListener('load', start, { once: true })
}
