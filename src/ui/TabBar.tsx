// 크롬처럼 위에 뜨는 탭 — 맨 앞은 홈(라이브러리·작업보드), 그 뒤로 연 노트·앱·파일. 오른쪽 끝은 상태 칸(dock/StatusDock).
// 탭 목록·옆 칸은 store(tabs·split)가 갖고 이 기기에만 기억한다. 열린 것이 없어도 바(홈 탭)는 늘 그린다.
// 탭은 끌어서 순서를 바꾼다 — 마우스·펜은 바로 끌고, 손가락은 길게 눌러 집는다(그냥 밀면 탭 바가 옆으로 넘어간다).
// 끌던 탭을 탭 바 아래로 내려 화면 왼쪽·오른쪽 끝에 놓으면 그쪽 옆 칸(듀얼)에 연다.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isHomeRoute, isTabRoute, routeKey, useUI, type TabRoute } from '../app/store'
import { getDocument } from '../storage/repo'
import { APPS_EVENT, getApp } from '../sync/apps'
import { FILES_EVENT, getFile } from '../sync/files'
import { Icon } from './Icon'
import { Menu, MenuItem } from './Menu'
import { StatusDock } from './dock/StatusDock'

const ICON: Record<TabRoute['name'], string> = { editor: 'notebook', app: 'app', file: 'file' }

/** 손가락으로 탭을 집는 길게 누르기 시간 */
const TOUCH_HOLD_MS = 350
/** 마우스·펜이 이만큼 움직이면 끌기 (그 전에 떼면 누르기) */
const DRAG_START_PX = 6
/** 길게 누르는 동안 이만큼 움직이면 끌기가 아니라 탭 바 넘기기 */
const TOUCH_SLOP_PX = 8
/** 끌면서 탭 바 끝에 가까이 가면 바를 민다 */
const EDGE_PX = 28
/** 탭 바 아래로 이만큼 내려가면 탭을 바에서 떼어 화면 위로 끈다 (옆 칸에 놓기) */
const DETACH_PX = 28
/** 화면 끝 놓는 자리의 폭 — 칸 폭의 이 비율, 최대 EDGE_ZONE_MAX */
const EDGE_ZONE_FRAC = 0.22
const EDGE_ZONE_MAX = 180

type Side = 'left' | 'right'
/** 탭 바 밖으로 끄는 중 — 손가락 자리와 놓을 쪽 */
interface Out {
  x: number
  y: number
  zone: Side | null
}
/** 칸 영역(.panes)에서 화면 끝 놓는 자리 */
function edgeZone(x: number, y: number): Side | null {
  const r = document.querySelector('.panes')?.getBoundingClientRect()
  if (!r || y < r.top || y > r.bottom) return null
  const w = Math.min(EDGE_ZONE_MAX, r.width * EDGE_ZONE_FRAC)
  return x < r.left + w ? 'left' : x > r.right - w ? 'right' : null
}
function panesRect() {
  return document.querySelector('.panes')?.getBoundingClientRect() ?? null
}

interface Drag {
  key: string
  tab: TabRoute
  id: number
  touch: boolean
  x0: number
  y0: number
  /** 집은 자리 — 탭 왼쪽에서 손가락까지 (탭 바 내용 좌표) */
  grab: number
  on: boolean
  timer: number
  lastX: number
  lastY: number
  /** 탭 바 밖(칸 위)으로 끌고 있다 */
  out: boolean
}

/** 문서(text 모드) 탭 — 아이콘만 다르다 */
const textTabs = new Set<string>()

/** 탭 제목 — 없으면(지워졌으면) null */
async function titleOf(t: TabRoute): Promise<string | null> {
  if (t.name === 'editor') {
    const d = await getDocument(t.docId)
    if (d?.mode === 'text') textTabs.add(routeKey(t))
    else textTabs.delete(routeKey(t))
    return d && !d.deletedAt ? d.title || '제목 없음' : null
  }
  if (t.name === 'app') {
    const a = await getApp(t.appId)
    return a && !a.deletedAt ? a.title : null
  }
  const f = await getFile(t.fileId)
  return f && !f.deletedAt ? f.title : null
}

