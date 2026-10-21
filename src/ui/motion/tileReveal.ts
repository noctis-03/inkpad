// 카드 미리보기 등장 — 필기가 있는 칸만 그 잉크 색 타일로 맞춰지며 나타난다.
// 미리보기 그림을 칸으로 나눠 잉크 양·색을 한 번 읽고(readThumb), 칸마다 (아래쪽 먼저) ＋ → 빈 사각형 → 채운 타일 → 실제 그림
// 순서로 바뀐다. 빈 종이 칸은 조금 늦게 그대로 드러난다. 끝나면 캔버스를 걷고 <img>를 보인다.
import { drawPlus, readThumb } from './thumbCells'

const DURATION = 680 // ms

/** img를 칸 타일로 맞춰지며 보이게 한다. 끝나면 done(). 모션을 끌 땐 부르지 않는다 */
export function tileReveal(img: HTMLImageElement, done: () => void) {
  const start = () => {
    const holder = img.parentElement
    const w = img.clientWidth
    const h = img.clientHeight
    const grid = holder ? readThumb(img, w, h) : null
    if (!holder || !grid) return done()
    const { src, cells } = grid
    // 아래쪽부터 — 위로 갈수록 늦게, 조금씩 흩어서
    const t0 = cells.map((c) => (1 - (c.y + c.h / 2) / h) * 0.48 + Math.random() * 0.16)
    const spark = cells.map(() => Math.random() < 0.55)

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
        const ph = (p - t0[c.i]) / 0.3 // 칸의 진행(0..1 동안 바뀐다)
        if (c.ink <= 0.03) {
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
        } else if (ph > -0.4 && spark[c.i]) {
          // 직전 ＋ 반짝이
          g.strokeStyle = accent
          g.globalAlpha = 0.9 * (1 + ph / 0.4)
          g.lineWidth = 1.2
          drawPlus(g, c.x + c.w / 2, c.y + c.h / 2, c.w * 0.28)
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
