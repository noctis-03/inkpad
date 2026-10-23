// 머지 화면 — main과 기기 브랜치 하나를 레이어로 나눠 보여 주고, 사용자가 고른 대로 최종 머지한다
// (설계: docs/branch-merge.md §5). 패드(펜·손가락)와 컴퓨터(마우스·키보드)에서 똑같이 쓴다.
//
// 레이어: 원래 있던 내용(공통) / main에만 / 브랜치에만 / 양쪽에서 내용이 다름. 기본은 모두 살리기(머지에는 삭제가 없다).
// 도구는 강조한 레이어(없으면 보이는 레이어 전부)에만 닿는다: 올가미로 골라 옮기기·버리기·살리기·색·다른 쪽 버전,
// 지우개로 버리기. 한 일은 작업본에만 쌓이고(되돌리기·다시 가능, 이 기기에 저장), '최종 머지'를 눌러야 main이 바뀐다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { PEN_COLORS, PEN_COLOR_NAMES, useUI } from '../../app/store'
import { confirmDialog } from '../../app/dialogs'
import { Icon } from '../Icon'
import { Segmented } from '../Segmented'
import { closePdf, type PDFDocumentProxy } from '../../engine/pdf/pdfjs'
import { formatDate } from '../../shared/util'
import type { ID, Stroke } from '../../shared/model'
import { commitMerge, listMergeQueue, MergeStaleError, openMerge, pushBeforeMerge, type MergeQueueEntry, type MergeSession } from '../../sync/sync'
import { deleteMergeDraft, loadMergeDraft, saveMergeDraft } from '../../sync/mergeDraft'
import {
  compose,
  emptyDraft,
  isEmptyDraft,
  resolveItem,
  resolveMeta,
  retainDraft,
  type ItemClass,
  type MergeDraft,
  type MergeItem,
  type MetaItem,
  type Placed,
  type Side
} from '../../sync/merge'
import { LAYER_COLOR, PageCanvas, buildPages, type CanvasProps, type Selection, type Tool, type ViewPage, type Visible } from './MergeCanvas'

/** 최종 머지가 끝났을 때 — 동기화 패널이 목록을 다시 읽는다 */
export const MERGE_DONE_EVENT = 'inkpad-merge-done'

const useMergeView = create<{ entry: MergeQueueEntry | null }>(() => ({
  entry: null
}))
export const openMergeView = (entry: MergeQueueEntry) => useMergeView.setState({ entry })
const closeMergeView = () => {
  useMergeView.setState({ entry: null })
  window.dispatchEvent(new Event(MERGE_DONE_EVENT)) // 작업본 표시('작업 중')가 바뀌었을 수 있다
}

const toast = (text: string, kind: 'info' | 'success' | 'error' = 'success') => useUI.getState().toast(text, kind)
const errText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

/** App이 한 번 그린다 — 열린 머지가 있으면 전체 화면으로 */
export function MergeHost() {
  const entry = useMergeView((s) => s.entry)
  return entry ? <MergeView key={entry.docId + '@' + entry.deviceId} entry={entry} /> : null
}

const LAYERS: ItemClass[] = ['common', 'mainOnly', 'branchOnly', 'modified']
const ZOOMS = [1, 1.5, 2, 3]

const pick = <T,>(item: MergeItem, side: Side): T => (side === 'main' ? (item.main ?? item.branch) : (item.branch ?? item.main)) as T

/** 작업본을 고쳐 새 작업본을 만든다 (Set·Map은 복사해서 — 되돌리기가 옛 작업본을 그대로 들고 있게) */
function edit(d: MergeDraft, fn: (n: MergeDraft) => void): MergeDraft {
  const n: MergeDraft = {
    discard: new Set(d.discard),
    flip: new Set(d.flip),
    move: new Map(d.move),
    color: new Map(d.color)
  }
  fn(n)
  return n
}

