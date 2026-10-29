// 미니맵 — 확대해 좌우가 화면 밖일 때 왼쪽 위에, 지금 보는 높이의 띠를 가로 전체 폭(페이지·보조 용지·삐져나간 필기까지)으로
// 작게 보여 주고 지금 보이는 자리를 사각형으로 표시한다. 화면 밖 왼쪽·오른쪽에 쓴 필기가 있는지 한눈에 보려는 것이다.
// 누르거나 그 위에 써도 아무 반응이 없다(pointer-events: none) — 입력은 그대로 아래 캔버스에 닿아 평소처럼 필기된다.
// 펜이 미니맵 아래로 오면(대거나 띄워서 가까이) 흐려져 쓰는 글씨를 가리지 않는다.
// 카메라·필기·배치가 바뀌면 React를 거치지 않고 한 프레임에 한 번 작은 캔버스만 다시 그린다 — 가만히 있으면 아무것도 하지 않는다.
import { useEffect, useRef } from 'react'
import type { Engine } from '../../engine/engine'
import type { Rect } from '../../engine/layout'
import { getPath } from '../../engine/scene'
import { useUI } from '../../app/store'

const MAX_W = 200 // 폭(css px) 상한 — 화면 폭의 30%를 넘지 않는다
const MAX_H = 140 // 높이 상한
const MIN_BAND = 0.3 // 띠 높이는 적어도 폭의 이만큼 — 크게 확대해도 납작한 줄이 되지 않게
const MARGIN = 12 // 화면 가장자리·도구창과의 틈
const FADE_PAD = 16 // 펜이 이만큼 가까이 오면 흐려진다
const PAD = 4 // 판 안쪽 여백 (CSS .minimap padding과 같게)

