// 크롬처럼 위에 뜨는 탭 — 맨 앞은 홈(라이브러리·작업보드), 그 뒤로 연 노트·앱·파일.
// 탭 목록·오른쪽 칸은 store(tabs·split)가 갖고 이 기기에만 기억한다. 열린 것이 없으면 바를 그리지 않는다.
import { useEffect, useRef, useState } from 'react'
import { isTabRoute, routeKey, useUI, type TabRoute } from '../app/store'
import { getDocument } from '../storage/repo'
import { APPS_EVENT, getApp } from '../sync/apps'
import { FILES_EVENT, getFile } from '../sync/files'
import { Icon } from './Icon'
import { Menu, MenuItem } from './Menu'

const ICON: Record<TabRoute['name'], string> = { editor: 'notebook', app: 'app', file: 'file' }

/** 탭 제목 — 없으면(지워졌으면) null */
async function titleOf(t: TabRoute): Promise<string | null> {
  if (t.name === 'editor') {
    const d = await getDocument(t.docId)
    return d && !d.deletedAt ? d.title || '제목 없음' : null
  }
  if (t.name === 'app') {
    const a = await getApp(t.appId)
    return a && !a.deletedAt ? a.title : null
  }
  const f = await getFile(t.fileId)
  return f && !f.deletedAt ? f.title : null
}

/** 오른쪽 칸(듀얼)을 쓸 수 있는 폭 — 좁으면 칸을 숨기고(기억은 한다) 옆에 띄우기 버튼도 내지 않는다 */
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
  const splitAllowed = useSplitAllowed()
  const [titles, setTitles] = useState<Map<string, string>>(new Map())
  const [menu, setMenu] = useState<{ tab: TabRoute; x: number; y: number } | null>(null)
  const bar = useRef<HTMLDivElement>(null)

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

  // 보는 탭이 바 밖에 있으면 보이게 민다
  useEffect(() => {
    bar.current?.querySelector('.tab.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [route, tabs])

  if (!tabs.length) return null
  const activeKey = isTabRoute(route) ? routeKey(route) : null
  const splitKey = split ? routeKey(split) : null
  const homeActive = route.name === 'library' || route.name === 'board'

  return (
    <nav className="tabbar" aria-label="열린 탭">
      <button
        className={'tab tab-home' + (homeActive ? ' is-active' : '')}
        onClick={() => navigate(homeActive ? route : home)}
        aria-label={home.name === 'board' ? '작업보드' : '라이브러리'}
        title={home.name === 'board' ? '작업보드' : '라이브러리'}
      >
        <Icon name={home.name === 'board' ? 'board' : 'grid'} size={18} />
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
              className={'tab' + (key === activeKey ? ' is-active' : '') + (side ? ' is-side' : '')}
              title={title}
              data-tab={key}
              onClick={() => navigate(t)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), navigate(t))}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ tab: t, x: e.clientX + 220, y: e.clientY })
              }}
              // 가운데 버튼으로 닫기 (크롬처럼)
              onAuxClick={(e) => e.button === 1 && closeTab(t)}
            >
              <Icon name={ICON[t.name]} size={15} />
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

      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menu.tab.name !== 'editor' && splitAllowed && routeKey(menu.tab) !== splitKey && (
            <MenuItem
              icon="sidebar"
              label="오른쪽 칸에 열기"
              onClick={() => {
                if (menu.tab.name !== 'editor') openSplit(menu.tab)
                setMenu(null)
              }}
            />
          )}
          {routeKey(menu.tab) === splitKey && (
            <MenuItem
              icon="close"
              label="오른쪽 칸 닫기"
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