function MergeView({ entry }: { entry: MergeQueueEntry }) {
  const [session, setSession] = useState<MergeSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('불러오는 중…')
  const [draft, setDraftRaw] = useState<MergeDraft>(emptyDraft)
  const [past, setPast] = useState<MergeDraft[]>([])
  const [future, setFuture] = useState<MergeDraft[]>([])
  const [visible, setVisible] = useState<Visible>({
    common: true,
    mainOnly: true,
    branchOnly: true,
    modified: true
  })
  const [focus, setFocus] = useState<ItemClass | null>(null)
  const [resultOnly, setResultOnly] = useState(false)
  const [outline, setOutline] = useState(true)
  const [busy, setBusy] = useState(false)
  const [panelOpen, setPanelOpen] = useState(true)
  const [tool, setTool] = useState<Tool>('view')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [zoom, setZoom] = useState(1)
  const fingerTool = useUI((s) => s.settings.fingerDraw)
  const pdfs = useRef(new Map<ID, Promise<PDFDocumentProxy | null>>())

  /** 지금 작업본 — 한 틱에 여러 번 바꿔도 앞의 바꿈 위에 쌓이게 상태와 따로 든다 */
  const draftRef = useRef(draft)
  draftRef.current = draft
  /** 작업본 바꾸기 — 되돌리기 줄에 앞 상태를 쌓는다 */
  const apply = useCallback((next: MergeDraft | ((d: MergeDraft) => MergeDraft)) => {
    const cur = draftRef.current
    const n = typeof next === 'function' ? next(cur) : next
    if (n === cur) return
    draftRef.current = n
    setPast((p) => [...p.slice(-99), cur])
    setFuture([])
    setDraftRaw(n)
  }, [])
  const undo = () => {
    if (!past.length) return
    setFuture((f) => [draft, ...f])
    setDraftRaw(past[past.length - 1])
    setPast((p) => p.slice(0, -1))
  }
  const redo = () => {
    if (!future.length) return
    setPast((p) => [...p, draft])
    setDraftRaw(future[0])
    setFuture((f) => f.slice(1))
  }

  /** 머지할 것을 연다. refind면 목록에서 같은 노트·같은 기기 브랜치를 다시 찾는다(그 사이 올라온 새 판). keep은 이어 쓸 작업본 */
  const load = useCallback(
    async (opts: { refind?: boolean; keep?: MergeDraft } = {}) => {
      setSession(null)
      setError(null)
      setSelection(null)
      try {
        setStatus('이 기기 변경을 먼저 올리는 중…')
        const pushed = await pushBeforeMerge(entry.docId) // 이 기기의 올리지 않은 변경이 머지에 들어가게
        let target: MergeQueueEntry | undefined = entry
        if (pushed || opts.refind) {
          setStatus('머지할 것을 다시 확인하는 중…')
          target = (await listMergeQueue()).find((e) => e.docId === entry.docId && e.deviceId === entry.deviceId)
        }
        if (!target) {
          toast('이 노트는 이제 머지할 것이 없습니다.', 'info')
          await deleteMergeDraft(entry.docId, entry.deviceId)
          closeMergeView()
          return
        }
        setStatus('클라우드에서 양쪽 내용을 받는 중…')
        const s = await openMerge(target)
        // 이어 쓸 작업본 — 방금 쓰던 것(다시 불러오기), 아니면 이 기기에 저장해 둔 것
        let start = opts.keep ?? null
        if (!start) {
          const saved = await loadMergeDraft(entry.docId, entry.deviceId)
          if (saved) {
            start = saved.draft
            const changed = saved.mainMid !== s.mainMid || saved.branchSeq !== s.branch.branch.seq
            toast(changed ? '저장해 둔 작업본을 그 사이 올라온 새 내용에 다시 얹었습니다.' : '저장해 둔 작업본을 이어서 엽니다.', 'info')
          }
        }
        setDraftRaw(start ? retainDraft(start, s.plan) : emptyDraft())
        setPast([])
        setFuture([])
        setSession(s)
      } catch (e) {
        setError(errText(e, '머지할 내용을 불러오지 못했습니다.'))
      }
    },
    [entry]
  )
  useEffect(() => {
    void load()
  }, [load])

  // 작업본은 이 기기에 저장한다 — 화면을 닫거나 앱이 꺼져도 이어서 한다
  useEffect(() => {
    if (!session) return
    const t = setTimeout(() => {
      void saveMergeDraft(entry.docId, entry.deviceId, { mainMid: session.mainMid, branchSeq: session.branch.branch.seq }, draft).catch((e) =>
        console.warn('[merge] 작업본 저장 실패:', e)
      )
    }, 300)
    return () => clearTimeout(t)
  }, [draft, session, entry])

  // PDF 문서는 이 화면에서만 열어 두고, 닫을 때 정리한다
  useEffect(() => {
    const map = pdfs.current
    return () => {
      for (const p of map.values()) void p.then((d) => closePdf(d)).catch(() => {})
      map.clear()
    }
  }, [])

  const pages = useMemo(() => (session ? buildPages(session, draft, resultOnly) : []), [session, draft, resultOnly])
  const result = useMemo(() => (session ? compose(session.main, session.branch, session.plan, draft) : null), [session, draft])
  const resultStrokes = result ? result.chunks.reduce((n, c) => n + c.elements.length, 0) : 0
  const itemByKey = useMemo(() => new Map((session?.plan.items ?? []).map((i) => [i.key, i])), [session])

  const mainName = `main · ${entry.mainDevice ?? '클라우드'}`
  const branchName = `${entry.device} 브랜치`
  const sideName = (s: Side) => (s === 'main' ? mainName : branchName)

  // ── 레이어 단위 ──
  const itemsOf = (cls: ItemClass) => session?.plan.items.filter((i) => i.cls === cls) ?? []
  const toggleDiscardLayer = (cls: ItemClass) =>
    apply((d) => {
      const keys = itemsOf(cls).map((i) => i.key)
      const all = keys.length > 0 && keys.every((k) => d.discard.has(k))
      return edit(d, (n) => keys.forEach((k) => (all ? n.discard.delete(k) : n.discard.add(k))))
    })
  const toggleDiscard = (key: string) => apply((d) => edit(d, (n) => (n.discard.has(key) ? n.discard.delete(key) : n.discard.add(key))))
  /** 고친 항목 전체를 한쪽으로 — 'auto'는 기본 규칙(한쪽만 고침 → 고친 쪽, 양쪽 → 머지하는 기기 쪽) */
  const setModifiedSide = (to: 'auto' | Side) =>
    apply((d) =>
      edit(d, (n) => {
        for (const i of itemsOf('modified')) {
          if (to === 'auto' || i.pick === to) n.flip.delete(i.key)
          else n.flip.add(i.key)
        }
      })
    )
  const modifiedMode = (): 'auto' | Side => {
    const mods = itemsOf('modified')
    if (!mods.length || mods.every((i) => !draft.flip.has(i.key))) return 'auto'
    if (mods.every((i) => resolveItem(i, draft).side === 'main')) return 'main'
    if (mods.every((i) => resolveItem(i, draft).side === 'branch')) return 'branch'
    return 'auto'
  }
  const setMetaSide = (m: MetaItem, side: Side) => apply((d) => edit(d, (n) => (side === m.pick ? n.flip.delete(m.key) : n.flip.add(m.key))))

  // ── 도구 ──
  const editable = useCallback((item: MergeItem) => visible[item.cls] && (!focus || item.cls === focus), [visible, focus])
  const selKeys = selection ? [...selection.keys] : []
  const selItems = selKeys.map((k) => itemByKey.get(k)).filter((i): i is MergeItem => !!i)
  const discardSelected = () => {
    const keys = selItems.filter((i) => i.cls !== 'common').map((i) => i.key)
    if (keys.length < selItems.length) toast('원래 있던 획은 버릴 수 없어 빼고 버렸습니다 (머지에는 삭제가 없다).', 'info')
    if (keys.length) apply((d) => edit(d, (n) => keys.forEach((k) => n.discard.add(k))))
  }
  const restoreSelected = () => apply((d) => edit(d, (n) => selKeys.forEach((k) => n.discard.delete(k))))
  const flipSelected = () => {
    const mods = selItems.filter((i) => i.cls === 'modified')
    if (!mods.length) return toast('고른 획 중에 양쪽에서 내용이 다른 획이 없습니다.', 'info')
    apply((d) => edit(d, (n) => mods.forEach((i) => (n.flip.has(i.key) ? n.flip.delete(i.key) : n.flip.add(i.key)))))
  }
  const colorSelected = (hex: string) =>
    apply((d) =>
      edit(d, (n) => {
        for (const i of selItems) {
          const el = pick<Placed>(i, resolveItem(i, d).side).el
          if (el.type !== 'stroke') continue
          const orig = (el as Stroke).color
          n.color.set(i.key, hex.slice(0, 7) + (orig.length === 9 ? orig.slice(7) : 'ff')) // 형광펜의 투명도는 그대로
        }
      })
    )
  const canvasHandlers: Pick<CanvasProps, 'onSelect' | 'onMove' | 'onErase'> = {
    onSelect: (pageId, keys) => setSelection(keys.length ? { pageId, keys: new Set(keys) } : null),
    onMove: (keys, dx, dy) =>
      apply((d) =>
        edit(d, (n) => {
          for (const k of keys) {
            const m = n.move.get(k) ?? { dx: 0, dy: 0 }
            n.move.set(k, { dx: m.dx + dx, dy: m.dy + dy })
          }
        })
      ),
    onErase: (keys) => {
      const items = keys.map((k) => itemByKey.get(k)).filter((i): i is MergeItem => !!i)
      const ok = items.filter((i) => i.cls !== 'common').map((i) => i.key)
      if (ok.length < items.length) toast('원래 있던 획은 지울 수 없습니다 — 머지에는 삭제가 없습니다. 머지 뒤 지우고 올려 주세요.', 'info')
      if (ok.length) apply((d) => edit(d, (n) => ok.forEach((k) => n.discard.add(k))))
    }
  }
  const chooseTool = (t: Tool) => {
    setTool(t)
    if (t !== 'lasso') setSelection(null)
  }

  // ── 변경 있는 페이지로 이동 ──
  const pageRefs = useRef(new Map<ID, HTMLElement>())
  const [cursor, setCursor] = useState(-1)
  const changed = pages.filter((p) => p.changes > 0)
  const jump = (dir: 1 | -1) => {
    if (!changed.length) return
    const next = (cursor + dir + changed.length) % changed.length
    setCursor(next)
    pageRefs.current.get(changed[next].id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // ── 최종 머지 ──
  const finish = async () => {
    if (!session || !result) return
    const ok = await confirmDialog('최종 머지', {
      message: `“${entry.title}”의 main을 이 결과(획 ${resultStrokes}개 · 페이지 ${result.pages.filter((p) => !p.sheet).length}장)로 바꿉니다. 두 쪽의 원래 내용은 main 버전 기록과 ${branchName}에 그대로 남습니다.`,
      ok: '머지'
    })
    if (!ok) return
    setBusy(true)
    try {
      const r = await commitMerge(session, draft)
      await deleteMergeDraft(entry.docId, entry.deviceId)
      toast(
        r.keptLocal
          ? '머지했습니다. 이 기기 브랜치에도 머지할 것이 남아 있어 이 기기 노트는 그대로 두었습니다 — 머지 관리에서 이어서 합쳐 주세요.'
          : `“${entry.title}”을(를) 머지했습니다.`,
        r.keptLocal ? 'info' : 'success'
      )
      closeMergeView()
    } catch (e) {
      if (e instanceof MergeStaleError) {
        toast(e.message, 'info')
        await load({ refind: true, keep: draft })
      } else toast(errText(e, '머지하지 못했습니다.'), 'error')
    } finally {
      setBusy(false)
    }
  }

  // ── 키보드 (컴퓨터) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || document.querySelector('.dialog-host')) return
      const mod = e.metaKey || e.ctrlKey
      const k = e.key.toLowerCase()
      if (mod && k === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (mod && k === 'y') {
        e.preventDefault()
        redo()
      } else if (mod) return
      else if (e.key === 'Escape') {
        if (selection) setSelection(null)
        else if (!busy) closeMergeView()
      } else if (/^[1-4]$/.test(e.key)) {
        const cls = LAYERS[Number(e.key) - 1]
        setFocus((f) => (f === cls ? null : cls))
      } else if (e.key === ']') jump(1)
      else if (e.key === '[') jump(-1)
      else if (k === 'h' && focus) setVisible((v) => ({ ...v, [focus]: !v[focus] }))
      else if (k === 'v') chooseTool('view')
      else if (k === 'l') chooseTool('lasso')
      else if (k === 'e') chooseTool('eraser')
      else if ((e.key === 'Backspace' || e.key === 'Delete') && selection) {
        e.preventDefault()
        discardSelected()
      } else if (e.key === 'Enter' && selection) restoreSelected()
      else if (e.key === '+' || e.key === '=') setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)])
      else if (e.key === '-') setZoom((z) => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const layerLabel: Record<ItemClass, string> = {
    common: '원래 있던 내용',
    mainOnly: `${mainName}에만`,
    branchOnly: `${branchName}에만`,
    modified: '양쪽에서 내용이 다름'
  }
  const layerHint: Record<ItemClass, string> = {
    common: '양쪽에 같은 내용으로 있는 획 — 버릴 수 없다. 고르면 이것만 또렷하게 보인다',
    mainOnly: 'main 쪽에서 새로 그렸거나, 브랜치에서 지운 획 — 기본은 살린다',
    branchOnly: '브랜치에서 새로 그렸거나, main 쪽에서 지운 획 — 기본은 살린다',
    modified: `한쪽만 고쳤으면 고친 쪽, 양쪽이 고쳤으면 ${session ? sideName(session.prefer) : ''} 쪽`
  }
  const target = focus ? layerLabel[focus] : '보이는 레이어 전부'

  return (
    <div className="merge-view" role="dialog" aria-modal="true" aria-label="머지">
      <header className="merge-head">
        <button className="tb-btn" onClick={closeMergeView} disabled={busy} aria-label="닫기">
          <Icon name="back" />
        </button>
        <div className="merge-title">
          <h2>머지: {entry.title}</h2>
          <p>
            <span className="merge-side main">{mainName}</span> ↔ <span className="merge-side branch">{branchName}</span>
            <span className="merge-when"> · {formatDate(entry.branchAt)}</span>
          </p>
        </div>
        <button className={'merge-result-btn' + (resultOnly ? ' on' : '')} onClick={() => setResultOnly((v) => !v)} aria-pressed={resultOnly}>
          <Icon name={resultOnly ? 'eye' : 'eyeOff'} size={16} /> 결과만 보기
        </button>
        <button className="tb-btn merge-panel-toggle" onClick={() => setPanelOpen((v) => !v)} aria-expanded={panelOpen} aria-label="레이어">
          <Icon name="blocks" />
        </button>
      </header>

      {session && (
        <div className="merge-tools" role="toolbar" aria-label="머지 도구">
          <div className="merge-tool-group" role="radiogroup" aria-label="도구">
            {(
              [
                ['view', 'move', '보기', 'V'],
                ['lasso', 'lasso', '올가미', 'L'],
                ['eraser', 'eraser', '지우개', 'E']
              ] as const
            ).map(([t, icon, label, key]) => (
              <button
                key={t}
                role="radio"
                aria-checked={tool === t}
                className={'merge-tool' + (tool === t ? ' on' : '')}
                onClick={() => chooseTool(t)}
                title={`${label} (${key})`}
              >
                <Icon name={icon} size={18} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <span className="merge-target" title="도구가 닿는 레이어 — 레이어 패널에서 고른다">
            대상: <b>{target}</b>
          </span>
          <div className="merge-tool-group">
            <button className="tb-btn" onClick={undo} disabled={!past.length} aria-label="되돌리기" title="되돌리기 (⌘Z)">
              <Icon name="undo" />
            </button>
            <button className="tb-btn" onClick={redo} disabled={!future.length} aria-label="다시 하기" title="다시 하기 (⇧⌘Z)">
              <Icon name="redo" />
            </button>
          </div>
          <div className="merge-tool-group">
            <button className="tb-btn" onClick={() => setZoom((z) => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)])} disabled={zoom === ZOOMS[0]} aria-label="축소">
              <Icon name="minus" />
            </button>
            <span className="merge-zoom">{Math.round(zoom * 100)}%</span>
            <button
              className="tb-btn"
              onClick={() => setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)])}
              disabled={zoom === ZOOMS[ZOOMS.length - 1]}
              aria-label="확대"
            >
              <Icon name="plus" />
            </button>
          </div>
        </div>
      )}

      {!session ? (
        <div className="merge-loading">
          {error ? (
            <>
              <Icon name="alert" size={22} />
              <p>{error}</p>
              <button className="primary-btn" onClick={() => void load({ refind: true })}>
                다시 시도
              </button>
            </>
          ) : (
            <>
              <span className="spinner" />
              <p>{status}</p>
            </>
          )}
        </div>
      ) : (
        <div className={'merge-body' + (panelOpen ? '' : ' panel-closed')}>
          <div className="merge-stage">
            <MergePreview
              pages={pages}
              zoom={zoom}
              visible={visible}
              focus={focus}
              resultOnly={resultOnly}
              outline={outline}
              glow
              tool={tool}
              fingerTool={fingerTool}
              selection={selection}
              editable={editable}
              pdfs={pdfs.current}
              pageRefs={pageRefs.current}
              onTogglePage={toggleDiscard}
              sideName={sideName}
              {...canvasHandlers}
            />

            {selection && selItems.length > 0 && (
              <div className="merge-selbar" role="toolbar" aria-label="고른 획">
                <span className="merge-selcount">획 {selItems.length}개</span>
                <button className="text-btn danger" onClick={discardSelected}>
                  버리기
                </button>
                <button className="text-btn" onClick={restoreSelected}>
                  살리기
                </button>
                {selItems.some((i) => i.cls === 'modified') && (
                  <button className="text-btn" onClick={flipSelected}>
                    다른 쪽 버전
                  </button>
                )}
                <span className="merge-colors" role="group" aria-label="색 바꾸기">
                  {PEN_COLORS.slice(0, 6).map((c, i) => (
                    <button
                      key={c}
                      className="merge-color"
                      style={{ background: c.slice(0, 7) }}
                      onClick={() => colorSelected(c)}
                      aria-label={`${PEN_COLOR_NAMES[i]}으로`}
                      title={PEN_COLOR_NAMES[i]}
                    />
                  ))}
                </span>
                <button className="tb-btn" onClick={() => setSelection(null)} aria-label="선택 해제">
                  <Icon name="close" size={18} />
                </button>
              </div>
            )}
          </div>

          <aside className="merge-panel" aria-label="레이어">
            <div className="merge-nav">
              <span>
                변경 있는 페이지 <b>{changed.length}</b>
              </span>
              <button className="tb-btn" onClick={() => jump(-1)} disabled={!changed.length} aria-label="이전 변경">
                <Icon name="arrowUp" size={16} />
              </button>
              <button className="tb-btn" onClick={() => jump(1)} disabled={!changed.length} aria-label="다음 변경">
                <Icon name="arrowDown" size={16} />
              </button>
            </div>

            <ul className="merge-layers">
              {LAYERS.map((cls, i) => {
                const items = itemsOf(cls)
                const strokes = session.plan.counts[cls]
                const others = items.length - strokes
                const discarded = items.filter((it) => draft.discard.has(it.key)).length
                const canDiscard = cls === 'mainOnly' || cls === 'branchOnly'
                const allDiscarded = items.length > 0 && discarded === items.length
                return (
                  <li key={cls} className={'merge-layer l-' + cls + (focus === cls ? ' focused' : '') + (visible[cls] ? '' : ' hidden')}>
                    <button
                      className="merge-eye"
                      onClick={() => setVisible((v) => ({ ...v, [cls]: !v[cls] }))}
                      aria-pressed={visible[cls]}
                      aria-label={visible[cls] ? '숨기기' : '보이기'}
                    >
                      <Icon name={visible[cls] ? 'eye' : 'eyeOff'} size={16} />
                    </button>
                    <button
                      className="merge-layer-main"
                      onClick={() => setFocus((f) => (f === cls ? null : cls))}
                      aria-pressed={focus === cls}
                      title={`강조·도구 대상 (${i + 1})`}
                    >
                      <i className="merge-swatch" style={{ background: LAYER_COLOR[cls] }} aria-hidden="true" />
                      <span className="merge-layer-name">{layerLabel[cls]}</span>
                      <span className="merge-layer-count">
                        획 {strokes}
                        {others > 0 ? ` · 페이지·블록 ${others}` : ''}
                        {discarded > 0 ? ` · 버림 ${discarded}` : ''}
                        {cls === 'modified' && session.plan.bothCount > 0 ? ` · 양쪽이 고침 ${session.plan.bothCount}` : ''}
                      </span>
                      <span className="merge-layer-hint">{layerHint[cls]}</span>
                    </button>
                    {canDiscard && items.length > 0 && (
                      <button className={'text-btn' + (allDiscarded ? '' : ' danger')} onClick={() => toggleDiscardLayer(cls)}>
                        {allDiscarded ? '모두 살리기' : '모두 버리기'}
                      </button>
                    )}
                    {cls === 'modified' && items.length > 0 && (
                      <Segmented
                        className="merge-seg"
                        label="고친 획을 어느 쪽으로"
                        value={modifiedMode()}
                        options={[
                          ['auto', '기본 규칙'],
                          ['main', 'main 쪽'],
                          ['branch', '브랜치 쪽']
                        ]}
                        onChange={setModifiedSide}
                      />
                    )}
                  </li>
                )
              })}
            </ul>

            {session.plan.meta.length > 0 && (
              <section className="merge-meta">
                <h4>문서 정보</h4>
                {session.plan.meta.map((m) => (
                  <div key={m.key} className="merge-meta-row">
                    <span className="merge-meta-label">{META_LABEL[m.field]}</span>
                    <Segmented
                      className="merge-seg"
                      label={META_LABEL[m.field]}
                      value={resolveMeta(m, draft)}
                      options={[
                        ['main', metaText(m, 'main')],
                        ['branch', metaText(m, 'branch')]
                      ]}
                      onChange={(side) => setMetaSide(m, side)}
                    />
                  </div>
                ))}
              </section>
            )}

            <label className="merge-check">
              <input type="checkbox" checked={outline} onChange={(e) => setOutline(e.target.checked)} /> 출처를 빛나는 테두리로 표시
            </label>
            {!isEmptyDraft(draft) && (
              <button className="text-btn danger merge-reset" onClick={() => apply(emptyDraft())}>
                작업본 처음부터 다시
              </button>
            )}
            <p className="merge-keys">
              도구는 강조한 레이어(없으면 보이는 레이어 전부)에만 닿습니다. 패드에서는 펜이 도구, 손가락은 화면 이동입니다. 작업본은 이 기기에 저장돼 닫아도
              이어서 할 수 있습니다.
            </p>
            <p className="merge-keys">
              단축키: V 보기 · L 올가미 · E 지우개 · Delete 버리기 · Enter 살리기 · ⌘Z / ⇧⌘Z · 1–4 레이어 강조 · H 숨기기 · [ ] 변경 이동 · +/− 확대 · Esc
            </p>
          </aside>
        </div>
      )}

      <footer className="merge-foot">
        <span className="merge-total">{result ? `결과: 획 ${resultStrokes}개 · 페이지 ${result.pages.filter((p) => !p.sheet).length}장` : ''}</span>
        <button className="text-btn" onClick={closeMergeView} disabled={busy}>
          나중에
        </button>
        <button className="primary-btn" onClick={() => void finish()} disabled={!session || busy}>
          {busy ? <span className="spinner sm" /> : <Icon name="check" size={18} />} 최종 머지
        </button>
      </footer>
    </div>
  )
}

