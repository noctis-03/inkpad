// 문서(text 모드) 편집 화면 — 노션처럼 한 줄 한 블록. 블록마다 contenteditable 하나.
// 값(블록 목록·되돌리기·저장)은 TextDocModel이, 캐럿·키·붙여넣기는 여기서 다룬다.
// contenteditable은 React가 내용을 다시 그리지 않는다: 블록 HTML이 DOM과 다를 때(되돌리기·나누기)만 innerHTML을 쓴다.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useUI } from '../../app/store'
import { crossfading } from '../motion/motion'
import { TAP_SLOP_PX } from '../../engine/constants'
import { normalizeBlockUrl } from '../../engine/blocks'
import { db } from '../../storage/db'
import { loadTextBlocks, putThumbnail, saveTextBatch, updateDocument } from '../../storage/repo'
import { acquireDocLock, releaseDocLock } from '../../storage/tabLock'
import { registerOpenDoc, whenDocIdle } from '../../storage/docGuard'
import { REMOTE_EVENT } from '../../sync/sync'
import { scheduleUnchangedCheck } from '../../sync/unchanged'
import { remindOnLeave } from '../../app/syncReminders'
import { NoteSyncChip } from '../editor/NoteSyncChip'
import { VersionPanel } from '../editor/VersionPanel'
import { SettingsPanel } from '../SettingsPanel'
import { SyncPanel } from '../SyncSection'
import { TextExportPanel } from './TextExportPanel'
import { emitThumbsChanged } from '../../io/docThumb'
import { trackRecentDoc } from '../../shared/recentDocs'
import { plainText } from '../../shared/richText'
import { ulid } from '../../shared/ulid'
import { keyBetween } from '../../shared/fracIndex'
import type { DocumentMeta, ID, TextBlock, TextBlockType } from '../../shared/model'
import { TextDocModel, numberLabels, visibleBlocks, type Caret } from '../../textdoc/model'
import { caretOffset, caretOnFirstLine, caretOnLastLine, deleteRange, setCaret, splitAtCaret, textLength } from '../../textdoc/caret'
import { SLASH_ITEMS, filterSlash, linesToBlocks, markdownShortcut, type SlashItem } from '../../textdoc/commands'
import { renderTextThumb } from '../../textdoc/thumb'
import { Icon } from '../Icon'
import { Menu, MenuItem } from '../Menu'

const SAVE_LABEL = { saved: '저장됨', pending: '저장 대기', saving: '저장 중', error: '저장 실패' } as const
/** 빈 블록에서 Enter → 문단으로 바꾸는 종류 (목록을 끝낼 때) */
const EXIT_ON_EMPTY: TextBlockType[] = ['bullet', 'number', 'todo', 'quote', 'toggle']
const PLACEHOLDER: Partial<Record<TextBlockType, string>> = {
  p: "'/'를 눌러 블록 종류 고르기",
  h1: '제목 1',
  h2: '제목 2',
  h3: '제목 3',
  bullet: '목록',
  number: '목록',
  todo: '할 일',
  toggle: '토글',
  quote: '인용',
  code: '코드'
}
const BULLETS = ['•', '◦', '▪']
/** 새로 만들기에서 이름을 안 적었을 때의 제목 (library/NewDocumentSheet와 같은 값) */
const DEFAULT_TEXT_TITLE = '새 문서'

interface SlashState {
  id: ID
  /** '/'가 있는 글자 자리 */
  start: number
  query: string
  index: number
  x: number
  y: number
}

/** 블록 행이 부르는 동작 — 참조가 바뀌지 않게 ref로 묶어 memo 행이 다시 그려지지 않게 한다 */
interface RowCtx {
  readOnly: boolean
  register: (id: ID, el: HTMLElement | null) => void
  registerRow: (id: ID, el: HTMLElement | null) => void
  onKey: (e: ReactKeyboardEvent<HTMLElement>, b: TextBlock) => void
  onInput: (e: React.FormEvent<HTMLElement>, b: TextBlock) => void
  onPaste: (e: React.ClipboardEvent<HTMLElement>, b: TextBlock) => void
  onGrip: (e: ReactPointerEvent<HTMLElement>, b: TextBlock) => void
  onAdd: (b: TextBlock) => void
  onCheck: (b: TextBlock) => void
  onCollapse: (b: TextBlock) => void
  onLinkClick: (e: React.MouseEvent) => void
}

