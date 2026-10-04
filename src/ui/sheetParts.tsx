import { Component, useEffect, useLayoutEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

/** 시트에서 난 오류가 화면 전체를 지우지 않도록 막는다 */
export class SheetErrorBoundary extends Component<{ children: ReactNode; onClose: () => void }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[sheet] 렌더 오류', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && this.props.onClose()}>
          <div className="store-sheet" role="alertdialog" aria-label="오류">
            <SheetEmpty
              icon="alert"
              title="화면을 표시하지 못했습니다"
              desc={this.state.error.message}
              action={
                <button className="primary-btn" onClick={this.props.onClose}>
                  닫기
                </button>
              }
            />
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

/** 온라인/오프라인 상태 (online·offline 이벤트 구독) */
export function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(navigator.onLine)
    window.addEventListener('online', on)
    window.addEventListener('offline', on)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', on)
    }
  }, [])
  return online
}

/** 시트 헤더 — 40px 아이콘, 제목, 부제(● Google Drive · 경로 / ● 오프라인), 오른쪽 동작·닫기 */
export function SheetHeader({
  icon,
  title,
  subtitle,
  offline,
  action,
  onClose
}: {
  icon: string
  title: string
  subtitle: string
  offline: boolean
  action?: ReactNode
  onClose: () => void
}) {
  return (
    <header className="store-head">
      <span className="store-head-icon">
        <Icon name={icon} size={22} />
      </span>
      <div className="store-head-text">
        <h2>{title}</h2>
        <p className={'store-sub' + (offline ? ' off' : '')}>
          <span className="dot" />
          {offline ? '오프라인' : subtitle}
        </p>
      </div>
      <div className="store-head-actions">
        {action}
        <button className="tb-btn" onClick={onClose} aria-label="닫기">
          <Icon name="close" />
        </button>
      </div>
    </header>
  )
}

/** 조건부 배너 (오프라인 / 확인 필요) */
export function SheetBanner({ tone, children, actions }: { tone: 'offline' | 'warn'; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className={'store-banner ' + tone} role="status">
      <Icon name={tone === 'offline' ? 'wifiOff' : 'alert'} size={18} />
      <div className="store-banner-body">{children}</div>
      {actions && <div className="store-banner-actions">{actions}</div>}
    </div>
  )
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <span className="store-search">
      <Icon name="search" size={16} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {value && (
        <button type="button" className="store-clear" onClick={() => onChange('')} aria-label="검색 지우기">
          <Icon name="close" size={13} />
        </button>
      )}
    </span>
  )
}

export type Tab<T extends string> = { key: T; label: string; count: number; warn?: boolean }

export function FilterTabs<T extends string>({ tabs, value, onChange }: { tabs: Tab<T>[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="store-tabs" role="group" aria-label="상태 필터">
      {tabs.map((t) => {
        const on = value === t.key
        return (
          <button
            key={t.key}
            type="button"
            className={'store-tab' + (on ? ' is-active' : '') + (t.warn ? ' warn' : '')}
            aria-pressed={on}
            onClick={() => onChange(t.key)}
          >
            {t.label}
            <b>{t.count}</b>
          </button>
        )
      })}
    </div>
  )
}

/** ⋯ 팝오버 — 버튼 옆에 떠서 목록을 밀지 않는다. 아래 공간이 없으면 위로 연다 */
export function Popover({ anchor, onClose, children }: { anchor: DOMRect | null; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!anchor || !el) {
      setPos(null)
      return
    }
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = Math.min(Math.max(8, anchor.right - w), window.innerWidth - w - 8)
    let top = anchor.bottom + 6
    if (top + h > window.innerHeight - 8) top = Math.max(8, anchor.top - h - 6)
    setPos({ top, left })
  }, [anchor])
  useEffect(() => {
    const onDoc = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      // ⋯ 버튼 자체를 누른 경우는 버튼의 onClick 토글이 처리하게 둔다
      if (t?.closest?.('[data-pop-anchor]')) return
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const t = window.setTimeout(() => document.addEventListener('pointerdown', onDoc), 0)
    const onScroll = () => onClose()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('pointerdown', onDoc)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  if (!anchor) return null
  return createPortal(
    <div ref={ref} className="store-pop" style={pos ?? { top: -9999, left: -9999 }} role="menu">
      {children}
    </div>,
    document.body
  )
}

export function MenuTitle({ children }: { children: ReactNode }) {
  return <div className="store-pop-title">{children}</div>
}

export function MenuSep() {
  return <div className="store-pop-sep" />
}

export function MenuItem({
  icon,
  label,
  desc,
  danger,
  disabled,
  onClick
}: {
  icon: string
  label: string
  desc?: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={'store-pop-item' + (danger ? ' danger' : '')} role="menuitem" disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={16} />
      <span className="store-pop-text">
        <b>{label}</b>
        {desc && <small>{desc}</small>}
      </span>
    </button>
  )
}

export function SheetEmpty({ icon, title, desc, action }: { icon: string; title: string; desc?: string; action?: ReactNode }) {
  return (
    <div className="store-empty">
      <span className="store-empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      {desc && <p>{desc}</p>}
      {action}
    </div>
  )
}
