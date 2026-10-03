import { useEffect, useState } from 'react'
import type { Engine } from '../../engine/engine'
import { useUI } from '../../app/store'
import type { DocumentMeta } from '../../shared/model'
import { Icon } from '../Icon'

const SAVE_LABEL = { saved: '저장됨', pending: '저장 대기', saving: '저장 중', error: '저장 실패' }

/**
 * 편집 화면 상단 문서 바.
 * 1단 문서 바: 문서 정보와 문서 단위 액션 (제목·저장 상태·페이지·버전·내보내기·설정·동기화)
 * 도구(펜·형광펜·지우개·올가미·색·굵기·되돌리기·전체 보기)는 FloatingToolbar로 분리했다.
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

  useEffect(() => setTitle(doc?.title ?? ''), [doc?.title])

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

        <span className={'save-state ' + saveState} title={SAVE_LABEL[saveState]}>
          <Icon name={saveState === 'error' ? 'alert' : 'check'} size={14} />
          <span className="save-label">{SAVE_LABEL[saveState]}</span>
        </span>

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
          <button className={'tb-btn' + (panel === 'history' ? ' is-active' : '')} onClick={() => setPanel('history')} aria-label="버전 기록">
            <Icon name="restore" size={20} />
          </button>
          <button className={'tb-btn' + (panel === 'export' ? ' is-active' : '')} onClick={() => setPanel('export')} aria-label="내보내기">
            <Icon name="share" size={20} />
          </button>
          <button className={'tb-btn' + (panel === 'settings' ? ' is-active' : '')} onClick={() => setPanel('settings')} aria-label="설정">
            <Icon name="gear" size={20} />
          </button>
          <button className={'tb-btn sync-btn' + (panel === 'sync' ? ' is-active' : '')} onClick={() => setPanel('sync')} aria-label="동기화">
            <Icon name="cloud" size={20} />
          </button>
        </nav>
      </div>
    </header>
  )
}