export function TextEditor({ docId }: { docId: ID }) {
  const navigate = useUI((s) => s.navigate)
  const toast = useUI((s) => s.toast)
  const saveState = useUI((s) => s.saveState)
  const [doc, setDoc] = useState<DocumentMeta | null>(null)
  const [model, setModel] = useState<TextDocModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [access, setAccess] = useState<'pending' | 'edit' | 'read'>('pending')
  const readOnly = access === 'read'
  const accessRef = useRef(access)
  accessRef.current = access
  const gone = useRef<Promise<void>>(Promise.resolve())
  /** 동기화가 이 문서를 바꾸면 내렸다가(suspended) DB에서 다시 연다(epoch) — 노트 편집 화면과 같은 노트 보호 */
  const [epoch, setEpoch] = useState(0)
  const [suspended, setSuspended] = useState(false)
  const modelRef = useRef<TextDocModel | null>(null)
  const skipThumb = useRef(false)
  const panel = useUI((s) => s.panel)
  const setPanel = useUI((s) => s.setPanel)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => trackRecentDoc(docId), [docId])

  // 여는 애니메이션 — 노트 편집 화면과 같게 (홈에서 열면 App Panes의 크로스페이드, 아니면 페이드업)
  useEffect(() => {
    const el = rootRef.current
    if (!el || document.documentElement.dataset.motion === 'off' || crossfading(el)) return
    el.classList.add('doc-enter')
  }, [])

  // 편집 잠금 — 같은 문서를 두 탭에서 고치지 않게 (노트와 같은 잠금)
  useEffect(() => {
    let alive = true
    const wantView = useUI.getState().viewOnly
    if (wantView) useUI.setState({ viewOnly: false })
    // 낙서 모드는 필기 노트 전용 — 문서에는 없다 (라이브러리도 내지 않지만 다른 길로 들어와도 남기지 않는다)
    if (useUI.getState().scratch) useUI.setState({ scratch: false })
    void acquireDocLock(docId, { readOnly: wantView }).then((ok) => {
      if (!alive) {
        if (ok) releaseDocLock(docId)
        return
      }
      setAccess(ok ? 'edit' : 'read')
      if (!ok && !wantView) toast('이 문서는 다른 탭에서 열려 있어 읽기 전용으로 엽니다.', 'info')
    })
    return () => {
      alive = false
      void Promise.resolve()
        .then(() => gone.current)
        .finally(() => releaseDocLock(docId))
    }
  }, [docId, toast])

  // 불러오기 / 정리 — 잠금 결과가 나온 뒤, 그리고 다시 열 때(epoch)마다
  useEffect(() => {
    if (access === 'pending' || suspended) return
    let disposed = false
    let m: TextDocModel | null = null
    ;(async () => {
      try {
        await gone.current // 직전 모델이 마지막 변경을 기록할 때까지
        await whenDocIdle(docId) // 동기화가 이 문서를 바꾸는 중이면 끝날 때까지
        if (disposed) return
        const d = await db.documents.get(docId)
        if (!d || disposed) return void (!d && setError('문서를 찾을 수 없습니다.'))
        let blocks = await loadTextBlocks(docId)
        if (!blocks.length) {
          // 빈 문서 — 빈 문단 하나로 시작한다
          const now = Date.now()
          blocks = [{ id: ulid(), documentId: docId, type: 'p', html: '', indent: 0, pos: keyBetween(null, null), createdAt: now, updatedAt: now }]
          if (access === 'edit') await saveTextBatch({ documentId: docId, upsert: blocks })
        }
        if (disposed) return
        m = new TextDocModel(
          docId,
          blocks,
          async (b) => {
            await saveTextBatch(b)
            // 되돌리기로 마지막 동기화 상태와 같아졌을 수도 있다 — 쉬었다가 한 번 본다 (노트와 같게)
            scheduleUnchangedCheck(docId)
          },
          access === 'read'
        )
        m.onSaveState = (s, err) => {
          useUI.setState({ saveState: s })
          if (s === 'error') {
            const quota = (err as DOMException)?.name === 'QuotaExceededError'
            useUI.getState().toast(quota ? '기기 저장 공간이 부족합니다. 설정 > 저장소에서 공간을 확인하세요.' : '저장하지 못했습니다. 잠시 후 다시 시도합니다.', 'error')
          }
        }
        useUI.setState({ saveState: 'saved' })
        setDoc(d)
        modelRef.current = m
        setModel(m)
        if (import.meta.env.DEV) (window as unknown as { inkpadText: TextDocModel }).inkpadText = m
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : '문서를 열 수 없습니다.')
      }
    })()
    return () => {
      disposed = true
      const mm = m
      const makeThumb = !skipThumb.current
      skipThumb.current = false
      modelRef.current = null
      setModel(null)
      if (!mm) return
      gone.current = (async () => {
        mm.destroy()
        await mm.flush()
        if (mm.readOnly || !makeThumb) return
        // 카드 미리보기 — 제목과 앞쪽 블록 몇 줄
        const d = await db.documents.get(docId)
        const blob = await renderTextThumb(d?.title ?? '', mm.blocks).catch(() => null)
        if (blob) {
          await putThumbnail(docId, blob)
          emitThumbsChanged()
        }
      })().catch((err) => console.warn('[text] 문서 화면 정리 중 오류', err))
    }
  }, [docId, access, epoch, suspended])

  // 노트 보호 등록 (storage/docGuard) — 동기화·버전 되돌리기가 이 문서를 바꿀 때 먼저 기록·멈추고, 끝나면 DB에서 다시 연다
  useEffect(() => {
    if (access !== 'edit') return
    return registerOpenDoc(docId, {
      flush: async () => {
        await modelRef.current?.flush()
      },
      suspend: async () => {
        const m = modelRef.current
        if (m) {
          const was = m.readOnly
          m.readOnly = true // 입력을 막는다
          m.commitTyping()
          await m.flush()
          if (m.hasPendingChanges) {
            m.readOnly = was
            throw new Error('편집 내용을 기기에 저장하지 못해 동기화를 멈췄습니다. 잠시 뒤 다시 시도해 주세요.')
          }
        }
        skipThumb.current = true
        setSuspended(true)
      },
      resume: () => {
        setSuspended(false)
        setEpoch((n) => n + 1)
      }
    })
  }, [docId, access])

  // 읽기 전용(다른 탭이 편집 중·뷰어)은 원격 변경 알림을 받으면 바뀐 내용으로 다시 연다
  useEffect(() => {
    const onRemote = (ev: Event) => {
      const ids = (ev as CustomEvent<Set<string>>).detail
      if (!ids?.has(docId) || accessRef.current !== 'read') return
      skipThumb.current = true
      setEpoch((n) => n + 1)
      toast('이 문서의 바뀐 내용을 다시 불러왔습니다.', 'info')
    }
    window.addEventListener(REMOTE_EVENT, onRemote)
    return () => window.removeEventListener(REMOTE_EVENT, onRemote)
  }, [docId, toast])

  // 백그라운드로 가거나 닫히면 바로 기록 (iPad는 뒤로 간 탭을 예고 없이 닫는다)
  useEffect(() => {
    if (!model) return
    const now = () => void model.flush()
    const onVis = () => document.hidden && now()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', now)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', now)
    }
  }, [model])

  const leave = () => {
    useUI.setState({ returnDocId: docId })
    if (!readOnly) remindOnLeave(docId, doc?.title ?? '')
    useUI.getState().backHome()
  }
  const run = (fn: () => void) => () => {
    setMenu(null)
    fn()
  }

  if (error) {
    return (
      <div className="editor-error">
        <p>{error}</p>
        <button className="primary-btn" onClick={() => navigate({ name: 'library' })}>
          문서 목록으로
        </button>
      </div>
    )
  }

  return (
    <div className="editor text-editor" ref={rootRef}>
      <header id="editor-toolbar" className="toolbar-stack">
        <div className="toolbar toolbar-doc">
          <nav className="toolbar-group" aria-label="탐색">
            <button className="tb-btn" onClick={leave} aria-label="문서 목록" title="탭 닫고 홈으로">
              <Icon name="back" size={20} />
            </button>
            <span className="doc-title-btn tdoc-bar-title">
              <span className="doc-title-text">{doc?.title || '제목 없음'}</span>
            </span>
          </nav>
          <div className="toolbar-spacer" />
          {readOnly ? (
            <span className="save-state saved" aria-label="읽기 전용">
              <Icon name="lock" size={14} />
              <span className="save-label">읽기 전용</span>
            </span>
          ) : (
            <span className={'save-state ' + saveState} aria-label={SAVE_LABEL[saveState]}>
              <Icon name={saveState === 'error' ? 'alert' : 'check'} size={14} />
              <span className="save-label">{SAVE_LABEL[saveState]}</span>
            </span>
          )}
          {/* 이 문서의 동기화 상태 — 읽기 전용이면 내지 않는다 (노트와 같은 칩) */}
          {doc && !readOnly && <NoteSyncChip docId={doc.id} title={doc.title} />}
          <nav className="toolbar-group" aria-label="문서">
            <button
              className={'tb-btn' + (menu ? ' is-active' : '')}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setMenu((m) => (m ? null : { x: r.right, y: r.bottom }))
              }}
              aria-label="더보기"
              aria-haspopup="menu"
              aria-expanded={!!menu}
            >
              <Icon name="more" size={20} />
            </button>
          </nav>
        </div>
      </header>
      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem icon="restore" label="버전 기록" onClick={run(() => setPanel('history'))} />
          <MenuItem icon="share" label="내보내기" onClick={run(() => setPanel('export'))} />
          <MenuItem icon="gear" label="설정" onClick={run(() => setPanel('settings'))} />
          <MenuItem icon="cloud" label="동기화" onClick={run(() => setPanel('sync'))} />
        </Menu>
      )}
      <div className="editor-body">
        <div className="editor-area">
          {model && doc ? (
            <DocBody key={epoch} model={model} doc={doc} readOnly={readOnly} onTitle={(t) => setDoc({ ...doc, title: t })} />
          ) : (
            <div className="doc-skeleton" role="status" aria-label={suspended ? '동기화로 문서를 맞추는 중' : '문서 여는 중'} />
          )}
          {panel === 'settings' && <SettingsPanel />}
          {panel === 'sync' && <SyncPanel />}
          {panel === 'history' && <VersionPanel docId={docId} />}
          {panel === 'export' && model && doc && <TextExportPanel model={model} doc={doc} />}
        </div>
      </div>
    </div>
  )
}

