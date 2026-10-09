import { useCallback, useEffect, useRef, useState } from 'react'
import { useUI } from '../../app/store'
import { askPdfPassword } from '../../app/dialogs'
import { Engine } from '../../engine/engine'
import { PdfCache } from '../../engine/pdf/pdfCache'
import { trackRecentDoc } from '../../shared/recentDocs'
import { recallPassword, rememberPassword } from '../../io/passwords'
import type { DocumentMeta, ID, Page } from '../../shared/model'
import { loadDocument, putThumbnail, removeThumbnail, saveBatch, saveLastView, updateDocument } from '../../storage/repo'
import { emitThumbsChanged, hasThumbnail } from '../../io/docThumb'
import { acquireDocLock, releaseDocLock } from '../../storage/tabLock'
import { SchemaTooNewError } from '../../storage/migrate'
import { ensureAssetLocal, onAssetProgress, setAssetDownloadGate } from '../../sync/assets'
import { confirmAssetDownload } from '../../sync/transfer'
import { clearPendingIfUnchanged } from '../../sync/unchanged'
import { CONFLICT_EVENT, REMOTE_EVENT } from '../../sync/sync'
import { VersionPanel } from './VersionPanel'
import { EditorToolbar } from './EditorToolbar'
import { FloatingToolbar } from './FloatingToolbar'
import { BlockLayer } from './BlockLayer'
import { PageSidebar } from './PageSidebar'
import { SelectionBar } from './SelectionBar'
import { PagePanel } from './PagePanel'
import { ExportPanel } from './ExportPanel'
import { SettingsPanel } from '../SettingsPanel'
import { SyncPanel } from '../SyncSection'
import { Hud } from '../Hud'
import { SPRING, dur } from '../motion/motion'
import { QuickSwitch } from '../QuickSwitch'
import { DebugPanel } from './DebugPanel'
import { Menu, MenuItem } from '../library/Library'

