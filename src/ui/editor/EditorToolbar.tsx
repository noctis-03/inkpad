import { useEffect, useState } from 'react'
import type { Engine } from '../../engine/engine'
import type { Tool } from '../../engine/types'
import { ERASER_SIZES, HL_COLORS, HL_WIDTHS, PEN_COLORS, PEN_WIDTHS, useUI } from '../../app/store'
import type { DocumentMeta } from '../../shared/model'
import { Icon } from '../Icon'

const TOOLS: { id: Tool; label: string; icon: string }[] = [
  { id: 'pen', label: '펜', icon: 'pen' },
  { id: 'highlighter', label: '형광펜', icon: 'highlighter' },
  { id: 'eraser', label: '지우개', icon: 'eraser' },
  { id: 'lasso', label: '올가미', icon: 'lasso' }
]

const SAVE_LABEL = { saved: '저장됨', pending: '저장 대기', saving: '저장 중', error: '저장 실패' }

/**
 * 편집 화면 상단 메뉴바 (A안 · 2단 분리형)
 * 1단 문서 바: 문서 정보와 문서 단위 액션 (제목·저장 상태·페이지·버전·내보내기·설정·동기화)
 * 2단 도구 바: 그리기 도구와 스타일 (도구·색·굵기·되돌리기·전체 보기)
 */