export function Minimap({ engine }: { engine: Engine }) {
  const on = useUI((s) => s.settings.minimap)
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const box = boxRef.current
    const canvas = canvasRef.current
    const area = box?.parentElement
    if (!on || !box || !canvas || !area) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    /** 보이는 동안의 화면 자리 — 펜이 가까이 왔는지 볼 때 쓴다 */
    let shown: DOMRect | null = null

    const draw = () => {
      raf = 0
      const W = area.clientWidth
      const H = area.clientHeight
      const { x: cx, y: cy, zoom } = engine.cam
      const vx0 = cx
      const vx1 = cx + W / zoom
      const vy0 = cy
      const vy1 = cy + H / zoom
      // 지금 보는 높이에 걸친 페이지·보조 용지·필기의 가로 범위
      const L = engine.layout
      const papers: Rect[] = []
      if (L.paged) {
        for (const p of L.visiblePages(vy0, vy1)) papers.push(L.rects.get(p.id)!)
        for (const s of engine.sheets) {
          const r = L.rects.get(s.id)
          if (r && r.y < vy1 && r.y + r.h > vy0) papers.push(r)
        }
      }
      let x0 = vx0
      let x1 = vx1
      for (const r of papers) {
        x0 = Math.min(x0, r.x)
        x1 = Math.max(x1, r.x + r.w)
      }
      for (const rec of engine.scene.query(-Infinity, vy0, Infinity, vy1)) {
        x0 = Math.min(x0, rec.item.minX)
        x1 = Math.max(x1, rec.item.maxX)
      }
      // 좌우가 모두 화면 안이면 보여 줄 것이 없다
      const tol = 2 / zoom
      if (!(x0 < vx0 - tol || x1 > vx1 + tol)) {
        box.hidden = true
        shown = null
        return
      }
      // 크기: 가로 전체를 폭 w에, 띠 높이는 보이는 높이(너무 납작하면 늘리고, 너무 높으면 가운데를 잘라)
      const w = Math.max(80, Math.min(MAX_W, W * 0.3))
      const k = w / (x1 - x0)
      const band = Math.min(Math.max(vy1 - vy0, (x1 - x0) * MIN_BAND), MAX_H / k)
      const by0 = (vy0 + vy1) / 2 - band / 2
      const by1 = by0 + band
      const h = band * k
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const cw = Math.round(w * dpr)
      const ch = Math.max(1, Math.round(h * dpr))
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw
        canvas.height = ch
        canvas.style.width = `${w}px`
        canvas.style.height = `${h}px`
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, cw, ch)
      const s = dpr * k
      // 종이 (화면처럼 테마와 상관없이 밝게)
      ctx.setTransform(s, 0, 0, s, -x0 * s, -by0 * s)
      for (const r of papers) {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(r.x, r.y, r.w, r.h)
        ctx.lineWidth = 1 / s
        ctx.strokeStyle = 'rgba(0,0,0,0.18)'
        ctx.strokeRect(r.x, r.y, r.w, r.h)
      }
      // 필기 — 아주 작게 줄어도 보이게 외곽선 둘레를 0.8px 덧그린다
      for (const rec of engine.scene.query(x0, by0, x1, by1)) {
        const t = s * rec.os
        ctx.setTransform(t, 0, 0, t, (rec.ox - x0) * s, (rec.oy - by0) * s)
        const path = getPath(rec)
        ctx.fillStyle = ctx.strokeStyle = rec.stroke.color
        ctx.fill(path)
        ctx.lineWidth = (0.8 * dpr) / t
        ctx.stroke(path)
      }
      // 지금 보이는 자리
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.lineWidth = 1.5
      ctx.strokeStyle = '#2563eb'
      ctx.strokeRect((vx0 - x0) * k + 0.75, (vy0 - by0) * k + 0.75, (vx1 - vx0) * k - 1.5, (vy1 - vy0) * k - 1.5)

      // 자리: 왼쪽 위. 도구창과 겹치면 가로로 긴 도구창이면 그 아래로, 세로로 긴 도구창이면 그 오른쪽으로
      const a = area.getBoundingClientRect()
      let left = MARGIN
      let top = MARGIN
      const bar = area.querySelector('.ft-bar')?.getBoundingClientRect()
      if (bar && bar.width && bar.height) {
        const bl = bar.left - a.left
        const bt = bar.top - a.top
        const hit = bl < left + w + PAD * 2 && bl + bar.width > left && bt < top + h + PAD * 2 && bt + bar.height > top
        if (hit) {
          if (bar.width >= bar.height) top = bt + bar.height + MARGIN
          else left = bl + bar.width + MARGIN
        }
      }
      box.style.left = `${left}px`
      box.style.top = `${top}px`
      box.hidden = false
      shown = new DOMRect(a.left + left, a.top + top, w + PAD * 2, h + PAD * 2)
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw)
    }

    // 펜이 미니맵 아래로 오면 흐리게 — 펜(대거나 띄워 가까이)이나 누른 채 움직이는 입력만. 마우스를 그냥 올린 것은 그대로
    let unfade = 0
    const setFaded = (v: boolean) => box.classList.toggle('is-faded', v)
    const near = (e: PointerEvent) =>
      !!shown && e.clientX >= shown.left - FADE_PAD && e.clientX <= shown.right + FADE_PAD && e.clientY >= shown.top - FADE_PAD && e.clientY <= shown.bottom + FADE_PAD
    const onPointer = (e: PointerEvent) => {
      if (e.type === 'pointerup' || e.type === 'pointercancel') {
        // 띄운 펜을 알 수 없는 기기도 있다 — 뗀 뒤 잠시 있다가 되돌린다
        clearTimeout(unfade)
        unfade = window.setTimeout(() => setFaded(false), 700)
        return
      }
      const close = near(e) && (e.pointerType === 'pen' || e.buttons !== 0)
      if (close) clearTimeout(unfade)
      setFaded(close)
    }
    const opts = { capture: true, passive: true }
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const) window.addEventListener(t, onPointer, opts)

    const offCam = engine.onCamera(schedule)
    const offContent = engine.onContent(schedule)
    const offSheets = engine.subscribeSheets(schedule)
    const ro = new ResizeObserver(schedule)
    ro.observe(area)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(unfade)
      for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const) window.removeEventListener(t, onPointer, opts)
      offCam()
      offContent()
      offSheets()
      ro.disconnect()
    }
  }, [engine, on])

  if (!on) return null
  return (
    <div ref={boxRef} className="minimap" hidden aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  )
}