export function Editor({ docId }: { docId: ID }) {
  const hostRef = useRef<HTMLElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const [engine, setEngine] = useState<Engine | null>(null)
  const [doc, setDoc] = useState<DocumentMeta | null>(null)
  const [pages, setPages] = useState<Page[]>([])
  const [error, setError] = useState<string | null>(null)
  const [readOnly, setReadOnly] = useState(false)
  const [thumbTick, setThumbTick] = useState(0)
  const [fetching, setFetching] = useState<{ loaded: number; total: number | null } | null>(null)
  const navigate = useUI((s) => s.navigate)
  const toast = useUI((s) => s.toast)
  const settings = useUI((s) => s.settings)
  const style = useUI((s) => s.style)
  const tool = useUI((s) => s.tool)
  const panel = useUI((s) => s.panel)
  const sidebar = useUI((s) => s.sidebar)

  // 최근 열람 기록 — 라이브러리 '전체'를 다시 누를 때 최근 열람한 노트를 보여 주는 데 쓴다
  useEffect(() => trackRecentDoc(docId), [docId])

  // 노트 열림 애니메이션 — 라이브러리가 만든 열기 고스트(.doc-open-ghost)가 카드에서
  // 편집 화면으로 펼쳐지는 동안은 가리고 있다가, 고스트가 자리 잡은 뒤 드러난다.
  // (모션 최소화 설정이면 생략 — 카드 없이 열 때는 조용히 페이드업)
  useEffect(() => {
    const el = rootRef.current
    if (!el || document.documentElement.dataset.motion === 'off') return
    const rect = useUI.getState().docCardRect
    useUI.setState({ docCardRect: null })
    if (!rect) {
      el.classList.add('doc-enter') // 카드 없이 열 때(딥링크·새 문서 만들기)는 조용히 페이드업
      return
    }
    el.style.opacity = '0'
    const showT = window.setTimeout(() => {
      el.style.transition = `opacity ${dur(240)}ms ease`
      el.style.opacity = '1'
    }, dur(400))
    const cleanT = window.setTimeout(() => {
      el.style.transition = ''
      el.style.opacity = ''
    }, dur(800))
    return () => {
      window.clearTimeout(showT)
      window.clearTimeout(cleanT)
    }
  }, [])

  // 엔진 생성 / 해제
  useEffect(() => {
    let disposed = false
    let eng: Engine | null = null
    const pdf = new PdfCache()
    pdf.passwordProvider = async (assetId, incorrect) => {
      const known = !incorrect ? recallPassword(assetId) : undefined
      if (known) return known
      const pw = await askPdfPassword(incorrect)
      if (pw) rememberPassword(assetId, pw)
      return pw
    }
    // 원본(PDF·이미지)은 이 기기에 없으면 그때 받아온다 (지연 로딩).
    // "받기"는 메타데이터만 받으므로 메타만 있는 노트는 여기서 원본을 내려받는다 —
    // 네트워크를 쓰기 전에 큰 파일 전송 전 확인과 같은 기준으로 한 번 묻는다 (11.5).
    setAssetDownloadGate(async ({ kind, bytes }) => {
      const ok = await confirmAssetDownload(bytes, kind)
      if (!ok) useUI.getState().toast('원본 내려받기를 취소했습니다. 이 기기에 원본이 없어 PDF를 표시하지 못합니다.', 'info')
      return ok
    })
    pdf.assetProvider = (assetId) => ensureAssetLocal(assetId)
    pdf.onAssetError = (_assetId, message) => useUI.getState().toast(message, 'error')
    ;(async () => {
      // 뷰어보드 의도(1회) — 읽기 전용 판정은 acquireDocLock 한 곳으로 합쳐진다 (탭 충돌과 같은 경로)
      const wantView = useUI.getState().viewOnly
      if (wantView) useUI.setState({ viewOnly: false })
      try {
        const [loaded, lock] = await Promise.all([loadDocument(docId), acquireDocLock(docId, { readOnly: wantView })])
        if (disposed) return
        if (!lock) {
          setReadOnly(true)
          if (!wantView) toast('이 문서는 다른 탭에서 열려 있어 읽기 전용으로 엽니다.', 'info')
        }
        setDoc(loaded.doc)
        setPages(loaded.pages)
        const st = useUI.getState()
        eng = new Engine(hostRef.current!, {
          settings: st.settings,
          style: st.style,
          doc: loaded,
          pdf,
          readOnly: !lock,
          persist: async (b) => {
            await saveBatch(b)
            // 되돌리기(실행 취소)로 내용이 마지막 동기화 시점으로 돌아왔으면 '올리기 필요'를 내린다
            if (b.viaUndo) await clearPendingIfUnchanged(b.documentId)
          },
          callbacks: {
            onStats: (s) => useUI.setState({ stats: s }),
            onView: (v) => useUI.setState({ view: v }),
            onSelection: (s) => useUI.setState({ selection: s }),
            onSaveState: (s, err) => {
              useUI.setState({ saveState: s })
              if (s === 'error') {
                const quota = (err as DOMException)?.name === 'QuotaExceededError'
                useUI
                  .getState()
                  .toast(quota ? '기기 저장 공간이 부족합니다. 설정 > 저장소에서 공간을 확인하세요.' : '저장하지 못했습니다. 잠시 후 다시 시도합니다.', 'error')
              }
            },
            onPressureCapability: (c) => {
              useUI.getState().setSettings({ pressureCapability: c })
              if (c === 'no' && useUI.getState().settings.pressureMode === 'auto') {
                const fb = useUI.getState().settings.fallbackMode === 'velocity' ? '속도 기반' : '일정한 굵기'
                useUI.getState().toast(`이 펜은 필압을 보내지 않습니다. ${fb}으로 그립니다. (설정 > 펜 · 필압에서 변경)`, 'info')
              }
            },
            onPagesChanged: (p) => setPages(p),
            onPageContentChanged: () => setThumbTick((t) => t + 1)
          }
        })
        eng.setTool(st.tool)
        engineRef.current = eng
        setEngine(eng)
        ;(window as unknown as { inkpad: Engine }).inkpad = eng
      } catch (e) {
        if (disposed) return
        setError(e instanceof SchemaTooNewError ? e.message : e instanceof Error ? e.message : '문서를 열 수 없습니다.')
      }
    })()
    return () => {
      disposed = true
      setAssetDownloadGate(null)
      const e = eng
      engineRef.current = null
      setEngine(null)
      useUI.setState({ selection: null, stats: null })
      releaseDocLock(docId)
      if (e) {
        const view = e.getViewState()
        void (async () => {
          await e.destroy()
          await saveLastView(docId, view)
          // 미리보기는 로컬 전용(동기화 대상 아님)이라 여기서 항상 다시 만든다.
          // 편집이 없어도(다른 기기에서 받아 처음 연 경우 등) 이 기기의 미리보기를 채운다.
          // 비어 있던 미리보기를 채우는 경우에만 진행/완료 토스트를 띄운다(평소엔 조용히 갱신).
          const had = await hasThumbnail(docId)
          const sticky = had ? null : useUI.getState().toast('미리보기를 만드는 중…', 'info', undefined, { sticky: true })
          // null = 그릴 게 없음(빈 첫 페이지·원본 미확보), 'error' = 그리다가 실패.
          // 실패가 아닌 빈 결과인데 옛 미리보기가 남아 있으면 지운다 — 흰 사진 카드 대신 아이콘이 보이게.
          const blob = await e.renderDocThumb().catch(() => 'error' as const)
          if (sticky !== null) useUI.getState().dismissToast(sticky)
          if (blob instanceof Blob) {
            await putThumbnail(docId, blob)
            emitThumbsChanged()
            if (!had) useUI.getState().toast('미리보기를 만들었습니다.', 'success')
          } else if (blob !== 'error' && had) {
            await removeThumbnail(docId)
            emitThumbsChanged()
          }
          await pdf.destroy()
        })()
      } else void pdf.destroy()
    }
  }, [docId, toast])

  useEffect(() => engineRef.current?.setSettings(settings), [settings])
  useEffect(() => engineRef.current?.setStyle(style), [style])
  useEffect(() => engineRef.current?.setTool(tool), [tool])

  // 원본 지연 로딩 진행률
  useEffect(() => {
    const off = onAssetProgress((e) => setFetching(e.done ? null : { loaded: e.loaded, total: e.total }))
    return () => {
      off()
      setFetching(null)
    }
  }, [])

  // 키보드 단축키 (Magic Keyboard 등)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const eng = engineRef.current
      if (!eng) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) eng.redo()
        else eng.undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        eng.redo()
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && useUI.getState().selection) {
        e.preventDefault()
        eng.deleteSelection()
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && useUI.getState().selectedBlockId && !useUI.getState().selection) {
        // 블록이 선택된 상태에서의 삭제 (엔진 획 선택이 없을 때만)
        e.preventDefault()
        eng.deleteBlock(useUI.getState().selectedBlockId!)
        useUI.setState({ selectedBlockId: null })
      } else if (e.key === 'Escape') {
        eng.clearSelection()
        useUI.setState({ selectedBlockId: null, placingBlock: null })
      } else if (!mod) {
        const map: Record<string, 'pen' | 'highlighter' | 'eraser' | 'lasso'> = { p: 'pen', h: 'highlighter', e: 'eraser', l: 'lasso' }
        const tl = map[e.key.toLowerCase()]
        if (tl) useUI.getState().setTool(tl)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 다른 기기에서 이 문서가 변경되면 바로 덮어쓰지 않고 안내한다 (SDF 가이드 8장 3)
  useEffect(() => {
    const onRemote = (ev: Event) => {
      const ids = (ev as CustomEvent<Set<string>>).detail
      if (!ids?.has(docId)) return
      toast('다른 기기에서 이 문서가 변경되었습니다.', 'info', {
        label: '다시 불러오기',
        run: () => {
          navigate({ name: 'library' })
          setTimeout(() => navigate({ name: 'editor', docId }), 0)
        }
      })
    }
    window.addEventListener(REMOTE_EVENT, onRemote)
    return () => window.removeEventListener(REMOTE_EVENT, onRemote)
  }, [docId, navigate, toast])

  // 다른 기기와 충돌했을 때: 이 기기의 편집은 버전 기록에 보존되고, 문서는 다른 기기 버전으로 맞춰진다
  useEffect(() => {
    const onConflict = (ev: Event) => {
      const detail = (ev as CustomEvent<{ docId: string }>).detail
      if (detail?.docId !== docId) return
      toast('다른 기기 버전으로 맞췄어요. 내 편집은 버전 기록에 있어요.', 'info', {
        label: '버전 기록',
        run: () => useUI.getState().setPanel('history')
      })
    }
    window.addEventListener(CONFLICT_EVENT, onConflict)
    return () => window.removeEventListener(CONFLICT_EVENT, onConflict)
  }, [docId, toast])

  const rename = useCallback(
    async (title: string) => {
      if (!doc || !title.trim() || title === doc.title) return
      await updateDocument(doc.id, { title: title.trim() })
      setDoc({ ...doc, title: title.trim() })
    },
    [doc]
  )

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

  const paged = doc?.mode === 'paged'

  return (
    <div className="editor" ref={rootRef}>
      <EditorToolbar engine={engine} doc={doc} readOnly={readOnly} onRename={rename} onBack={() => { useUI.setState({ returnDocId: docId }); navigate({ name: 'library' }) }} />
      <div className="editor-body">
        {paged && sidebar && engine && <PageSidebar engine={engine} pages={pages} tick={thumbTick} />}
        <div className="editor-area">
          <main id="canvas-root" className="canvas-root" ref={hostRef} data-mode={doc?.mode} />
          {engine && <BlockLayer engine={engine} readOnly={readOnly} />}
          {!engine && (
            <div className="doc-skeleton" role="status" aria-label="문서 여는 중">
              <span className="doc-skeleton-paper" />
            </div>
          )}
          {fetching && (
            <div className="loading">
              원본 받는 중… {fmtBytes(fetching.loaded)}
              {fetching.total ? ` / ${fmtBytes(fetching.total)}` : ''}
            </div>
          )}
          <Hud />
          {!readOnly && <FloatingToolbar engine={engine} />}
          {!readOnly && <QuickSwitch />}
          {engine && <SelectionBar engine={engine} />}
          {engine && <PageIndicator engine={engine} paged={paged} />}
          {panel === 'settings' && <SettingsPanel />}
          {panel === 'sync' && <SyncPanel />}
          {panel === 'page' && engine && <PagePanel engine={engine} doc={doc!} />}
          {panel === 'export' && engine && doc && <ExportPanel engine={engine} doc={doc} />}
          {panel === 'history' && <VersionPanel docId={docId} />}
          {panel === 'debug' && engine && <DebugPanel engine={engine} />}
        </div>
      </div>
    </div>
  )
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

function PageIndicator({ engine, paged }: { engine: Engine; paged: boolean }) {
  const view = useUI((s) => s.view)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  return (
    <div className="page-indicator">
      {paged && (
        <span>
          <b key={view.currentPage} className="page-num-roll">
            {view.currentPage + 1}
          </b>{' '}
          / {view.pageCount}
        </span>
      )}
      {/* 누르면 보기 메뉴 — 무엇이 초기화되는지 글자로 보여 준다 (C-4). 엔진에 있는 동작만 넣는다. */}
      <button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setMenu((m) => (m ? null : { x: r.right, y: r.bottom }))
        }}
        aria-label="보기 옵션"
        aria-haspopup="menu"
        aria-expanded={!!menu}
      >
        {Math.round(view.zoom * 100)}%
      </button>
      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem
            icon="fit"
            label={paged ? '폭 맞춤' : '원점으로 (100%)'}
            onClick={() => {
              setMenu(null)
              engine.resetView()
            }}
          />
          <MenuItem
            icon="grid"
            label="전체 보기"
            onClick={() => {
              setMenu(null)
              engine.fitAll()
            }}
          />
        </Menu>
      )}
    </div>
  )
}
