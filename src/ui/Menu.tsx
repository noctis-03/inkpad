// 작은 떠 있는 메뉴 — 라이브러리 카드·폴더, 편집 화면 문서 바·페이지 사이드바·툴바가 함께 쓴다.
// x·y가 둘 다 0이면 화면 가운데에 띄운다.
import { useEffect, useRef } from 'react'
import { Icon } from './Icon'

export function Menu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const centered = x === 0 && y === 0
  const style: React.CSSProperties = centered
    ? {}
    : { top: Math.min(y + 4, window.innerHeight - 280), left: Math.max(8, Math.min(x - 220, window.innerWidth - 232)) }
  // Esc로 닫고, 열리면 메뉴로 포커스를 옮겨 Tab·Enter로 항목을 누를 수 있다
  useEffect(() => {
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="menu-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} className={'menu' + (centered ? ' centered' : '')} style={style} role="menu">
        {children}
      </div>
    </div>
  )
}

export function MenuItem({ icon, label, onClick, danger }: { icon: string; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button className={'menu-item' + (danger ? ' danger' : '')} role="menuitem" onClick={onClick}>
      <Icon name={icon} size={18} /> {label}
    </button>
  )
}