const META_LABEL: Record<MetaItem['field'], string> = {
  title: '제목',
  category: '카테고리',
  mode: '형식',
  pageOrder: '페이지 순서'
}

function metaText(m: MetaItem, side: Side): string {
  const v = side === 'main' ? m.main : m.branch
  const who = side === 'main' ? 'main' : '브랜치'
  if (m.field === 'pageOrder') return `${who} 순서`
  if (m.field === 'mode') return `${who}: ${v === 'infinite' ? '무한 캔버스' : '문서형'}`
  if (m.field === 'category') return `${who}: ${(v as string | null) ?? '미분류'}`
  return `${who}: ${String(v ?? '')}`
}

// ───────── 미리보기 (페이지 목록) ─────────

function MergePreview(
  props: Omit<CanvasProps, 'width' | 'scroller'> & {
    pages: ViewPage[]
    zoom: number
    pageRefs: Map<ID, HTMLElement>
    onTogglePage: (key: string) => void
    sideName: (s: Side) => string
  }
) {
  const ref = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(0)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setScroller(el)
    const ro = new ResizeObserver(() => setFit(Math.min(900, Math.max(200, el.clientWidth - 32))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const width = Math.round(fit * props.zoom)
  return (
    <div className={'merge-preview' + (props.tool !== 'view' ? ' tooling' : '')} ref={ref}>
      {fit > 0 &&
        props.pages.map((p, i) => (
          <section
            key={p.id}
            className={'merge-page' + (p.discarded ? ' discarded' : '')}
            ref={(el) => {
              if (el) props.pageRefs.set(p.id, el)
              else props.pageRefs.delete(p.id)
            }}
          >
            <div className="merge-page-head">
              <span>{p.page.sheet ? `보조 용지${p.page.sheet.title ? ` · ${p.page.sheet.title}` : ''}` : `p.${i + 1}`}</span>
              {p.item.cls !== 'common' && <span className={'merge-chip l-' + p.item.cls}>{pageChip(p.item, props.sideName)}</span>}
              {p.changes > 0 && <span className="merge-page-changes">변경 {p.changes}</span>}
              {(p.item.cls === 'mainOnly' || p.item.cls === 'branchOnly') && (
                <button className={'text-btn' + (p.discarded ? '' : ' danger')} onClick={() => props.onTogglePage(p.item.key)}>
                  {p.discarded ? '이 페이지 살리기' : '이 페이지 버리기'}
                </button>
              )}
            </div>
            <PageCanvas {...props} vp={p} width={width} scroller={scroller} />
          </section>
        ))}
      {fit > 0 && !props.pages.length && <p className="merge-empty">페이지가 없습니다.</p>}
    </div>
  )
}

function pageChip(item: MergeItem, sideName: (s: Side) => string): string {
  if (item.cls === 'mainOnly') return `${sideName('main')}에만 있는 페이지`
  if (item.cls === 'branchOnly') return `${sideName('branch')}에만 있는 페이지`
  return `속지·크기가 다름 → ${sideName(item.pick)}`
}
