import { useEffect, useRef, useState } from 'react'
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
  const presets = useUI((s) => s.presets)
  const activePreset = useUI((s) => s.activePreset)
  const applyPreset = useUI((s) => s.applyPreset)
  const savePreset = useUI((s) => s.savePreset)
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState('')
  const [picker, setPicker] = useState(false)
  const [widthPop, setWidthPop] = useState(false)
  const pressTimer = useRef(0)

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
  }

  const showStyle = tool === 'pen' || tool === 'highlighter' || tool === 'eraser'
  const dotSize = (w: number) => Math.min(24, Math.max(3, tool === 'eraser' ? w / 2 : isHl ? w * 0.8 : w * 1.8))

  return (
    <header id="editor-toolbar" className="toolbar">
      <nav className="toolbar-group" aria-label="탐색">
        <button className="tb-btn" onClick={props.onBack} aria-label="문서 목록">
          <Icon name="back" />
        </button>
        {doc?.mode === 'paged' && (
          <button className={'tb-btn' + (sidebar ? ' is-active' : '')} onClick={() => setSidebar(!sidebar)} aria-label="페이지 목록">
            <Icon name="sidebar" />
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
            {doc?.title ?? ''}
            {props.readOnly && <span className="ro-badge">읽기 전용</span>}
          </button>
        )}
      </nav>

      <nav className="toolbar-group" aria-label="실행 취소">
        <button className="tb-btn" disabled={!view.canUndo} onClick={() => engine?.undo()} aria-label="실행 취소">
          <Icon name="undo" />
        </button>
        <button className="tb-btn" disabled={!view.canRedo} onClick={() => engine?.redo()} aria-label="다시 실행">
          <Icon name="redo" />
        </button>
      </nav>

      <nav className="toolbar-group" aria-label="도구">
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
      </nav>

      <nav className="toolbar-group preset-group" aria-label="프리셋">
        {presets.map((p, i) => (
          <button
            key={i}
            className={'preset-btn' + (activePreset === i ? ' is-active' : '')}
            aria-label={`프리셋 ${i + 1} (길게 눌러 현재 펜으로 저장)`}
            onPointerDown={() => {
              pressTimer.current = window.setTimeout(() => {
                pressTimer.current = -1
                savePreset(i)
                useUI.getState().toast(`프리셋 ${i + 1}에 저장했습니다.`, 'success')
              }, 600)
            }}
            onPointerUp={() => {
              if (pressTimer.current > 0) {
                clearTimeout(pressTimer.current)
                applyPreset(i)
              }
              pressTimer.current = 0
            }}
            onPointerLeave={() => pressTimer.current > 0 && clearTimeout(pressTimer.current)}
            onContextMenu={(e) => e.preventDefault()}
          >
            <span
              className={'preset-dot' + (p.tool === 'highlighter' ? ' hl' : '')}
              style={{ background: p.color, width: Math.min(22, 6 + p.width * (p.tool === 'highlighter' ? 0.6 : 1.6)) }}
            />
          </button>
        ))}
      </nav>

      {showStyle && (
        <nav className="toolbar-group style-group" aria-label="색상과 굵기">
          {tool !== 'eraser' && (
            <div className="color-pop-anchor">
              <button className="color-swatch is-current" style={{ ['--swatch' as string]: curColor }} onClick={() => setPicker(!picker)} aria-label="색상 선택" />
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
                    <input
                      type="color"
                      value={curColor.slice(0, 7)}
                      onChange={(e) => pickColor(e.target.value + (isHl ? '66' : 'ff'))}
                    />
                  </label>
                </div>
              )}
            </div>
          )}
          <div className="color-pop-anchor">
            <button className="width-btn is-current" onClick={() => setWidthPop(!widthPop)} aria-label={`굵기 ${curWidth}`}>
              <span className="width-dot" style={{ width: dotSize(curWidth) }} />
            </button>
            {widthPop && (
              <div className="color-pop width-pop" role="listbox">
                {widths.map((w) => (
                  <button
                    key={w}
                    className={'width-btn' + (curWidth === w ? ' is-active' : '')}
                    onClick={() => {
                      pickWidth(w)
                      setWidthPop(false)
                    }}
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

      <span className={'save-state ' + saveState} title={SAVE_LABEL[saveState]}>
        <Icon name={saveState === 'error' ? 'alert' : 'check'} size={14} />
        <span className="save-label">{SAVE_LABEL[saveState]}</span>
      </span>

      <nav className="toolbar-group" aria-label="보기">
        <button className="tb-btn" onClick={() => engine?.fitAll()} aria-label="전체 보기">
          <Icon name="fit" />
        </button>
        {doc?.mode === 'paged' && (
          <button className={'tb-btn' + (panel === 'page' ? ' is-active' : '')} onClick={() => setPanel('page')} aria-label="페이지 설정">
            <Icon name="page" />
          </button>
        )}
        {doc?.mode === 'infinite' && (
          <button className={'tb-btn' + (panel === 'page' ? ' is-active' : '')} onClick={() => setPanel('page')} aria-label="배경 설정">
            <Icon name="grid" />
          </button>
        )}
        <button className={'tb-btn' + (panel === 'export' ? ' is-active' : '')} onClick={() => setPanel('export')} aria-label="내보내기">
          <Icon name="share" />
        </button>
        <button className={'tb-btn' + (panel === 'settings' ? ' is-active' : '')} onClick={() => setPanel('settings')} aria-label="설정">
          <Icon name="gear" />
        </button>
      </nav>
    </header>
  )
}
