// 미니맵 — 확대해 좌우가 화면 밖일 때 왼쪽 위에 가는 막대 하나로, 지금 보는 높이에서 가로 전체 폭(페이지·보조 용지·삐져나간 필기까지)을
// 보여 준다: 회색 막대 = 전체 폭, 파란 구간 = 지금 보이는 부분, 검은 눈금 = 필기가 있는 가로 자리. 파란 구간 바깥에 눈금이 있으면
// 화면 밖 왼쪽·오른쪽에 필기가 있다는 뜻이다 (필기 모양은 그리지 않는다 — 있는지만 본다).
// 누르거나 그 위에 써도 아무 반응이 없다(pointer-events: none) — 입력은 그대로 아래 캔버스에 닿아 평소처럼 필기된다.
// 펜이 미니맵 아래로 오면(대거나 띄워서 가까이) 흐려져 쓰는 글씨를 가리지 않는다.
// 카메라·필기·배치가 바뀌면 React를 거치지 않고 한 프레임에 한 번 작은 캔버스만 다시 그린다 — 가만히 있으면 아무것도 하지 않는다.
import { useEffect, useRef } from 'react'
import type { Engine } from '../../engine/engine'
import { useUI } from '../../app/store'

const MAX_W = 160 // 막대 폭(css px) 상한 — 화면 폭의 30%를 넘지 않는다
const BAR_H = 10 // 막대 높이
const TICK_MIN = 2 // 눈금 최소 폭(css px) — 아주 짧은 필기도 보이게
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
      let x0 = vx0
      let x1 = vx1
      const widen = (l: number, r: number) => {
        x0 = Math.min(x0, l)
        x1 = Math.max(x1, r)
      }
      if (L.paged) {
        for (const p of L.visiblePages(vy0, vy1)) {
          const r = L.rects.get(p.id)!
          widen(r.x, r.x + r.w)
        }
        for (const sh of engine.sheets) {
          const r = L.rects.get(sh.id)
          if (r && r.y < vy1 && r.y + r.h > vy0) widen(r.x, r.x + r.w)
        }
      }
      const ink: [number, number][] = []
      for (const rec of engine.scene.query(-Infinity, vy0, Infinity, vy1)) {
        ink.push([rec.item.minX, rec.item.maxX])
        widen(rec.item.minX, rec.item.maxX)
      }
      // 좌우가 모두 화면 안이면 보여 줄 것이 없다
      const tol = 2 / zoom
      if (!(x0 < vx0 - tol || x1 > vx1 + tol)) {
        box.hidden = true
        shown = null
        return
      }
      const w = Math.max(80, Math.min(MAX_W, W * 0.3))
      const h = BAR_H
      const k = w / (x1 - x0)
      const X = (v: number) => (v - x0) * k
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const cw = Math.round(w * dpr)
      const ch = Math.round(h * dpr)
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw
        canvas.height = ch
        canvas.style.width = `${w}px`
        canvas.style.height = `${h}px`
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      // 막대 = 전체 폭
      ctx.fillStyle = 'rgba(100,116,139,0.28)'
      ctx.beginPath()
      ctx.roundRect(0, 0, w, h, h / 2)
      ctx.fill()
      // 지금 보이는 부분
      const sx0 = X(vx0)
      const sx1 = X(vx1)
      ctx.fillStyle = 'rgba(37,99,235,0.35)'
      ctx.strokeStyle = '#2563eb'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.roundRect(sx0 + 0.75, 0.75, Math.max(2, sx1 - sx0 - 1.5), h - 1.5, (h - 1.5) / 2)
      ctx.fill()
      ctx.stroke()
      // 필기 눈금 — 겹치는 자리는 합친다. 화면 밖(파란 구간 바깥)은 진하게, 안은 옅게
      ink.sort((a, b) => a[0] - b[0])
      const tick = (l: number, r: number) => {
        let a = X(l)
        let b = X(r)
        if (b - a < TICK_MIN) {
          const c = (a + b) / 2
          a = c - TICK_MIN / 2
          b = c + TICK_MIN / 2
        }
        ctx.fillStyle = 'rgba(17,24,39,0.35)'
        ctx.fillRect(a, 2, b - a, h - 4)
        // 파란 구간 바깥으로 나간 부분만 진하게
        ctx.fillStyle = '#111827'
        if (a < sx0) ctx.fillRect(a, 2, Math.min(b, sx0) - a, h - 4)
        if (b > sx1) ctx.fillRect(Math.max(a, sx1), 2, b - Math.max(a, sx1), h - 4)
      }
      let cl = -Infinity
      let cr = -Infinity
      for (const [l, r] of ink) {
        if (l - cr > 1 / k) {
          if (cr > -Infinity) tick(cl, cr)
          cl = l
          cr = r
        } else cr = Math.max(cr, r)
      }
      if (cr > -Infinity) tick(cl, cr)

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
    // 도구창이 옮겨 가거나(위치를 바꾸거나 끌면 style.left/top이 바뀌고 미끄러져 간다) 크기가 바뀌면 다시 비켜 선다 —
    // 카메라는 그대로라 위 알림이 오지 않는다. 미끄러지는 동안(.32s)이 끝난 뒤에도 한 번 더 본다
    let settle = 0
    const bar = area.querySelector('.ft-bar')
    if (bar) ro.observe(bar)
    const mo = new MutationObserver(() => {
      schedule()
      clearTimeout(settle)
      settle = window.setTimeout(schedule, 400)
    })
    if (bar) mo.observe(bar, { attributes: true, attributeFilter: ['style'] })
    return () => {
      mo.disconnect()
      clearTimeout(settle)
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
