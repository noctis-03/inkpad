// 할 일을 꾹 눌러 다른 날로 옮기기 — 주·월·목록·그날 칸 어디서든.
//  - 옮길 수 있는 것: data-task-id(와 data-task-title)가 붙은 할 일 (주 칸 카드, 월 칸 줄, 목록 줄, 그날 칸 줄)
//  - 놓을 곳: data-day가 붙은 칸 — 'YYYY-MM-DD'면 그날 마감, 'none'이면 마감 없음
//  - 손가락·펜·마우스 모두 포인터 이벤트로. 0.35초 누른 채 거의 움직이지 않아야 시작한다 —
//    그 전에 움직이면 평소처럼 스크롤·누르기. 시작한 뒤에는 화면이 스크롤되지 않게 touchmove를 막는다
//  - 놓은 뒤의 click은 삼킨다 (카드를 놓았는데 자세히가 열리거나 날이 골라지지 않게)
import { useEffect, type RefObject } from 'react'

const HOLD_MS = 350
const SLOP_PX = 8

export function useTaskDrag(root: RefObject<HTMLElement | null>, onDrop: (taskId: string, day: string | null) => void) {
  useEffect(() => {
    const el = root.current
    if (!el) return
    let timer = 0
    let pid = -1
    let sx = 0
    let sy = 0
    let src: HTMLElement | null = null
    let ghost: HTMLElement | null = null
    let over: HTMLElement | null = null
    let dragging = false

    /** 손가락 오른쪽 위에 — 화면 가장자리에서는 안쪽으로 */
    const place = (x: number, y: number) => {
      if (!ghost) return
      const w = ghost.offsetWidth
      const h = ghost.offsetHeight
      const gx = Math.max(8, Math.min(x + 12, window.innerWidth - w - 8))
      const gy = Math.max(8, Math.min(y - h - 10, window.innerHeight - h - 8))
      ghost.style.transform = `translate(${gx}px, ${gy}px)`
    }
    const setOver = (t: HTMLElement | null) => {
      if (t === over) return
      over?.classList.remove('is-drop-target')
      over = t
      over?.classList.add('is-drop-target')
    }
    const end = () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('contextmenu', onContext, true)
      src?.classList.remove('is-dragging')
      ghost?.remove()
      setOver(null)
      document.documentElement.classList.remove('is-task-dragging')
      src = null
      ghost = null
      dragging = false
      pid = -1
    }
    const begin = () => {
      if (!src) return
      dragging = true
      src.classList.add('is-dragging')
      document.documentElement.classList.add('is-task-dragging')
      ghost = document.createElement('div')
      ghost.className = 'task-drag-ghost'
      ghost.textContent = src.dataset.taskTitle || src.textContent || ''
      document.body.append(ghost)
      place(sx, sy)
      ;(navigator as Navigator & { vibrate?: (ms: number) => boolean }).vibrate?.(8)
    }
    const targetAt = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y) as HTMLElement | null
      const t = hit?.closest<HTMLElement>('[data-day]')
      return t && el.contains(t) ? t : null
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pid) return
      if (!dragging) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) > SLOP_PX) end() // 누르는 중에 움직였다 — 스크롤
        return
      }
      e.preventDefault()
      place(e.clientX, e.clientY)
      setOver(targetAt(e.clientX, e.clientY))
    }
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pid) return
      if (dragging) {
        const id = src?.dataset.taskId
        const day = over?.dataset.day
        // 놓은 뒤 이어지는 click은 삼킨다
        const swallow = (ev: MouseEvent) => {
          ev.stopPropagation()
          ev.preventDefault()
        }
        window.addEventListener('click', swallow, true)
        window.setTimeout(() => window.removeEventListener('click', swallow, true), 0)
        if (id && day) onDrop(id, day === 'none' ? null : day)
      }
      end()
    }
    const onCancel = (e: PointerEvent) => e.pointerId === pid && end()
    const onTouchMove = (e: TouchEvent) => dragging && e.preventDefault()
    const onContext = (e: Event) => (dragging || timer) && e.preventDefault()

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || pid !== -1) return
      const t = e.target as HTMLElement
      if (t.closest('.task-check, .cal-check, input, textarea, select')) return // 끝내기 동그라미·입력은 평소대로
      const s = t.closest<HTMLElement>('[data-task-id]')
      if (!s || !el.contains(s)) return
      src = s
      pid = e.pointerId
      sx = e.clientX
      sy = e.clientY
      timer = window.setTimeout(() => {
        timer = 0
        begin()
      }, HOLD_MS)
      window.addEventListener('pointermove', onMove, { passive: false })
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      window.addEventListener('touchmove', onTouchMove, { passive: false })
      window.addEventListener('contextmenu', onContext, true)
    }
    el.addEventListener('pointerdown', onDown)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      end()
    }
  }, [root, onDrop])
}
