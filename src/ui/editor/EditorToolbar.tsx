import { useEffect, useState, type MouseEvent } from 'react'
import type { Engine } from '../../engine/engine'
import { useUI } from '../../app/store'
import type { DocumentMeta } from '../../shared/model'
import { onSyncStatus } from '../../sync/sync'
import { Icon } from '../Icon'
import { Menu, MenuItem } from '../library/Library'

const SAVE_LABEL = { saved: '저장됨', pending: '저장 대기', saving: '저장 중', error: '저장 실패' }

/**
 * 편집 화면 상단 문서 바. 도구(펜·형광펜·지우개·올가미·색·굵기·되돌리기·전체 보기)는 FloatingToolbar로 분리됐다.
 * 필기 중 시선을 빼지 않도록 자주 쓰는 페이지·배경 설정 버튼만 남기고,
 * 버전 기록·내보내기·설정·동기화는 ⋯ 메뉴로 모았다 (C-1).
 * 저장 상태와 동기화 상태를 한 줄로 합쳤다 — "저장됨"은 1.5초 뒤 아이콘만 흐리게 남는다.
 */
export function EditorToolbar(props: {
  engine: Engine | null
  doc: DocumentMeta | null
  readOnly: boolean
  onRename: (t: string) => void
  onBack: () => void
}) {
  const { doc } = props
  const panel = useUI((s) => s.panel)
  const setPanel = useUI((s) => s.setPanel)
  const sidebar = useUI((s) => s.sidebar)
  const setSidebar = useUI((s) => s.setSidebar)
  const saveState = useUI((s) => s.saveState)
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [savedQuiet, setSavedQuiet] = useState(false)

  useEffect(() => setTitle(doc?.title ?? ''), [doc?.title])

  // "저장됨"은 잠깐 보였다가 조용해진다. 저장 대기·저장 중·실패는 계속 보인다 (C-1)
  useEffect(() => {
    if (saveState !== 'saved') {
      setSavedQuiet(false)
      return
    }
    const t = setTimeout(() => setSavedQuiet(true), 1500)
    return () => clearTimeout(t)
  }, [saveState])

  useEffect(() => onSyncStatus((s) => setSyncing(s === 'syncing')), [])

  const openMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setMenu((m) => (m ? null : { x: r.right, y: r.bottom }))
  }
  const run = (fn: () => void) => () => {
    setMenu(null)
    fn()
  }

  return (
    <header id="editor-toolbar" className="toolbar-stack">
      {/* ── 1단: 문서 바 ── */}
      <div className="toolbar toolbar-doc">
        <nav className="toolbar-group" aria-label="탐색">
          <button className="tb-btn" onClick={props.onBack} aria-label="문서 목록">
            <Icon name="back" size={20} />
          </button>
          {doc?.mode === 'paged' && (
            <button
              className={'tb-btn' + (sidebar ? ' is-active' : '')}
              onClick={() => setSidebar(!sidebar)}
              aria-label="페이지 목록"
              aria-pressed={sidebar}
            >
              <Icon name="sidebar" size={20} />
            </button>
          )}
          {editingTitle ? (
            <input
              className="title-input"
              value={title}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                setEditingTitle(false)
                props.onRename(title)
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <button className="doc-title-btn" onClick={() => !props.readOnly && setEditingTitle(true)} title="이름 바꾸기">
              <span className="doc-title-text">{doc?.title ?? ''}</span>
              {!props.readOnly && <Icon name="edit" size={14} className="doc-title-edit" />}
            </button>
          )}
        </nav>

        <div className="toolbar-spacer" />

        {saveState === 'error' ? (
          <button className="save-state error" onClick={() => setPanel('sync')} aria-label="저장 실패 — 눌러서 동기화 패널 열기">
            <Icon name="alert" size={14} />
            <span className="save-label">{SAVE_LABEL.error}</span>
          </button>
        ) : syncing ? (
          <span className="save-state syncing" aria-label="동기화 중">
            <Icon name="cloud" size={14} />
            <span className="save-label">동기화 중</span>
          </span>
        ) : (
          <span className={'save-state ' + saveState + (savedQuiet ? ' is-quiet' : '')} aria-label={SAVE_LABEL[saveState]}>
            <Icon name="check" size={14} />
            <span className="save-label">{SAVE_LABEL[saveState]}</span>
          </span>
        )}

        <nav className="toolbar-group" aria-label="문서">
          {doc?.mode === 'paged' && (
            <button className={'tb-btn' + (panel === 'page' ? ' is-active' : '')} onClick={() => setPanel('page')} aria-label="페이지 설정">
              <Icon name="page" size={20} />
            </button>
          )}
          {doc?.mode === 'infinite' && (
            <button className={'tb-btn' + (panel === 'page' ? ' is-active' : '')} onClick={() => setPanel('page')} aria-label="배경 설정">
              <Icon name="grid" size={20} />
            </button>
          )}
          <button className={'tb-btn' + (menu ? ' is-active' : '')} onClick={openMenu} aria-label="더보기" aria-haspopup="menu" aria-expanded={!!menu}>
            <Icon name="more" size={20} />
          </button>
        </nav>
      </div>

      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem icon="restore" label="버전 기록" onClick={run(() => setPanel('history'))} />
          <MenuItem icon="share" label="내보내기" onClick={run(() => setPanel('export'))} />
          <MenuItem icon="gear" label="설정" onClick={run(() => setPanel('settings'))} />
          <MenuItem icon="cloud" label="동기화" onClick={run(() => setPanel('sync'))} />
        </Menu>
      )}
    </header>
  )
}
