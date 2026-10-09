import { useRef, useState } from 'react'
import { useUI } from '../app/store'
import { Icon } from './Icon'

const LS_POS = 'inkpad.quickpos.v1'
const SIZE = 56

/** env(safe-area-inset-*)는 CSS env()에서만 읽히므로 숨은 탐침 요소로 재 산출한다 (C-3) */
function safeInset(): { top: number; bottom: number } {
  const el = document.createElement('div')
  el.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding:0 env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-top,0px)'
  document.body.appendChild(el)
  const s = getComputedStyle(el)
  const out = { top: parseFloat(s.paddingLeft) || 0, bottom: parseFloat(s.paddingBottom) || 0 }
  el.remove()
  return out
}

/** 상단바(--toolbar-h) + safe-area — 버튼이 문서 바 아래로 못 올라가게 한다 (C-3) */
function topLimit(): number {
  const h = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--toolbar-h')) || 52
  return h + safeInset().top
}

/**
 * 빠른 도구 전환 버튼 (FR-IN-07). Pencil 더블탭/스퀴즈는 웹에 전달되지 않으므로 화면 버튼으로 대신한다.
 * 탭: 펜 ↔ 지우개 / 길게 끌기: 위치 이동.
 * 기본 위치는 왼쪽 아래 — 노트 모드 페이지 사이드바(왼쪽 위)와 겹치지 않는다 (C-3).
 */
export function QuickSwitch() {
  const tool = useUI((s) => s.tool)
  const toggle = useUI((s) => s.toggleQuick)
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_POS) || '') as { x: number; y: number }
    } catch {
      return { x: 16, y: window.innerHeight - SIZE - 24 - safeInset().bottom }
    }
  })
  const drag = useRef<{ id: number; dx: number; dy: number; moved: boolean; sx: number; sy: number } | null>(null)

  const clamp = (x: number, y: number) => ({
    x: Math.max(4, Math.min(window.innerWidth - SIZE - 8, x)),
    y: Math.max(topLimit() + 8, Math.min(window.innerHeight - SIZE - 8 - safeInset().bottom, y))
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