/** 옆 칸(듀얼)을 쓸 수 있는 폭 — 좁으면 칸을 숨기고(기억은 한다) 옆에 띄우기 버튼도 내지 않는다 */
export const SPLIT_QUERY = '(min-width: 760px)'
export function useSplitAllowed() {
  const [ok, setOk] = useState(() => window.matchMedia(SPLIT_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(SPLIT_QUERY)
    const on = () => setOk(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return ok
}

export function TabBar() {
  const tabs = useUI((s) => s.tabs)
  const route = useUI((s) => s.route)
  const split = useUI((s) => s.split)
  const home = useUI((s) => s.home)
  const saveState = useUI((s) => s.saveState)
  const navigate = useUI((s) => s.navigate)
  const closeTab = useUI((s) => s.closeTab)
  const closeOtherTabs = useUI((s) => s.closeOtherTabs)
  const openSplit = useUI((s) => s.openSplit)
  const closeSplit = useUI((s) => s.closeSplit)
  const swapSplit = useUI((s) => s.swapSplit)
  const splitAllowed = useSplitAllowed()
  const [titles, setTitles] = useState<Map<string, string>>(new Map())
  const [menu, setMenu] = useState<{ tab: TabRoute; x: number; y: number } | null>(null)
  const bar = useRef<HTMLDivElement>(null)
  const moveTab = useUI((s) => s.moveTab)
  const drag = useRef<Drag | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [out, setOut] = useState<Out | null>(null)
  /** 끌기를 마친 뒤 따라오는 click은 탭 열기가 아니다 */
  const swallowClick = useRef(false)
  /** 자리를 바꾸기 전 다른 탭들의 자리 — 바뀐 뒤 미끄러지듯 옮긴다 */
  const before = useRef<Map<string, number> | null>(null)

  // 제목은 DB에서 읽는다 — 화면을 옮기거나 저장이 끝나거나 앱·파일이 바뀔 때 다시 읽는다.
  // 지워진 항목의 탭은 닫는다 (보고 있는 탭은 그 화면이 '찾을 수 없음'을 보여 주므로 둔다)
  useEffect(() => {
    let alive = true
    const load = async () => {
      const next = new Map<string, string>()
      const gone: TabRoute[] = []
      for (const t of useUI.getState().tabs) {
        const title = await titleOf(t)
        if (title === null) gone.push(t)
        else next.set(routeKey(t), title)
      }
      if (!alive) return
      setTitles(next)
      const cur = useUI.getState().route
      for (const t of gone) if (!isTabRoute(cur) || routeKey(cur) !== routeKey(t)) closeTab(t)
    }
    void load()
    window.addEventListener(APPS_EVENT, load)
    window.addEventListener(FILES_EVENT, load)
    return () => {
      alive = false
      window.removeEventListener(APPS_EVENT, load)
      window.removeEventListener(FILES_EVENT, load)
    }
  }, [tabs, route, saveState, closeTab])

  // 보는 탭이 바 밖에 있으면 보이게 민다 (끄는 동안은 끄는 쪽이 바를 민다)
  useEffect(() => {
    if (drag.current?.on) return
    bar.current?.querySelector('.tab.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [route, tabs])

  // ── 끌어서 순서 바꾸기 ──
  const tabEl = (key: string) => bar.current?.querySelector<HTMLElement>(`.tab[data-tab="${CSS.escape(key)}"]`) ?? null
  /** 화면 x → 탭 바 내용 좌표 (탭의 offsetLeft와 같은 기준) */
  const contentX = (clientX: number) => {
    const el = bar.current!
    return clientX - el.getBoundingClientRect().left + el.scrollLeft
  }
  /** 끄는 탭을 손가락 아래에 둔다 */
  const place = () => {
    const d = drag.current
    const el = d && tabEl(d.key)
    if (!d || !el) return
    if (d.out) {
      el.style.transform = ''
      return
    }
    el.style.transform = `translateX(${contentX(d.lastX) - d.grab - el.offsetLeft}px)`
  }
  /** 끄는 탭의 가운데가 이웃 탭의 가운데를 넘으면 자리를 바꾼다 */
  const reorder = () => {
    const d = drag.current
    const el = d && tabEl(d.key)
    if (!d || !el || !bar.current) return
    const others = [...bar.current.querySelectorAll<HTMLElement>('.tab[data-tab]')].filter((e) => e.dataset.tab !== d.key)
    const center = contentX(d.lastX) - d.grab + el.offsetWidth / 2
    const to = others.filter((e) => e.offsetLeft + e.offsetWidth / 2 < center).length
    const tabsNow = useUI.getState().tabs
    if (tabsNow.findIndex((t) => routeKey(t) === d.key) === to) return
    before.current = new Map(others.map((e) => [e.dataset.tab!, e.offsetLeft]))
    moveTab(d.tab, to)
  }
  // 자리를 바꾼 뒤: 비켜 난 탭은 원래 자리에서 미끄러져 오고, 끄는 탭은 손가락 아래 그대로
  useLayoutEffect(() => {
    const old = before.current
    if (!old) return
    before.current = null
    for (const [key, x] of old) {
      const el = tabEl(key)
      const dx = el ? x - el.offsetLeft : 0
      if (el && dx) el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 160, easing: 'ease-out' })
    }
    place()
  }, [tabs])

  const startDrag = () => {
    const d = drag.current
    if (!d) return
    d.on = true
    setDragKey(d.key)
    place()
  }
  const endDrag = (cancelled: boolean) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    clearTimeout(d.timer)
    if (!d.on) return
    swallowClick.current = !cancelled
    setDragKey(null)
    setOut(null)
    if (d.out) {
      // 화면 끝에 놓았다 — 그쪽 옆 칸에 연다 (노트는 옆 칸에 열 수 없다)
      const zone = cancelled ? null : edgeZone(d.lastX, d.lastY)
      if (zone && d.tab.name !== 'editor') openSplit(d.tab, zone)
      return
    }
    const el = tabEl(d.key)
    if (!el) return
    // 손을 떼면 제자리로 미끄러져 들어간다
    const from = el.style.transform
    el.style.transform = ''
    if (from) el.animate([{ transform: from }, { transform: 'none' }], { duration: 140, easing: 'ease-out' })
  }
  const onTabPointerDown = (e: React.PointerEvent<HTMLElement>, t: TabRoute) => {
    swallowClick.current = false
    if (e.button !== 0 || (e.target as HTMLElement).closest('.tab-close') || drag.current) return
    const el = e.currentTarget
    const touch = e.pointerType === 'touch'
    const d: Drag = { key: routeKey(t), tab: t, id: e.pointerId, touch, x0: e.clientX, y0: e.clientY, grab: contentX(e.clientX) - el.offsetLeft, on: false, timer: 0, lastX: e.clientX, lastY: e.clientY, out: false }
    drag.current = d
    if (touch) d.timer = window.setTimeout(startDrag, TOUCH_HOLD_MS)
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // 합성 이벤트 등 — 잡지 못해도 탭 위에서는 이어 받는다
    }
  }
  const onTabPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    d.lastX = e.clientX
    d.lastY = e.clientY
    if (!d.on) {
      const dist = Math.hypot(e.clientX - d.x0, e.clientY - d.y0)
      if (d.touch) {
        if (dist > TOUCH_SLOP_PX) endDrag(true) // 길게 누르기 전에 밀었다 — 탭 바 넘기기
        return
      }
      if (Math.abs(e.clientX - d.x0) < DRAG_START_PX) return
      startDrag()
    }
    const b = bar.current!
    const r = b.getBoundingClientRect()
    // 탭 바 아래로 내리면 떼어 낸다 — 화면 끝에 놓으면 옆 칸. 다시 바로 올리면 순서 바꾸기로 돌아온다
    const wasOut = d.out
    d.out = splitAllowed && e.clientY > r.bottom + DETACH_PX
    if (d.out) {
      if (!wasOut) place()
      setOut({ x: e.clientX, y: e.clientY, zone: edgeZone(e.clientX, e.clientY) })
      return
    }
    if (wasOut) setOut(null)
    if (e.clientX < r.left + EDGE_PX) b.scrollLeft -= 10
    else if (e.clientX > r.right - EDGE_PX) b.scrollLeft += 10
    place()
    reorder()
  }
  const onTabPointerEnd = (e: React.PointerEvent<HTMLElement>) => {
    if (drag.current?.id === e.pointerId) endDrag(e.type === 'pointercancel')
  }
  // 손가락으로 끄는 동안은 탭 바가 넘어가지 않게 (touch-action은 누른 뒤에 바꿀 수 없다)
  useEffect(() => {
    const el = bar.current
    if (!el) return
    const block = (e: TouchEvent) => drag.current?.on && e.preventDefault()
    el.addEventListener('touchmove', block, { passive: false })
    return () => el.removeEventListener('touchmove', block)
  }, [])
  /** 단축키 — 탭에서 ⌘/Ctrl+Shift+←/→ */
  const moveByKey = (e: React.KeyboardEvent, t: TabRoute) => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return false
    e.preventDefault()
    const i = tabs.findIndex((x) => routeKey(x) === routeKey(t))
    moveTab(t, i + (e.key === 'ArrowLeft' ? -1 : 1))
    requestAnimationFrame(() => tabEl(routeKey(t))?.focus()) // 자리를 옮기면 DOM이 다시 끼워져 포커스가 빠질 수 있다
    return true
  }

  const activeKey = isTabRoute(route) ? routeKey(route) : null
  const splitKey = split ? routeKey(split) : null
  const homeActive = isHomeRoute(route)
  const homeName = home.name === 'board' ? '작업보드' : home.name === 'plan' ? '일정' : '라이브러리'

  return (
    <nav className="tabbar" aria-label="열린 탭">
      <button
        className={'tab tab-home' + (homeActive ? ' is-active' : '')}
        onClick={() => navigate(homeActive ? route : home)}
        aria-label={homeName}
        title={homeName}
      >
        <Icon name={home.name === 'board' ? 'board' : home.name === 'plan' ? 'calendar' : 'grid'} size={18} />
      </button>
      <div className="tabbar-scroll" ref={bar} role="tablist">
        {tabs.map((t) => {
          const key = routeKey(t)
          const side = key === splitKey && splitAllowed
          const title = titles.get(key) ?? ''
          return (
            <div
              key={key}
              role="tab"
              aria-selected={key === activeKey}
              tabIndex={0}
              className={'tab' + (key === activeKey ? ' is-active' : '') + (side ? ' is-side' : '') + (key === dragKey ? ' is-dragging' : '')}
              title={title}
              data-tab={key}
              onClick={() => {
                if (swallowClick.current) swallowClick.current = false
                else navigate(t)
              }}
              onPointerDown={(e) => onTabPointerDown(e, t)}
              onPointerMove={onTabPointerMove}
              onPointerUp={onTabPointerEnd}
              onPointerCancel={onTabPointerEnd}
              onKeyDown={(e) => moveByKey(e, t) || ((e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), navigate(t)))}
              onContextMenu={(e) => {
                e.preventDefault()
                if (drag.current) return // 손가락으로 길게 눌러 집는 중 — 메뉴 대신 끌기
                setMenu({ tab: t, x: e.clientX + 220, y: e.clientY })
              }}
              // 가운데 버튼으로 닫기 (크롬처럼)
              onAuxClick={(e) => e.button === 1 && closeTab(t)}
            >
              <Icon name={textTabs.has(key) ? 'textDoc' : ICON[t.name]} size={15} />
              <span className="tab-title">{title}</span>
              {side && <Icon name="sidebar" size={13} className="tab-side" />}
              <button
                className="tab-close"
                aria-label={`${title} 탭 닫기`}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t)
                }}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          )
        })}
      </div>
      <StatusDock />
      {out && dragKey && <EdgeDrop out={out} title={titles.get(dragKey) ?? ''} note={dragKey.startsWith('doc:')} />}

      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menu.tab.name !== 'editor' && splitAllowed && routeKey(menu.tab) !== splitKey && (
            <MenuItem
              icon="sidebar"
              label="옆 칸에 열기"
              onClick={() => {
                if (menu.tab.name !== 'editor') openSplit(menu.tab)
                setMenu(null)
              }}
            />
          )}
          {routeKey(menu.tab) === splitKey && splitAllowed && (
            <MenuItem
              icon="swap"
              label="좌우 바꾸기"
              onClick={() => {
                swapSplit()
                setMenu(null)
              }}
            />
          )}
          {routeKey(menu.tab) === splitKey && (
            <MenuItem
              icon="close"
              label="옆 칸 닫기"
              onClick={() => {
                closeSplit()
                setMenu(null)
              }}
            />
          )}
          <MenuItem
            icon="close"
            label="탭 닫기"
            onClick={() => {
              closeTab(menu.tab)
              setMenu(null)
            }}
          />
          {tabs.length > 1 && (
            <MenuItem
              icon="close"
              label="다른 탭 모두 닫기"
              onClick={() => {
                closeOtherTabs(menu.tab)
                setMenu(null)
              }}
            />
          )}
        </Menu>
      )}
    </nav>
  )
}

/** 탭을 떼어 끄는 동안 — 손가락을 따라오는 탭과 화면 왼쪽·오른쪽 끝의 놓는 자리 */
function EdgeDrop({ out, title, note }: { out: Out; title: string; note: boolean }) {
  const r = panesRect()
  if (!r) return null
  const w = Math.min(EDGE_ZONE_MAX, r.width * EDGE_ZONE_FRAC)
  const zone = (side: Side) => (
    <div
      className={'edge-drop' + (out.zone === side ? ' is-on' : '') + (note ? ' is-no' : '')}
      style={{ left: side === 'left' ? r.left : r.right - w, top: r.top, width: w, height: r.height }}
    >
      <span className="edge-drop-label">
        <Icon name={note ? 'close' : 'sidebar'} size={18} />
        {note ? '노트는 옆 칸에 열 수 없어요' : side === 'left' ? '왼쪽 칸에 열기' : '오른쪽 칸에 열기'}
      </span>
    </div>
  )
  return createPortal(
    <>
      {zone('left')}
      {zone('right')}
      <div className="tab-ghost" style={{ left: out.x, top: out.y }}>
        {title}
      </div>
    </>,
    document.body
  )
}
