// 작은 떠 있는 메뉴 — 라이브러리 카드·폴더, 편집 화면 문서 바·페이지 사이드바·툴바가 함께 쓴다.
// x·y가 둘 다 0이면 화면 가운데에 띄운다.
import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

export function Menu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const centered = x === 0 && y === 0
  // 오른쪽 끝을 누른 버튼(x)에 맞춰 아래(y)로 펼친다. 실제 크기를 재서 화면 밖으로 나가면 안으로 민다 —
  // 맨 아랫줄 카드의 메뉴는 아래가 모자라면 위로 올라온다. 그리기 전에 자리를 잡아 깜빡이지 않는다
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || centered) return
    const { width, height } = el.getBoundingClientRect()
    el.style.top = `${Math.max(8, Math.min(y + 4, window.innerHeight - height - 8))}px`
    el.style.left = `${Math.max(8, Math.min(x - width, window.innerWidth - width - 8))}px`
  }, [x, y, centered])
  // Esc로 닫고, 열리면 메뉴로 포커스를 옮겨 Tab·Enter로 항목을 누를 수 있다
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // body에 그린다 — 자리를 화면 좌표(버튼의 getBoundingClientRect)로 잡으므로, 조상에 transform이 있어
  // position:fixed의 기준이 바뀌거나 칸(.pane)의 overflow에 잘리면 엉뚱한 곳에 뜬다 (탭 바·듀얼 칸)
  return createPortal(
    <div className="menu-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} className={'menu' + (centered ? ' centered' : '')} role="menu">
        {children}
      </div>
    </div>,
    document.body
  )
}

export function MenuItem({ icon, label, onClick, danger, current, className }: { icon: string; label: string; onClick: () => void; danger?: boolean; current?: boolean; className?: string }) {
  return (
    <button
      className={'menu-item' + (danger ? ' danger' : '') + (current ? ' is-current' : '') + (className ? ' ' + className : '')}
      role={current === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={current}
      onClick={onClick}
    >
      <Icon name={icon} size={16} /> {label}
    </button>
  )
}
