import { useCallback, useEffect, useRef, useState } from 'react'
import { useUI } from '../../app/store'
import { askPdfPassword } from '../../app/dialogs'
import { Engine } from '../../engine/engine'
import { PdfCache } from '../../engine/pdf/pdfCache'
import { trackRecentDoc } from '../../shared/recentDocs'
import { formatBytesShort } from '../../shared/util'
import { recallPassword, rememberPassword } from '../../io/passwords'
import type { DocumentMeta, ID, Page } from '../../shared/model'
import { loadDocument, putThumbnail, removeThumbnail, saveBatch, saveLastView, updateDocument } from '../../storage/repo'
import { emitThumbsChanged, hasThumbnail } from '../../io/docThumb'
import { acquireDocLock, releaseDocLock } from '../../storage/tabLock'
import { registerOpenDoc, whenDocIdle } from '../../storage/docGuard'
import { SchemaTooNewError } from '../../storage/migrate'
import { ensureAssetLocal, onAssetProgress, setAssetDownloadGate } from '../../sync/assets'
import { confirmAssetDownload } from '../../sync/transfer'
import { scheduleUnchangedCheck } from '../../sync/unchanged'
import { CONFLICT_EVENT, REMOTE_EVENT, type MergeEventDetail } from '../../sync/sync'
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
  /** 편집 잠금 결과 — 'pending'(확인 중) · 'edit'(이 탭이 편집) · 'read'(다른 탭이 편집 중이거나 뷰어로 엶) */
  const [access, setAccess] = useState<'pending' | 'edit' | 'read'>('pending')
  const accessRef = useRef(access)
  accessRef.current = access
  const readOnly = access === 'read' // 확인 중(pending)에는 예전처럼 편집 도구를 그대로 보인다
  /** 올리면 엔진을 내리고 DB에서 다시 연다 (동기화가 이 노트를 바꾼 뒤) */
  const [epoch, setEpoch] = useState(0)
  /** 동기화가 이 노트를 바꾸는 동안 엔진을 내려 둔다 (storage/docGuard) */
  const [suspended, setSuspended] = useState(false)
  /** 직전 엔진의 정리(마지막 기록·보던 위치 저장)가 끝나는 시점 — 다음 엔진은 이걸 기다린 뒤 DB를 읽는다 */
  const engineGone = useRef<Promise<void>>(Promise.resolve())
  /** 이번 엔진 정리에서 카드 미리보기를 건너뛴다 (다시 열기·동기화 중에는 다시 만들 필요가 없다) */
  const skipThumb = useRef(false)
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

  // 편집 잠금 — 노트를 연 동안 쥐고 있는다. 엔진을 다시 만들어도(동기화 뒤 다시 열기) 놓지 않는다.
  useEffect(() => {
    let alive = true
    // 뷰어보드 의도(1회) — 읽기 전용 판정은 acquireDocLock 한 곳으로 합쳐진다 (탭 충돌과 같은 경로)
    const wantView = useUI.getState().viewOnly
    if (wantView) useUI.setState({ viewOnly: false })
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
      // 엔진이 마지막 변경을 다 기록한 뒤에 놓는다 — 먼저 놓으면 다른 탭이 덜 기록된 노트를 편집으로 연다.
      // (엔진 정리는 아래 effect의 cleanup이 같은 커밋에서 engineGone에 걸어 둔다)
      void Promise.resolve()
        .then(() => engineGone.current)
        .finally(() => releaseDocLock(docId))
    }
  }, [docId, toast])

  // 엔진 생성 / 해제 — 잠금 결과가 나온 뒤, 그리고 다시 열 때(epoch)마다
  useEffect(() => {
    if (access === 'pending' || suspended) return
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
    // 네트워크를 쓰기 전에 큰 파일 전송 전 확인과 같은 기준으로 한 번 묻는다 (sync/transfer).
    setAssetDownloadGate(async ({ kind, bytes }) => {
      const ok = await confirmAssetDownload(bytes, kind)
      if (!ok) useUI.getState().toast('원본 내려받기를 취소했습니다. 이 기기에 원본이 없어 PDF를 표시하지 못합니다.', 'info')
      return ok
    })
    pdf.assetProvider = (assetId) => ensureAssetLocal(assetId)
    pdf.onAssetError = (_assetId, message) => useUI.getState().toast(message, 'error')
    ;(async () => {
      try {
        await engineGone.current // 직전 엔진이 마지막 변경을 기록할 때까지
        await whenDocIdle(docId) // 동기화가 이 노트를 바꾸는 중이면 끝날 때까지
        if (disposed) return
        const loaded = await loadDocument(docId)
        if (disposed) return
        setDoc(loaded.doc)
        setPages(loaded.pages)
        const st = useUI.getState()
        eng = new Engine(hostRef.current!, {
          settings: st.settings,
          style: st.style,
          doc: loaded,
          pdf,
          readOnly: access !== 'edit',
          persist: async (b) => {
            await saveBatch(b)
            // 되돌리기(실행 취소)로 내용이 마지막 동기화 시점으로 돌아왔으면 '올리기 필요'를 내린다 —
            // 저장마다 노트 전체를 비교하지 않고, 되돌리기가 멈춘 뒤 한 번만 본다 (저장 흐름을 막지 않는다)
            if (b.viaUndo) scheduleUnchangedCheck(b.documentId)
          },
          callbacks: {
            // 성능 통계는 성능 표시(HUD)만 읽는다 — 꺼져 있으면 전역 상태를 0.5초마다 바꾸지 않는다
            onStats: (s) => {
              if (useUI.getState().settings.showHud) useUI.setState({ stats: s })
            },
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
        // 개발 중 콘솔에서 엔진을 만지기 위한 통로 — 배포본에는 내보내지 않는다
        if (import.meta.env.DEV) (window as unknown as { inkpad: Engine }).inkpad = eng
      } catch (e) {
        if (disposed) return
        setError(e instanceof SchemaTooNewError ? e.message : e instanceof Error ? e.message : '문서를 열 수 없습니다.')
      }
    })()
    return () => {
      disposed = true
      setAssetDownloadGate(null)
      const e = eng
      const makeThumb = !skipThumb.current
      skipThumb.current = false
      engineRef.current = null
      setEngine(null)
      useUI.setState({ selection: null, stats: null })
      if (e) {
        const view = e.getViewState()
        engineGone.current = (async () => {
          await e.destroy()
          await saveLastView(docId, view)
          if (!makeThumb) return void (await pdf.destroy())
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
        })().catch((err) => console.warn('[editor] 편집 화면 정리 중 오류', err))
      } else void pdf.destroy()
    }
  }, [docId, access, epoch, suspended])

  // 노트 보호 등록 (storage/docGuard) — 동기화·버전 되돌리기가 이 노트를 바꿀 때 먼저 멈추고 뒤에 다시 연다.
  // 쓰기 가능한 편집 화면만 등록한다. 읽기 전용은 기록할 것이 없고, 원격 변경 알림으로 다시 연다(아래).
  useEffect(() => {
    if (access !== 'edit') return
    return registerOpenDoc(docId, {
      flush: async () => {
        await engineRef.current?.flush()
      },
      suspend: async () => {
        const e = engineRef.current
        if (e) {
          try {
            await e.freeze()
          } catch (err) {
            e.unfreeze() // 기록하지 못했다 — 편집을 돌려주고 동기화는 이 노트를 건너뛴다
            throw err
          }
        }
        skipThumb.current = true
        setSuspended(true)
      },
      resume: () => {
        setSuspended(false)
        setEpoch((n) => n + 1) // suspended가 한 번도 그려지지 않았어도 엔진을 다시 만들게 한다
      }
    })
  }, [docId, access])

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

  // 이 노트가 동기화·되돌리기로 바뀌었을 때.
  // 쓰기 가능한 편집 화면은 노트 보호(docGuard)가 이미 멈췄다가 다시 열었으므로 할 일이 없다.
  // 읽기 전용(다른 탭이 편집 중이거나 뷰어로 연 경우)은 쓰지 않으니 바뀐 내용으로 그냥 다시 연다.
  useEffect(() => {
    const onRemote = (ev: Event) => {
      const ids = (ev as CustomEvent<Set<string>>).detail
      if (!ids?.has(docId) || accessRef.current !== 'read') return
      skipThumb.current = true
      setEpoch((n) => n + 1)
      toast('이 노트의 바뀐 내용을 다시 불러왔습니다.', 'info')
    }
    window.addEventListener(REMOTE_EVENT, onRemote)
    return () => window.removeEventListener(REMOTE_EVENT, onRemote)
  }, [docId, toast])

  // 머지했을 때: 어느 쪽을 우선했는지와 머지 전 모습이 어디 있는지 알린다
  useEffect(() => {
    const onConflict = (ev: Event) => {
      const d = (ev as CustomEvent<MergeEventDetail>).detail
      if (d?.docId !== docId) return
      const history = { label: '버전 기록', run: () => useUI.getState().setPanel('history') }
      if (d.baseless) toast('동기화 기록이 없어 양쪽 필기를 모두 남겨 합쳤어요. 머지 전 모습은 버전 기록에 있어요.', 'info', history)
      else if (d.conflicts > 0)
        toast(
          `겹친 ${d.conflicts}곳은 ${d.decision === 'ours' ? '이 기기' : '다른 기기'} 내용으로 합쳤어요. 머지 전 모습은 버전 기록에 있어요.`,
          'info',
          history
        )
      else toast('다른 기기의 변경과 합쳤어요.', 'success')
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
      <EditorToolbar engine={engine} doc={doc} readOnly={readOnly} onRename={rename} onBack={() => { useUI.setState({ returnDocId: docId }); navigate(useUI.getState().returnRoute ?? { name: 'library' }) }} />
      <div className="editor-body">
        {paged && sidebar && engine && <PageSidebar engine={engine} pages={pages} tick={thumbTick} />}
        <div className="editor-area">
          <main id="canvas-root" className="canvas-root" ref={hostRef} data-mode={doc?.mode} />
          {engine && <BlockLayer engine={engine} readOnly={readOnly} />}
          {!engine && (
            <div className="doc-skeleton" role="status" aria-label={suspended ? '동기화로 노트를 맞추는 중' : '문서 여는 중'}>
              <span className="doc-skeleton-paper" />
            </div>
          )}
          {fetching && (
            <div className="loading">
              원본 받는 중… {formatBytesShort(fetching.loaded)}
              {fetching.total ? ` / ${formatBytesShort(fetching.total)}` : ''}
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
      {/* 누르면 보기 메뉴 — 무엇이 초기화되는지 글자로 보여 준다. 엔진에 있는 동작만 넣는다. */}
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
