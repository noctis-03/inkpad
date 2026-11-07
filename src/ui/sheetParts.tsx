import { Component, useEffect, useLayoutEffect, useRef, useState, type ErrorInfo, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { EASE, dur } from './motion/motion'

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

/**
 * 창 높이가 바뀔 때(목록을 다시 읽음·검색·필터·접기 등) 뚝 바뀌지 않고 늘거나 줄게 한다 — 모든 시트·작은 창 공용.
 * body(스크롤 칸이나 내용 감싸개)의 자식들을 지켜보다 크기가 바뀌거나 자식이 바뀌면,
 * 바뀌기 전 높이에서 새 높이로 창(sheet)의 height를 애니메이션한다. 모션을 끄면 바로 바뀐다.
 * body의 자식은 내용 크기를 그대로 가져야 한다(flex로 늘어나는 칸이면 애니메이션 중 크기가 따라 바뀌어 되먹임이 생긴다)
 */
export function useSheetHeightMotion(sheet: RefObject<HTMLElement | null>, body: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = sheet.current
    const box = body.current
    if (!el || !box || typeof ResizeObserver === 'undefined') return
    // offsetHeight — 등장 애니메이션의 scale(transform)에 흔들리지 않는 레이아웃 높이
    let last = el.offsetHeight
    let anim: Animation | null = null
    const check = () => {
      const from = anim ? el.offsetHeight : last
      anim?.cancel()
      anim = null
      const to = el.offsetHeight
      last = to
      const ms = dur(280)
      if (!ms || Math.abs(to - from) < 2) return
      anim = el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: ms, easing: EASE })
      anim.onfinish = () => (anim = null)
    }
    const ro = new ResizeObserver(check)
    const watch = () => {
      ro.disconnect()
      for (const c of Array.from(box.children)) ro.observe(c)
    }
    watch()
    // 자식이 통째로 바뀌는 경우(빈 상태 ↔ 목록 등)
    const mo = new MutationObserver(() => {
      watch()
      check()
    })
    mo.observe(box, { childList: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
      anim?.cancel()
    }
  }, [sheet, body])
}

/** 열린 모달·시트 — 나중에 열린 것이 맨 뒤 */
const dismissStack: symbol[] = []

/**
 * Esc로 닫기 — 모든 모달·시트가 같은 규칙으로 닫힌다.
 * 여러 겹이면 맨 위 하나만 닫고, 그 위에 확인창(.dialog-host)·⋯ 메뉴가 떠 있으면 그쪽이 먼저 닫히게 둔다.
 * 입력칸이 Esc를 따로 쓰면(이름 고치기 취소 등) preventDefault로 알린다.
 */
export function useEscClose(onClose: () => void, enabled = true) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!enabled) return
    const me = Symbol()
    dismissStack.push(me)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || dismissStack[dismissStack.length - 1] !== me) return
      if (document.querySelector('.dialog-host, .menu, .store-pop')) return
      e.preventDefault()
      close.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      dismissStack.splice(dismissStack.indexOf(me), 1)
    }
  }, [enabled])
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

/**
 * 시트 헤더(C 스타일) — 큰 제목, 부제(● Google Drive · 경로 / ● 오프라인), 오른쪽 동작·원형 닫기.
 * icon은 예전 머리 아이콘 칸용 — 지금은 그리지 않는다(호출부 호환을 위해 받기만 한다)
 */
export function SheetHeader({
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
      <div className="store-head-text">
        <h2>{title}</h2>
        <p className={'store-sub' + (offline ? ' off' : '')}>
          <span className="dot" />
          {offline ? '오프라인' : subtitle}
        </p>
      </div>
      <div className="store-head-actions">
        {action}
        <button className="sheet-close" onClick={onClose} aria-label="닫기">
          <Icon name="close" size={16} />
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

/** ⋯ 팝오버 — 버튼 옆에 떠서 목록을 밀지 않는다. 아래 공간이 없으면 위로 연다. align: 버튼의 오른쪽 끝(기본)·왼쪽 끝에 맞춘다 */
export function Popover({
  anchor,
  onClose,
  children,
  className,
  align = 'end'
}: {
  anchor: DOMRect | null
  onClose: () => void
  children: ReactNode
  className?: string
  align?: 'start' | 'end'
}) {
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
    const left = Math.min(Math.max(8, align === 'start' ? anchor.left : anchor.right - w), window.innerWidth - w - 8)
    let top = anchor.bottom + 6
    if (top + h > window.innerHeight - 8) top = Math.max(8, anchor.top - h - 6)
    setPos({ top, left })
  }, [anchor, align])
  useEffect(() => {
    const onDoc = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      // ⋯ 버튼 자체를 누른 경우는 버튼의 onClick 토글이 처리하게 둔다
      if (t?.closest?.('[data-pop-anchor]')) return
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const t = window.setTimeout(() => document.addEventListener('pointerdown', onDoc), 0)
    // 팝오버 안의 목록을 스크롤할 때는 닫지 않는다 — 바깥(시트·페이지)이 스크롤될 때만
    const onScroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return
      onClose()
    }
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
    <div ref={ref} className={'store-pop' + (className ? ' ' + className : '')} style={pos ?? { top: -9999, left: -9999 }} role="menu">
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