function DocBody({ model, doc, readOnly, onTitle }: { model: TextDocModel; doc: DocumentMeta; readOnly: boolean; onTitle: (t: string) => void }) {
  useSyncExternalStore(model.subscribe, model.version)
  const blocks = model.blocks
  const visible = useMemo(() => visibleBlocks(blocks), [blocks, model.version()]) // eslint-disable-line react-hooks/exhaustive-deps
  const numbers = useMemo(() => numberLabels(blocks), [blocks, model.version()]) // eslint-disable-line react-hooks/exhaustive-deps
  const els = useRef(new Map<ID, HTMLElement>())
  const rows = useRef(new Map<ID, HTMLElement>())
  const titleRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<Caret | null>(null)
  const [slash, setSlash] = useState<SlashState | null>(null)
  const slashRef = useRef(slash)
  slashRef.current = slash
  const [menu, setMenu] = useState<{ id: ID; x: number; y: number } | null>(null)
  const [drop, setDrop] = useState<{ y: number } | null>(null)
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  // 캐럿 옮기기 요청(되돌리기·나누기·합치기) — 다음 그리기가 끝난 뒤 DOM에 반영한다
  useEffect(() => {
    model.onFocus = (c) => (pendingFocus.current = c)
    return () => {
      model.onFocus = undefined
    }
  }, [model])
  useLayoutEffect(() => {
    const c = pendingFocus.current
    if (!c) return
    pendingFocus.current = null
    focusBlock(c.id, c.offset)
  })

  const focusBlock = (id: ID, offset: Caret['offset']) => {
    const el = els.current.get(id)
    if (!el) return
    el.focus({ preventScroll: false })
    if (el.isContentEditable) setCaret(el, offset)
  }

  /** 보이는 블록 중 앞·뒤 */
  const neighbor = (id: ID, d: -1 | 1): TextBlock | null => {
    const v = visibleRef.current
    const i = v.findIndex((b) => b.id === id)
    return v[i + d] ?? null
  }

  const closeSlash = () => setSlash(null)

  /** 슬래시 메뉴에서 고르기 — '/검색어'를 지우고 블록을 바꾼다 */
  const chooseSlash = (item: SlashItem) => {
    const s = slashRef.current
    if (!s) return
    setSlash(null)
    const el = els.current.get(s.id)
    const b = model.get(s.id)
    if (!el || !b) return
    deleteRange(el, s.start, Math.max(s.start + 1, caretOffset(el)))
    model.input(b.id, cleanEmpty(el))
    applyType(model.get(b.id)!, item.type)
  }

  /** 블록 종류 바꾸기. 구분선은 빈 블록이면 그 자리를, 아니면 아래에 새로 만들고 다음 줄로 */
  const applyType = (b: TextBlock, type: TextBlockType, checked?: boolean) => {
    if (type === 'divider') {
      if (!plainText(b.html).trim()) {
        // 빈 줄 → 그 자리가 구분선이 되고, 아래 새 줄로
        const nb = model.makeBlock(b.id, { indent: b.indent })
        model.exec(
          [
            { before: b, after: { ...b, type: 'divider', html: '', updatedAt: Date.now() } },
            { before: null, after: nb }
          ],
          { before: { id: b.id, offset: 'end' }, after: { id: nb.id, offset: 'start' } }
        )
      } else {
        // 글이 있는 줄 → 아래에 구분선만 넣는다
        model.exec([{ before: null, after: model.makeBlock(b.id, { type: 'divider', indent: b.indent }) }], { after: { id: b.id, offset: 'end' } })
      }
      return
    }
    model.setType(b.id, type, { id: b.id, offset: 'end' })
    if (type === 'todo' && checked) model.patch(b.id, { checked: true })
  }

  const runFormat = (el: HTMLElement, b: TextBlock, cmd: 'bold' | 'italic' | 'underline' | 'strikeThrough' | 'code' | 'link') => {
    if (b.type === 'code') return
    // 제목은 이미 굵다 — 브라우저가 '굵게 풀기'(font-weight: normal)를 넣지 않게 한다
    if (cmd === 'bold' && (b.type === 'h1' || b.type === 'h2' || b.type === 'h3')) return
    if (cmd === 'code') toggleInlineCode(el)
    else if (cmd === 'link') {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) return useUI.getState().toast('링크로 만들 글자를 먼저 고르세요.', 'info')
      const range = sel.getRangeAt(0).cloneRange()
      const raw = window.prompt('링크 주소', 'https://')
      if (!raw) return
      const url = normalizeBlockUrl(raw)
      if (!url) return useUI.getState().toast('http·https·mailto·tel 링크만 쓸 수 있습니다.', 'error')
      sel.removeAllRanges()
      sel.addRange(range)
      document.execCommand('createLink', false, url)
    } else document.execCommand(cmd)
    model.input(b.id, cleanEmpty(el))
  }

  const ctxRef = useRef<RowCtx>(null as unknown as RowCtx)
  ctxRef.current = {
    readOnly,
    register: (id, el) => (el ? els.current.set(id, el) : els.current.delete(id)),
    registerRow: (id, el) => (el ? rows.current.set(id, el) : rows.current.delete(id)),
    onLinkClick: (e) => {
      const a = (e.target as HTMLElement).closest('a')
      if (!a || !(e.metaKey || e.ctrlKey || readOnly)) return
      e.preventDefault()
      window.open(a.href, '_blank', 'noopener,noreferrer')
    },
    onInput: (e, b) => {
      const el = e.currentTarget
      const html = cleanEmpty(el)
      const ne = e.nativeEvent as InputEvent
      model.input(b.id, html, { id: b.id, offset: caretOffset(el) })
      const typed = ne.inputType === 'insertText' && !ne.isComposing ? ne.data : null
      const off = caretOffset(el)
      const text = el.textContent ?? ''
      // 마크다운 단축키 — 문단 맨 앞에서만
      if (b.type === 'p' && typed && (typed === ' ' || typed === '`' || typed === '-')) {
        const sc = markdownShortcut(text.slice(0, off))
        if (sc) {
          deleteRange(el, 0, off)
          model.input(b.id, cleanEmpty(el))
          setSlash(null)
          return applyType(model.get(b.id)!, sc.type, sc.checked)
        }
      }
      // 슬래시 메뉴 — 줄 맨 앞이나 공백 뒤에서 '/'
      if (typed === '/' && b.type !== 'code' && (off === 1 || /\s/.test(text[off - 2] ?? ''))) {
        const r = window.getSelection()?.getRangeAt(0).getBoundingClientRect()
        const er = el.getBoundingClientRect()
        setSlash({ id: b.id, start: off - 1, query: '', index: 0, x: r && r.width + r.height ? r.left : er.left, y: (r && r.height ? r.bottom : er.bottom) + 6 })
        return
      }
      const s = slashRef.current
      if (s && s.id === b.id) {
        if (off <= s.start || text[s.start] !== '/') return setSlash(null)
        const q = text.slice(s.start + 1, off)
        // 공백을 쳤는데 맞는 것이 없으면 그냥 글자로 둔다
        if (/\s$/.test(q) && !filterSlash(q).length) return setSlash(null)
        setSlash({ ...s, query: q, index: 0 })
      }
    },
    onKey: (e, b) => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      const el = e.currentTarget as HTMLElement
      const mod = e.metaKey || e.ctrlKey
      const key = e.key
      const s = slashRef.current
      if (s && s.id === b.id) {
        const items = filterSlash(s.query)
        if (key === 'ArrowDown' || key === 'ArrowUp') {
          e.preventDefault()
          const n = Math.max(1, items.length)
          setSlash({ ...s, index: (s.index + (key === 'ArrowDown' ? 1 : n - 1)) % n })
          return
        }
        if ((key === 'Enter' || key === 'Tab') && items.length) {
          e.preventDefault()
          chooseSlash(items[Math.min(s.index, items.length - 1)])
          return
        }
        if (key === 'Escape') {
          e.preventDefault()
          setSlash(null)
          return
        }
      }
      if (mod && key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) model.redo()
        else model.undo()
        return
      }
      if (mod && key.toLowerCase() === 'y') {
        e.preventDefault()
        model.redo()
        return
      }
      if (b.type === 'divider') {
        if (key === 'Backspace' || key === 'Delete') {
          e.preventDefault()
          const nb = neighbor(b.id, -1) ?? neighbor(b.id, 1)
          model.remove([b.id], nb ? { id: nb.id, offset: 'end' } : undefined)
        } else if (key === 'Enter') {
          e.preventDefault()
          const nb = model.makeBlock(b.id, { indent: b.indent })
          model.exec([{ before: null, after: nb }], { after: { id: nb.id, offset: 'start' } })
        } else if (key === 'ArrowUp' || key === 'ArrowLeft') {
          const p = neighbor(b.id, -1)
          if (p) (e.preventDefault(), focusBlock(p.id, 'end'))
        } else if (key === 'ArrowDown' || key === 'ArrowRight') {
          const n = neighbor(b.id, 1)
          if (n) (e.preventDefault(), focusBlock(n.id, 'start'))
        }
        return
      }
      if (mod && !e.altKey) {
        const k = key.toLowerCase()
        const cmd = k === 'b' ? 'bold' : k === 'i' ? 'italic' : k === 'u' ? 'underline' : k === 'e' ? 'code' : k === 'k' ? 'link' : (k === 's' || k === 'x') && e.shiftKey ? 'strikeThrough' : null
        if (cmd) {
          e.preventDefault()
          runFormat(el, b, cmd)
          return
        }
      }
      const sel = window.getSelection()
      const collapsed = !!sel?.isCollapsed
      if (key === 'Enter' && !mod) {
        if (b.type === 'code' && !e.shiftKey) {
          e.preventDefault()
          document.execCommand('insertText', false, '\n')
          return
        }
        if (e.shiftKey && b.type !== 'code') return // 블록 안 줄바꿈 (<br>)
        e.preventDefault()
        setSlash(null)
        if (b.type === 'code') {
          // 코드 블록에서 Shift+Enter — 아래 새 문단으로 나간다
          const nb = model.makeBlock(b.id, { indent: b.indent })
          model.exec([{ before: null, after: nb }], { after: { id: nb.id, offset: 'start' } })
          return
        }
        if (!(el.textContent ?? '').length && EXIT_ON_EMPTY.includes(b.type)) {
          // 빈 목록 줄에서 Enter — 안쪽이면 한 단계 밖으로, 아니면 목록을 끝낸다
          if (b.indent > 0) model.setIndent(b.id, b.indent - 1)
          else model.setType(b.id, 'p', { id: b.id, offset: 'start' })
          return
        }
        const { head, tail } = splitAtCaret(el)
        model.split(b.id, cleanHtml(head), cleanHtml(tail))
        return
      }
      if (key === 'Backspace' && collapsed && caretOffset(el) === 0) {
        if (b.type !== 'p') {
          e.preventDefault()
          model.setType(b.id, 'p', { id: b.id, offset: 'start' })
          return
        }
        if (b.indent > 0) {
          e.preventDefault()
          model.setIndent(b.id, b.indent - 1)
          return
        }
        const i = model.indexOf(b.id)
        if (i <= 0) return
        e.preventDefault()
        model.mergeUp(b.id)
        return
      }
      if (key === 'Delete' && collapsed && caretOffset(el) === textLength(el)) {
        const i = model.indexOf(b.id)
        const next = model.blocks[i + 1]
        if (!next) return
        e.preventDefault()
        model.mergeUp(next.id)
        return
      }
      if (key === 'Tab') {
        e.preventDefault()
        model.setIndent(b.id, b.indent + (e.shiftKey ? -1 : 1))
        return
      }
      if (e.shiftKey || e.altKey || mod) return
      if (key === 'ArrowUp' && caretOnFirstLine(el)) {
        const p = neighbor(b.id, -1)
        if (p) (e.preventDefault(), focusBlock(p.id, 'end'))
        else if (titleRef.current) (e.preventDefault(), titleRef.current.focus(), setCaret(titleRef.current, 'end'))
      } else if (key === 'ArrowDown' && caretOnLastLine(el)) {
        const n = neighbor(b.id, 1)
        if (n) (e.preventDefault(), focusBlock(n.id, 'start'))
      } else if (key === 'ArrowLeft' && collapsed && caretOffset(el) === 0) {
        const p = neighbor(b.id, -1)
        if (p) (e.preventDefault(), focusBlock(p.id, 'end'))
      } else if (key === 'ArrowRight' && collapsed && caretOffset(el) === textLength(el)) {
        const n = neighbor(b.id, 1)
        if (n) (e.preventDefault(), focusBlock(n.id, 'start'))
      }
    },
    onPaste: (e, b) => {
      if (readOnly) return
      const text = e.clipboardData.getData('text/plain')
      if (!text) return
      e.preventDefault()
      const el = e.currentTarget as HTMLElement
      if (b.type === 'code' || !text.includes('\n')) {
        document.execCommand('insertText', false, text)
        return
      }
      const { head, tail } = splitAtCaret(el)
      model.pasteLines(b.id, cleanHtml(head), cleanHtml(tail), linesToBlocks(text))
    },
    onAdd: (b) => {
      // 아래에 새 줄을 만들고 슬래시 메뉴를 연다
      const last = model.subtree(b.id).slice(-1)[0] ?? b
      const nb = model.makeBlock(last.id, { indent: b.indent, html: '/' })
      model.exec([{ before: null, after: nb }], { after: { id: nb.id, offset: 'end' } })
      requestAnimationFrame(() => {
        const el = els.current.get(nb.id)
        if (!el) return
        const r = el.getBoundingClientRect()
        setSlash({ id: nb.id, start: 0, query: '', index: 0, x: r.left, y: r.bottom + 6 })
      })
    },
    onCheck: (b) => model.patch(b.id, { checked: !b.checked }),
    onCollapse: (b) => model.patch(b.id, { collapsed: !b.collapsed }),
    onGrip: (e, b) => startDrag(e, b)
  }

  // ── 끌어서 순서 바꾸기 (손잡이). 움직이지 않고 떼면 블록 메뉴 ──
  const startDrag = (e: ReactPointerEvent<HTMLElement>, b: TextBlock) => {
    if (readOnly || (e.pointerType === 'mouse' && e.button !== 0)) return
    e.preventDefault()
    const grip = e.currentTarget
    grip.setPointerCapture(e.pointerId)
    const sy = e.clientY
    const sx = e.clientX
    let moved = false
    let target: ID | null | undefined
    const group = new Set(model.subtree(b.id).map((x) => x.id))
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < TAP_SLOP_PX) return
      moved = true
      const list = listRef.current!.getBoundingClientRect()
      const cands = visibleRef.current.filter((x) => !group.has(x.id))
      target = null
      let y = list.bottom - list.top
      for (const c of cands) {
        const r = rows.current.get(c.id)?.getBoundingClientRect()
        if (!r) continue
        if (ev.clientY < r.top + r.height / 2) {
          target = c.id
          y = r.top - list.top
          break
        }
        y = r.bottom - list.top
      }
      setDrop({ y })
    }
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      grip.removeEventListener('pointermove', onMove)
      grip.removeEventListener('pointerup', onUp)
      grip.removeEventListener('pointercancel', onUp)
      setDrop(null)
      if (ev.type === 'pointercancel') return
      if (!moved) {
        const r = grip.getBoundingClientRect()
        setMenu({ id: b.id, x: r.right, y: r.bottom })
        return
      }
      if (target !== undefined) model.move(b.id, target)
    }
    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', onUp)
    grip.addEventListener('pointercancel', onUp)
  }

  // ── 제목 ──
  const titleTimer = useRef(0)
  const titleTouched = useRef(false)
  const selectDefaultTitle = (el: HTMLElement) => {
    if (titleTouched.current || el.textContent !== DEFAULT_TEXT_TITLE) return
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return
    const r = document.createRange()
    r.selectNodeContents(el)
    sel?.removeAllRanges()
    sel?.addRange(r)
  }
  const saveTitle = (t: string) => {
    clearTimeout(titleTimer.current)
    titleTimer.current = window.setTimeout(() => {
      void updateDocument(doc.id, { title: t.trim() || '제목 없음' })
      onTitle(t.trim() || '제목 없음')
    }, 400)
  }
  useLayoutEffect(() => {
    if (titleRef.current && !titleRef.current.textContent) titleRef.current.textContent = doc.title === '제목 없음' ? '' : doc.title
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 아래 빈 곳을 누르면 마지막 블록으로 (마지막이 빈 문단이 아니면 새 문단)
  const onTail = () => {
    if (readOnly) return
    const last = model.blocks[model.blocks.length - 1]
    if (last && last.type === 'p' && !plainText(last.html)) return focusBlock(last.id, 'end')
    const nb = model.makeBlock(last?.id ?? null)
    model.exec([{ before: null, after: nb }], { after: { id: nb.id, offset: 'start' } })
  }

  const ctx = useMemo<RowCtx>(
    () => ({
      get readOnly() {
        return ctxRef.current.readOnly
      },
      register: (id, el) => ctxRef.current.register(id, el),
      registerRow: (id, el) => ctxRef.current.registerRow(id, el),
      onKey: (e, b) => ctxRef.current.onKey(e, b),
      onInput: (e, b) => ctxRef.current.onInput(e, b),
      onPaste: (e, b) => ctxRef.current.onPaste(e, b),
      onGrip: (e, b) => ctxRef.current.onGrip(e, b),
      onAdd: (b) => ctxRef.current.onAdd(b),
      onCheck: (b) => ctxRef.current.onCheck(b),
      onCollapse: (b) => ctxRef.current.onCollapse(b),
      onLinkClick: (e) => ctxRef.current.onLinkClick(e)
    }),
    []
  )

  const menuBlock = menu ? model.get(menu.id) : null
  const slashItems = slash ? filterSlash(slash.query) : []

  return (
    <main className="tdoc-scroll">
      <div className="tdoc-page">
        <div
          ref={titleRef}
          className="tdoc-title"
          contentEditable={!readOnly}
          suppressContentEditableWarning
          role="textbox"
          aria-label="문서 제목"
          data-placeholder="제목 없음"
          spellCheck={false}
          onInput={(e) => {
            titleTouched.current = true
            saveTitle(e.currentTarget.textContent ?? '')
          }}
          // 아직 손대지 않은 기본 제목('새 문서')은 통째로 골라 둔다 — 바로 쳐서 바꾸게.
          // 키보드로 들어오면 focus에서, 누르면 브라우저가 캐럿을 놓은 뒤(click)에 다시 고른다
          onFocus={(e) => selectDefaultTitle(e.currentTarget)}
          onClick={(e) => selectDefaultTitle(e.currentTarget)}
          onPaste={(e) => {
            e.preventDefault()
            document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\s*\n\s*/g, ' '))
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter' || (e.key === 'ArrowDown' && caretOnLastLine(e.currentTarget))) {
              e.preventDefault()
              const first = visible[0]
              if (first) focusBlock(first.id, 'start')
            }
          }}
        />
        <div className="tdoc-blocks" ref={listRef}>
          {visible.map((b) => (
            <BlockRow key={b.id} block={b} num={numbers.get(b.id)} ctx={ctx} readOnly={readOnly} />
          ))}
          {drop && <div className="tdoc-drop" style={{ top: drop.y }} />}
        </div>
        <div className="tdoc-tail" onClick={onTail} />
      </div>

      {slash && (
        <SlashMenu
          items={slashItems}
          index={slash.index}
          x={slash.x}
          y={slash.y}
          onPick={chooseSlash}
          onHover={(i) => setSlash({ ...slash, index: i })}
          onClose={closeSlash}
        />
      )}
      {!readOnly && <FormatBar onRun={(cmd) => {
        const sel = window.getSelection()
        const el = (sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement)?.closest('.tb-text') as HTMLElement | null
        const id = el?.closest<HTMLElement>('.tb-row')?.dataset.id
        const b = id ? model.get(id) : null
        if (el && b) runFormat(el, b, cmd)
      }} />}
      {menu && menuBlock && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {SLASH_ITEMS.filter((it) => it.type !== menuBlock.type).map((it) => (
            <MenuItem key={it.type} icon="replace" label={`${it.label}(으)로 바꾸기`} onClick={() => (setMenu(null), applyType(menuBlock, it.type))} />
          ))}
          <MenuItem icon="copy" label="복제" onClick={() => (setMenu(null), model.duplicate(menuBlock.id))} />
          <MenuItem
            icon="trash"
            label="삭제"
            danger
            onClick={() => {
              setMenu(null)
              const nb = neighbor(menuBlock.id, -1) ?? neighbor(menuBlock.id, 1)
              model.remove(
                model.subtree(menuBlock.id).map((x) => x.id),
                nb ? { id: nb.id, offset: 'end' } : undefined
              )
            }}
          />
        </Menu>
      )}
    </main>
  )
}

