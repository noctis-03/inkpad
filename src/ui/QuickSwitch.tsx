import { useLayoutEffect, useRef, useState } from 'react'
import { useUI } from '../app/store'
import { Icon } from './Icon'

// v2: 필기 영역 기준 좌표 — v1은 창 좌표로 계산해 영역에 놓아 상단바 높이만큼 아래로 밀렸다
const LS_POS = 'inkpad.quickpos.v2'
const SIZE = 56

/** env(safe-area-inset-*)는 CSS env()에서만 읽히므로 숨은 탐침 요소로 재 산출한다 */
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

/**
 * 빠른 도구 전환 버튼. Pencil 더블탭/스퀴즈는 웹에 전달되지 않으므로 화면 버튼으로 대신한다.
 * 탭: 펜 ↔ 지우개 / 길게 끌기: 위치 이동.
 * 자리는 필기 영역(.editor-area) 기준 좌표 — 기본은 그 왼쪽 아래(페이지 사이드바·상단바를 가리지 않는다).
 * 영역 크기가 바뀌면(회전·사이드바) 영역 안으로 다시 맞춘다.
 */
export function QuickSwitch() {
  const tool = useUI((s) => s.tool)
  const toggle = useUI((s) => s.toggleQuick)
  const btn = useRef<HTMLButtonElement>(null)
  /** 필기 영역 크기 — 처음 그리기 전에는 모른다(0) */
  const [area, setArea] = useState({ w: 0, h: 0 })
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_POS) || '') as { x: number; y: number }
    } catch {
      return null // 기본 자리 — 영역 크기를 안 뒤에 왼쪽 아래로
    }
  })
  useLayoutEffect(() => {
    const el = btn.current?.parentElement
    if (!el) return
    const read = () => setArea({ w: el.clientWidth, h: el.clientHeight })
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const drag = useRef<{ id: number; dx: number; dy: number; moved: boolean; sx: number; sy: number } | null>(null)

  const clamp = (x: number, y: number) => ({
    x: Math.max(4, Math.min(area.w - SIZE - 8, x)),
    y: Math.max(8, Math.min(area.h - SIZE - 8 - safeInset().bottom, y))
  })
  const p = clamp(pos?.x ?? 16, pos?.y ?? Infinity)

  return (
    <button
      ref={btn}
      id="quick-switch"
      className={'quick-switch' + (tool === 'eraser' ? ' is-eraser' : '')}
      style={{ left: p.x, top: p.y, visibility: area.w ? undefined : 'hidden' }}
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
