import { useRef, useState } from 'react'
import { useUI } from '../app/store'
import { Icon } from './Icon'

const LS_POS = 'inkpad.quickpos.v1'

/**
 * 빠른 도구 전환 버튼 (FR-IN-07). Pencil 더블탭/스퀴즈는 웹에 전달되지 않으므로 화면 버튼으로 대신한다.
 * 탭: 펜 ↔ 지우개 / 길게 끌기: 위치 이동
 */
export function QuickSwitch() {
  const tool = useUI((s) => s.tool)
  const toggle = useUI((s) => s.toggleQuick)
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_POS) || '') as { x: number; y: number }
    } catch {
      return { x: 16, y: 120 }
    }
  })
  const drag = useRef<{ id: number; dx: number; dy: number; moved: boolean; sx: number; sy: number } | null>(null)

  const clamp = (x: number, y: number) => ({
    x: Math.max(4, Math.min(window.innerWidth - 64, x)),
    y: Math.max(64, Math.min(window.innerHeight - 64, y))
  })
  const p = clamp(pos.x, pos.y)

  return (
    <button
      id="quick-switch"
      className={'quick-switch' + (tool === 'eraser' ? ' is-eraser' : '')}
      style={{ left: p.x, top: p.y }}
      aria-label="펜과 지우개 전환"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { id: e.pointerId, dx: e.clientX - p.x, dy: e.clientY - p.y, moved: false, sx: e.clientX, sy: e.clientY }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || d.id !== e.pointerId) return
        if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 8) return
        d.moved = true
        setPos(clamp(e.clientX - d.dx, e.clientY - d.dy))
      }}
      onPointerUp={(e) => {
        const d = drag.current
        drag.current = null
        if (!d || d.id !== e.pointerId) return
        if (d.moved) localStorage.setItem(LS_POS, JSON.stringify(clamp(e.clientX - d.dx, e.clientY - d.dy)))
        else toggle()
      }}
      onPointerCancel={() => (drag.current = null)}
    >
      <Icon name={tool === 'eraser' ? 'eraser' : tool === 'highlighter' ? 'highlighter' : 'pen'} size={26} />
      <span className="quick-switch-badge"><Icon name="swap" size={12} /></span>
    </button>
  )
}