/** contenteditable이 빈 줄에 남기는 <br>을 걷어낸다 (빈 블록이 :empty가 되어 안내 글이 보이게) */
function cleanEmpty(el: HTMLElement): string {
  if (el.innerHTML === '<br>') el.innerHTML = ''
  return el.innerHTML
}
const cleanHtml = (html: string) => (html === '<br>' ? '' : html)

// ───────────────────────── 블록 한 줄 ─────────────────────────

const BlockRow = memo(function BlockRow({ block: b, num, ctx, readOnly }: { block: TextBlock; num?: number; ctx: RowCtx; readOnly: boolean }) {
  const ref = useRef<HTMLElement | null>(null)
  // 블록 HTML이 DOM과 다를 때만 쓴다 — 입력 중에는 같으므로 캐럿이 흔들리지 않는다
  useLayoutEffect(() => {
    const el = ref.current
    if (el && b.type !== 'divider' && el.innerHTML !== b.html) el.innerHTML = b.html
  }, [b.html, b.type])
  const setRef = useCallback(
    (el: HTMLElement | null) => {
      ref.current = el
      ctx.register(b.id, el)
    },
    [ctx, b.id]
  )
  const setRow = useCallback((el: HTMLElement | null) => ctx.registerRow(b.id, el), [ctx, b.id])

  const marker =
    b.type === 'bullet' ? (
      <span className="tb-marker tb-bullet" aria-hidden="true">
        {BULLETS[b.indent % BULLETS.length]}
      </span>
    ) : b.type === 'number' ? (
      <span className="tb-marker tb-number" aria-hidden="true">
        {num ?? 1}.
      </span>
    ) : b.type === 'todo' ? (
      <button className={'tb-marker tb-check' + (b.checked ? ' is-on' : '')} role="checkbox" aria-checked={!!b.checked} aria-label="했음" disabled={readOnly} onClick={() => ctx.onCheck(b)}>
        <Icon name="check" size={12} />
      </button>
    ) : b.type === 'toggle' ? (
      <button className={'tb-marker tb-toggle' + (b.collapsed ? '' : ' is-open')} aria-label={b.collapsed ? '펼치기' : '접기'} aria-expanded={!b.collapsed} disabled={readOnly} onClick={() => ctx.onCollapse(b)}>
        <Icon name="chevronRight" size={14} />
      </button>
    ) : null

  return (
    <div ref={setRow} className={`tb-row t-${b.type}`} data-id={b.id} data-checked={b.checked ? '' : undefined} style={{ ['--ind' as string]: b.indent }}>
      {!readOnly && (
        <div className="tb-gutter" contentEditable={false}>
          <button className="tb-add" aria-label="아래에 블록 추가" tabIndex={-1} onClick={() => ctx.onAdd(b)}>
            <Icon name="plus" size={14} />
          </button>
          <button className="tb-grip" aria-label="블록 옮기기·메뉴" tabIndex={-1} onPointerDown={(e) => ctx.onGrip(e, b)}>
            <Icon name="grip" size={14} />
          </button>
        </div>
      )}
      {marker}
      {b.type === 'divider' ? (
        <div ref={setRef} className="tb-divider" tabIndex={0} role="separator" aria-label="구분선" onKeyDown={(e) => ctx.onKey(e, b)}>
          <hr />
        </div>
      ) : (
        <div
          ref={setRef}
          className={'tb-text' + (b.type === 'code' ? ' is-code' : '')}
          contentEditable={!readOnly}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          data-placeholder={PLACEHOLDER[b.type]}
          spellCheck={b.type !== 'code'}
          onKeyDown={(e) => ctx.onKey(e, b)}
          onInput={(e) => ctx.onInput(e, b)}
          onPaste={(e) => ctx.onPaste(e, b)}
          onClick={ctx.onLinkClick}
        />
      )}
    </div>
  )
})