export function EditorToolbar(props: {
  engine: Engine | null
  doc: DocumentMeta | null
  readOnly: boolean
  onRename: (t: string) => void
  onBack: () => void
}) {
  const { engine, doc } = props
  const tool = useUI((s) => s.tool)
  const setTool = useUI((s) => s.setTool)
  const style = useUI((s) => s.style)
  const setStyle = useUI((s) => s.setStyle)
  const view = useUI((s) => s.view)
  const panel = useUI((s) => s.panel)
  const setPanel = useUI((s) => s.setPanel)
  const sidebar = useUI((s) => s.sidebar)
  const setSidebar = useUI((s) => s.setSidebar)
  const saveState = useUI((s) => s.saveState)
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState('')
  const [picker, setPicker] = useState(false)
  const [widthPop, setWidthPop] = useState(false)

  useEffect(() => setTitle(doc?.title ?? ''), [doc?.title])

  const isHl = tool === 'highlighter'
  const colors = isHl ? HL_COLORS : PEN_COLORS
  const widths = isHl ? HL_WIDTHS : tool === 'eraser' ? ERASER_SIZES : PEN_WIDTHS
  const curColor = isHl ? style.highlighter.color : style.pen.color
  const curWidth = isHl ? style.highlighter.width : tool === 'eraser' ? style.eraserSize : style.pen.width

  const pickColor = (c: string) => {
    if (isHl) setStyle({ ...style, highlighter: { ...style.highlighter, color: c } })
    else {
      setStyle({ ...style, pen: { ...style.pen, color: c } })
      if (tool !== 'pen') setTool('pen')
    }
    setPicker(false)
  }
  const pickWidth = (w: number) => {
    if (isHl) setStyle({ ...style, highlighter: { ...style.highlighter, width: w } })
    else if (tool === 'eraser') setStyle({ ...style, eraserSize: w })
    else setStyle({ ...style, pen: { ...style.pen, width: w } })
    setWidthPop(false)
  }

  const showStyle = tool === 'pen' || tool === 'highlighter' || tool === 'eraser'
  const dotSize = (w: number) => Math.min(24, Math.max(3, tool === 'eraser' ? w / 2 : isHl ? w * 0.8 : w * 1.8))
  // 색상 스와치는 앞 5개를 인라인 노출하고, 나머지와 직접 선택은 팝오버에서 고른다.
  const inlineColors = colors.slice(0, 5)

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

      {/* ── 2단: 도구 바 ── */}
      <div className="toolbar toolbar-tools">
        <nav className="toolbar-group tools-group" aria-label="도구">
          <div className="tool-seg">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className={'tb-btn' + (tool === t.id ? ' is-active' : '')}
                onClick={() => setTool(t.id)}
                aria-label={t.label}
                aria-pressed={tool === t.id}
              >
                <Icon name={t.icon} />
              </button>
            ))}
          </div>
        </nav>

        {showStyle && (
          <nav className="toolbar-group style-group" aria-label="색상과 굵기">
            {tool !== 'eraser' && (
              <div className="color-pop-anchor">
                <button
                  className="color-swatch is-current"
                  style={{ ['--swatch' as string]: curColor }}
                  onClick={() => setPicker(!picker)}
                  aria-label="색상 선택"
                  aria-expanded={picker}
                />
                {picker && (
                  <div className="color-pop" role="listbox">
                    {colors.map((c) => (
                      <button
                        key={c}
                        className={'color-swatch' + (curColor === c ? ' is-active' : '')}
                        style={{ ['--swatch' as string]: c }}
                        onClick={() => pickColor(c)}
                        aria-label={`색상 ${c}`}
                      />
                    ))}
                    <label className="color-custom" aria-label="직접 선택">
                      <Icon name="palette" size={18} />
                      <input type="color" value={curColor.slice(0, 7)} onChange={(e) => pickColor(e.target.value + (isHl ? '66' : 'ff'))} />
                    </label>
                  </div>
                )}
              </div>
            )}

            {tool !== 'eraser' && (
              <div className="color-inline" aria-hidden={picker}>
                {inlineColors.slice(1).map((c) => (
                  <button
                    key={c}
                    className={'color-swatch sm' + (curColor === c ? ' is-active' : '')}
                    style={{ ['--swatch' as string]: c }}
                    onClick={() => pickColor(c)}
                    aria-label={`색상 ${c}`}
                  />
                ))}
              </div>
            )}

            <span className="style-sep" />

            {/* 넓은 화면: 굵기 전 단계 인라인 */}
            <div className="width-inline" role="listbox" aria-label="굵기">
              {widths.map((w) => (
                <button
                  key={w}
                  className={'width-btn' + (curWidth === w ? ' is-active' : '')}
                  onClick={() => pickWidth(w)}
                  aria-label={`굵기 ${w}`}
                  aria-pressed={curWidth === w}
                >
                  <span className="width-dot" style={{ width: dotSize(w) }} />
                </button>
              ))}
            </div>

            {/* 좁은 화면: 현재 굵기 버튼 + 팝오버 (단계 수는 동일) */}
            <div className="color-pop-anchor width-compact">
              <button className="width-btn is-current" onClick={() => setWidthPop(!widthPop)} aria-label={`굵기 ${curWidth}`} aria-expanded={widthPop}>
                <span className="width-dot" style={{ width: dotSize(curWidth) }} />
              </button>
              {widthPop && (
                <div className="color-pop width-pop" role="listbox">
                  {widths.map((w) => (
                    <button
                      key={w}
                      className={'width-btn' + (curWidth === w ? ' is-active' : '')}
                      onClick={() => pickWidth(w)}
                      aria-label={`굵기 ${w}`}
                    >
                      <span className="width-dot" style={{ width: dotSize(w) }} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </nav>
        )}

        <div className="toolbar-spacer" />

        <nav className="toolbar-group" aria-label="실행 취소와 보기">
          <button className="tb-btn" disabled={!view.canUndo} onClick={() => engine?.undo()} aria-label="실행 취소">
            <Icon name="undo" />
          </button>
          <button className="tb-btn" disabled={!view.canRedo} onClick={() => engine?.redo()} aria-label="다시 실행">
            <Icon name="redo" />
          </button>
          <button className="tb-btn" onClick={() => engine?.fitAll()} aria-label="전체 보기">
            <Icon name="fit" />
          </button>
        </nav>
      </div>
    </header>
  )
}