// ───────────────────────── 슬래시 메뉴 ─────────────────────────

function SlashMenu(props: { items: SlashItem[]; index: number; x: number; y: number; onPick: (it: SlashItem) => void; onHover: (i: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  // 화면 밖으로 나가지 않게
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    el.style.left = `${Math.max(8, Math.min(props.x, window.innerWidth - w - 8))}px`
    el.style.top = `${props.y + h > window.innerHeight - 8 ? Math.max(8, props.y - h - 34) : props.y}px`
  })
  useEffect(() => {
    ref.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' })
  }, [props.index])
  useEffect(() => {
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && props.onClose()
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [props.onClose])
  return (
    <div ref={ref} className="tdoc-slash" role="listbox" aria-label="블록 종류">
      {props.items.length ? (
        props.items.map((it, i) => (
          <button
            key={it.type}
            role="option"
            aria-selected={i === props.index}
            className={'tdoc-slash-item' + (i === props.index ? ' is-current' : '')}
            onPointerDown={(e) => e.preventDefault()} // 캐럿을 잃지 않게
            onPointerEnter={() => props.onHover(i)}
            onClick={() => props.onPick(it)}
          >
            <span className="tdoc-slash-glyph">{it.glyph}</span>
            <span className="tdoc-slash-text">
              <b>{it.label}</b>
              <small>{it.desc}</small>
            </span>
          </button>
        ))
      ) : (
        <p className="tdoc-slash-empty">맞는 블록이 없습니다</p>
      )}
    </div>
  )
}

// ───────────────────────── 서식 막대 (글자를 고르면) ─────────────────────────

type FormatCmd = 'bold' | 'italic' | 'underline' | 'strikeThrough' | 'code' | 'link'

function FormatBar({ onRun }: { onRun: (cmd: FormatCmd) => void }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection()
      const node = sel?.anchorNode
      const host = (node instanceof Element ? node : node?.parentElement)?.closest('.tb-text:not(.is-code)')
      if (!sel || sel.isCollapsed || !host || !host.contains(sel.focusNode)) return setPos(null)
      const r = sel.getRangeAt(0).getBoundingClientRect()
      setPos({ x: r.left + r.width / 2, y: r.top })
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [])
  if (!pos) return null
  const btn = (cmd: FormatCmd, label: string, glyph: React.ReactNode) => (
    <button key={cmd} className="tdoc-fmt-btn" aria-label={label} title={label} onPointerDown={(e) => e.preventDefault()} onClick={() => onRun(cmd)}>
      {glyph}
    </button>
  )
  return (
    <div className="tdoc-fmt" role="toolbar" aria-label="글자 서식" style={{ left: pos.x, top: pos.y }}>
      {btn('bold', '굵게', <b>B</b>)}
      {btn('italic', '기울임', <i>I</i>)}
      {btn('underline', '밑줄', <u>U</u>)}
      {btn('strikeThrough', '취소선', <s>S</s>)}
      {btn('code', '인라인 코드', <code>{'<>'}</code>)}
      {btn('link', '링크', <Icon name="link" size={15} />)}
    </div>
  )
}

/** 고른 글자를 <code>로 감싸거나(이미 code 안이면) 벗긴다 */
function toggleInlineCode(el: HTMLElement) {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return
  const range = sel.getRangeAt(0)
  const startEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  const code = startEl?.closest('code')
  if (code && el.contains(code)) {
    code.replaceWith(...code.childNodes)
    el.normalize()
    return
  }
  if (range.collapsed) return
  const frag = range.extractContents()
  const c = document.createElement('code')
  c.textContent = frag.textContent ?? ''
  range.insertNode(c)
  sel.removeAllRanges()
  const r = document.createRange()
  r.selectNodeContents(c)
  sel.addRange(r)
}
