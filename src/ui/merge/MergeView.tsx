// 머지 화면 — main과 기기 브랜치 하나를 레이어로 나눠 보여 주고, 사용자가 고른 대로 최종 머지한다
// (설계: docs/branch-merge.md §5). 패드(펜·손가락)와 컴퓨터(마우스·키보드)에서 똑같이 쓴다.
//
// 레이어: 공통 / main에만 / 브랜치에만 / 양쪽에서 내용이 다름. 기본은 모두 살리기(머지에는 삭제가 없다).
// 이 화면에서 하는 일은 작업본(버린 것·반대쪽으로 바꾼 것)에만 쌓이고, '최종 머지'를 눌러야 main이 바뀐다.
// 미리보기는 편집 엔진이 아니라 가벼운 캔버스로 그린다 — 읽기 전용이고, 화면에 보이는 페이지만 그린다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { useUI } from '../../app/store'
import { confirmDialog } from '../../app/dialogs'
import { Icon } from '../Icon'
import { Segmented } from '../Segmented'
import { drawPattern } from '../../engine/background'
import { getPath } from '../../engine/scene'
import { parseChunkKey } from '../../engine/layout'
import { closePdf, openPdf, type PDFDocumentProxy } from '../../engine/pdf/pdfjs'
import { db } from '../../storage/db'
import { formatDate } from '../../shared/util'
import type { ID, Page, Stroke } from '../../shared/model'
import { commitMerge, listMergeQueue, MergeStaleError, openMerge, pushBeforeMerge, type MergeQueueEntry, type MergeSession } from '../../sync/sync'
import {
  compose,
  emptyDraft,
  mergePageOrder,
  resolveItem,
  resolveMeta,
  type ItemClass,
  type MergeDraft,
  type MergeItem,
  type MetaItem,
  type Placed,
  type Side
} from '../../sync/merge'

/** 최종 머지가 끝났을 때 — 동기화 패널이 목록을 다시 읽는다 */
export const MERGE_DONE_EVENT = 'inkpad-merge-done'

const useMergeView = create<{ entry: MergeQueueEntry | null }>(() => ({ entry: null }))
export const openMergeView = (entry: MergeQueueEntry) => useMergeView.setState({ entry })
const closeMergeView = () => useMergeView.setState({ entry: null })

const toast = (text: string, kind: 'info' | 'success' | 'error' = 'success') => useUI.getState().toast(text, kind)
const errText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

/** App이 한 번 그린다 — 열린 머지가 있으면 전체 화면으로 */
export function MergeHost() {
  const entry = useMergeView((s) => s.entry)
  return entry ? <MergeView key={entry.docId + '@' + entry.deviceId} entry={entry} /> : null
}

// ───────── 레이어 ─────────

const LAYERS: ItemClass[] = ['common', 'mainOnly', 'branchOnly', 'modified']
/** 출처 테두리 색 — 노트 자체가 여러 색이라 획 색은 바꾸지 않고 둘레에만 칠한다 */
const LAYER_COLOR: Record<ItemClass, string> = { common: 'transparent', mainOnly: '#e8890c', branchOnly: '#2f6fe0', modified: '#8b4fd6' }

type Visible = Record<ItemClass, boolean>

interface ViewEl {
  item: MergeItem
  placed: Placed
  side: Side
  discarded: boolean
}

interface ViewPage {
  id: ID
  item: MergeItem
  page: Page
  discarded: boolean
  els: ViewEl[]
  /** 이 페이지에서 공통이 아닌 항목 수 (페이지 자체 포함) */
  changes: number
}

const pick = <T,>(item: MergeItem, side: Side): T => (side === 'main' ? (item.main ?? item.branch) : (item.branch ?? item.main)) as T

/** 작업본을 얹어 페이지별로 묶는다. resultOnly가 아니면 버린 것도(흐리게 그리려고) 함께 둔다 */
function buildPages(s: MergeSession, draft: MergeDraft, resultOnly: boolean): ViewPage[] {
  const pages = new Map<ID, ViewPage>()
  for (const item of s.plan.items) {
    if (item.kind !== 'page') continue
    const { side, discarded } = resolveItem(item, draft)
    if (discarded && resultOnly) continue
    pages.set(item.id, { id: item.id, item, page: pick<Page>(item, side), discarded, els: [], changes: item.cls === 'common' ? 0 : 1 })
  }
  for (const item of s.plan.items) {
    if (item.kind !== 'el') continue
    const { side, discarded } = resolveItem(item, draft)
    if (discarded && resultOnly) continue
    const placed = pick<Placed>(item, side)
    const vp = pages.get(placed.pageId)
    if (!vp) continue
    vp.els.push({ item, placed, side, discarded })
    if (item.cls !== 'common') vp.changes++
  }
  const orderMeta = s.plan.meta.find((m) => m.field === 'pageOrder')
  const orderSide = orderMeta ? resolveMeta(orderMeta, draft) : 'main'
  const [primary, secondary] = orderSide === 'main' ? [s.main.doc.pageOrder, s.branch.doc.pageOrder] : [s.branch.doc.pageOrder, s.main.doc.pageOrder]
  return mergePageOrder(primary ?? [], secondary ?? [], new Set(pages.keys())).map((id) => pages.get(id)!)
}

// ───────── 화면 ─────────

function MergeView({ entry }: { entry: MergeQueueEntry }) {
  const [session, setSession] = useState<MergeSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('불러오는 중…')
  const [draft, setDraft] = useState<MergeDraft>(emptyDraft)
  const [visible, setVisible] = useState<Visible>({ common: true, mainOnly: true, branchOnly: true, modified: true })
  const [focus, setFocus] = useState<ItemClass | null>(null)
  const [resultOnly, setResultOnly] = useState(false)
  const [outline, setOutline] = useState(true)
  const [busy, setBusy] = useState(false)
  const [panelOpen, setPanelOpen] = useState(true)
  const pdfs = useRef(new Map<ID, Promise<PDFDocumentProxy | null>>())

  /** 머지할 것을 연다. refind면 목록에서 같은 노트·같은 기기 브랜치를 다시 찾는다(그 사이 올라온 새 판). keep은 이어 쓸 작업본 */
  const load = useCallback(
    async (opts: { refind?: boolean; keep?: MergeDraft } = {}) => {
      setSession(null)
      setError(null)
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
          window.dispatchEvent(new Event(MERGE_DONE_EVENT))
          closeMergeView()
          return
        }
        setStatus('클라우드에서 양쪽 내용을 받는 중…')
        const s = await openMerge(target)
        const keys = new Set([...s.plan.items.map((i) => i.key), ...s.plan.meta.map((m) => m.key)])
        const keep = opts.keep
        setDraft(keep ? { discard: new Set([...keep.discard].filter((k) => keys.has(k))), flip: new Set([...keep.flip].filter((k) => keys.has(k))) } : emptyDraft())
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

  const mainName = `main · ${entry.mainDevice ?? '클라우드'}`
  const branchName = `${entry.device} 브랜치`
  const sideName = (s: Side) => (s === 'main' ? mainName : branchName)

  // ── 작업본 바꾸기 ──
  const itemsOf = (cls: ItemClass) => session?.plan.items.filter((i) => i.cls === cls) ?? []
  const toggleDiscardLayer = (cls: ItemClass) =>
    setDraft((d) => {
      const keys = itemsOf(cls).map((i) => i.key)
      const all = keys.length > 0 && keys.every((k) => d.discard.has(k))
      const discard = new Set(d.discard)
      for (const k of keys) {
        if (all) discard.delete(k)
        else discard.add(k)
      }
      return { ...d, discard }
    })
  const toggleDiscard = (key: string) =>
    setDraft((d) => {
      const discard = new Set(d.discard)
      if (discard.has(key)) discard.delete(key)
      else discard.add(key)
      return { ...d, discard }
    })
  /** 고친 항목 전체를 한쪽으로 — 'auto'는 기본 규칙(한쪽만 고침 → 고친 쪽, 양쪽 → 머지하는 기기 쪽) */
  const setModifiedSide = (to: 'auto' | Side) =>
    setDraft((d) => {
      const flip = new Set(d.flip)
      for (const i of itemsOf('modified')) {
        if (to === 'auto' || i.pick === to) flip.delete(i.key)
        else flip.add(i.key)
      }
      return { ...d, flip }
    })
  const modifiedMode = (): 'auto' | Side => {
    const mods = itemsOf('modified')
    if (!mods.length || mods.every((i) => !draft.flip.has(i.key))) return 'auto'
    if (mods.every((i) => resolveItem(i, draft).side === 'main')) return 'main'
    if (mods.every((i) => resolveItem(i, draft).side === 'branch')) return 'branch'
    return 'auto'
  }
  const setMetaSide = (m: MetaItem, side: Side) =>
    setDraft((d) => {
      const flip = new Set(d.flip)
      if (side === m.pick) flip.delete(m.key)
      else flip.add(m.key)
      return { ...d, flip }
    })

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
      message: `“${entry.title}”의 main을 이 결과(획 ${resultStrokes}개 · 페이지 ${result.pages.length}장)로 바꿉니다. 두 쪽의 원래 내용은 main 버전 기록과 ${branchName}에 그대로 남습니다.`,
      ok: '머지'
    })
    if (!ok) return
    setBusy(true)
    try {
      const r = await commitMerge(session, draft)
      toast(
        r.keptLocal
          ? `머지했습니다. 이 기기 브랜치에도 머지할 것이 남아 있어 이 기기 노트는 그대로 두었습니다 — 머지 관리에서 이어서 합쳐 주세요.`
          : `“${entry.title}”을(를) 머지했습니다.`,
        r.keptLocal ? 'info' : 'success'
      )
      window.dispatchEvent(new Event(MERGE_DONE_EVENT))
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
      if (e.key === 'Escape' && !busy) closeMergeView()
      else if (/^[1-4]$/.test(e.key)) {
        const cls = LAYERS[Number(e.key) - 1]
        setFocus((f) => (f === cls ? null : cls))
      } else if (e.key === ']') jump(1)
      else if (e.key === '[') jump(-1)
      else if (e.key.toLowerCase() === 'h' && focus) setVisible((v) => ({ ...v, [focus]: !v[focus] }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const layerLabel: Record<ItemClass, string> = {
    common: '공통',
    mainOnly: `${mainName}에만`,
    branchOnly: `${branchName}에만`,
    modified: '양쪽에서 내용이 다름'
  }
  const layerHint: Record<ItemClass, string> = {
    common: '양쪽에 같은 내용으로 있는 획',
    mainOnly: 'main 쪽에서 새로 그렸거나, 브랜치에서 지운 획 — 기본은 살린다',
    branchOnly: '브랜치에서 새로 그렸거나, main 쪽에서 지운 획 — 기본은 살린다',
    modified: `한쪽만 고쳤으면 고친 쪽, 양쪽이 고쳤으면 ${session ? sideName(session.prefer) : ''} 쪽`
  }

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
          <MergePreview pages={pages} visible={visible} focus={focus} resultOnly={resultOnly} outline={outline} pdfs={pdfs.current} pageRefs={pageRefs.current} onTogglePage={toggleDiscard} sideName={sideName} />

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
                    <button className="merge-layer-main" onClick={() => setFocus((f) => (f === cls ? null : cls))} aria-pressed={focus === cls} title={`${i + 1}`}>
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
              <input type="checkbox" checked={outline} onChange={(e) => setOutline(e.target.checked)} /> 출처를 획 둘레 색으로 표시
            </label>
            <p className="merge-keys">단축키: 1–4 레이어 강조 · H 숨기기 · [ ] 이전/다음 변경 · Esc 닫기</p>
          </aside>
        </div>
      )}

      <footer className="merge-foot">
        <span className="merge-total">{result ? `결과: 획 ${resultStrokes}개 · 페이지 ${result.pages.length}장` : ''}</span>
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

const META_LABEL: Record<MetaItem['field'], string> = { title: '제목', category: '카테고리', mode: '형식', pageOrder: '페이지 순서' }

function metaText(m: MetaItem, side: Side): string {
  const v = side === 'main' ? m.main : m.branch
  const who = side === 'main' ? 'main' : '브랜치'
  if (m.field === 'pageOrder') return `${who} 순서`
  if (m.field === 'mode') return `${who}: ${v === 'infinite' ? '무한 캔버스' : '문서형'}`
  if (m.field === 'category') return `${who}: ${(v as string | null) ?? '미분류'}`
  return `${who}: ${String(v ?? '')}`
}

// ───────── 미리보기 ─────────

function MergePreview(props: {
  pages: ViewPage[]
  visible: Visible
  focus: ItemClass | null
  resultOnly: boolean
  outline: boolean
  pdfs: Map<ID, Promise<PDFDocumentProxy | null>>
  pageRefs: Map<ID, HTMLElement>
  onTogglePage: (key: string) => void
  sideName: (s: Side) => string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.min(900, Math.max(200, el.clientWidth - 32))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div className="merge-preview" ref={ref}>
      {width > 0 &&
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
              <span>p.{i + 1}</span>
              {p.item.cls !== 'common' && <span className={'merge-chip l-' + p.item.cls}>{pageChip(p.item, props.sideName)}</span>}
              {p.changes > 0 && <span className="merge-page-changes">변경 {p.changes}</span>}
              {(p.item.cls === 'mainOnly' || p.item.cls === 'branchOnly') && (
                <button className={'text-btn' + (p.discarded ? '' : ' danger')} onClick={() => props.onTogglePage(p.item.key)}>
                  {p.discarded ? '이 페이지 살리기' : '이 페이지 버리기'}
                </button>
              )}
            </div>
            <PageCanvas vp={p} width={width} visible={props.visible} focus={props.focus} resultOnly={props.resultOnly} outline={props.outline} pdfs={props.pdfs} />
          </section>
        ))}
      {width > 0 && !props.pages.length && <p className="merge-empty">페이지가 없습니다.</p>}
    </div>
  )
}

function pageChip(item: MergeItem, sideName: (s: Side) => string): string {
  if (item.cls === 'mainOnly') return `${sideName('main')}에만 있는 페이지`
  if (item.cls === 'branchOnly') return `${sideName('branch')}에만 있는 페이지`
  return `속지·크기가 다름 → ${sideName(item.pick)}`
}

/** 획 외곽선은 비싸다 — 같은 획 객체는 한 번만 만든다 */
const pathCache = new WeakMap<Stroke, Path2D>()
const pathOf = (s: Stroke) => {
  let p = pathCache.get(s)
  if (!p) pathCache.set(s, (p = getPath({ stroke: s })))
  return p
}

/** 아래 레이어(형광펜) → 위 레이어(펜), 같은 레이어는 z 순 — 엔진과 같은 쌓임 */
const byLayerZ = (a: ViewEl, b: ViewEl) => {
  const sa = a.placed.el
  const sb = b.placed.el
  return sa.layer === sb.layer ? sa.z - sb.z : sa.layer === 'under' ? -1 : 1
}

function PageCanvas(props: {
  vp: ViewPage
  width: number
  visible: Visible
  focus: ItemClass | null
  resultOnly: boolean
  outline: boolean
  pdfs: Map<ID, Promise<PDFDocumentProxy | null>>
}) {
  const { vp, width } = props
  const canvas = useRef<HTMLCanvasElement>(null)
  const [seen, setSeen] = useState(false)

  // 무한 캔버스(페이지 크기 없음)는 필기가 있는 범위를 페이지로 본다
  const frame = useMemo(() => {
    if (vp.page.size) return { x: 0, y: 0, w: vp.page.size.w, h: vp.page.size.h, infinite: false }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const v of vp.els) {
      const s = v.placed.el
      if (s.type !== 'stroke') continue
      const o = parseChunkKey(v.placed.key)
      minX = Math.min(minX, o.ox + s.bbox[0])
      minY = Math.min(minY, o.oy + s.bbox[1])
      maxX = Math.max(maxX, o.ox + s.bbox[2])
      maxY = Math.max(maxY, o.oy + s.bbox[3])
    }
    if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 800, h: 500, infinite: true }
    const pad = 40
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: Math.max(200, maxY - minY + pad * 2), infinite: true }
  }, [vp])
  const height = Math.round((width * frame.h) / frame.w)

  useEffect(() => {
    const el = canvas.current
    if (!el || seen) return
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [seen])

  useEffect(() => {
    const el = canvas.current
    if (!el || !seen) return
    let cancelled = false
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    el.width = Math.max(1, Math.round(width * dpr))
    el.height = Math.max(1, Math.round(height * dpr))
    const ctx = el.getContext('2d')
    if (!ctx) return
    const scale = (width * dpr) / frame.w
    void (async () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, el.width, el.height)
      let drewPdf = false
      if (vp.page.pdf && !frame.infinite) drewPdf = await drawPdf(ctx, vp.page, el.width, el.height, props.pdfs)
      if (cancelled) return
      ctx.setTransform(scale, 0, 0, scale, -frame.x * scale, -frame.y * scale)
      if (!drewPdf && !frame.infinite) drawPattern(ctx, vp.page.background, frame.w, frame.h, scale)
      for (const v of [...vp.els].sort(byLayerZ)) {
        const s = v.placed.el
        if (s.type !== 'stroke' || !props.visible[v.item.cls]) continue
        let alpha = 1
        if (v.discarded) alpha = props.resultOnly ? 0 : 0.14
        else if (props.focus && props.focus !== v.item.cls) alpha = 0.22
        if (alpha <= 0) continue
        const o = vp.page.size ? { ox: 0, oy: 0 } : parseChunkKey(v.placed.key)
        const path = pathOf(s)
        ctx.save()
        ctx.translate(o.ox, o.oy)
        ctx.globalAlpha = alpha
        ctx.fillStyle = s.color
        ctx.fill(path)
        if (props.outline && v.item.cls !== 'common' && !v.discarded && !props.resultOnly) {
          ctx.globalAlpha = Math.min(1, alpha + 0.3)
          ctx.strokeStyle = LAYER_COLOR[v.item.cls]
          ctx.lineWidth = 1.6 / (scale / dpr)
          ctx.stroke(path)
        }
        ctx.restore()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [seen, width, height, frame, vp, props.visible, props.focus, props.resultOnly, props.outline, props.pdfs])

  return <canvas ref={canvas} className="merge-canvas" style={{ width, height }} />
}

/** PDF 속지 — 원본이 이 기기에 있을 때만 그린다(지연 로딩 원칙: 여기서 받아오지 않는다) */
async function drawPdf(ctx: CanvasRenderingContext2D, page: Page, w: number, h: number, pdfs: Map<ID, Promise<PDFDocumentProxy | null>>): Promise<boolean> {
  const ref = page.pdf!
  let doc = pdfs.get(ref.assetId)
  if (!doc) {
    doc = (async () => {
      const asset = await db.assets.get(ref.assetId)
      if (!asset?.blob) return null
      return openPdf(await asset.blob.arrayBuffer()).catch(() => null)
    })()
    pdfs.set(ref.assetId, doc)
  }
  const pdf = await doc
  if (!pdf) return false
  try {
    const p = await pdf.getPage(ref.pageIndex + 1)
    const rotation = (p.rotate + ref.rotation) % 360
    const base = p.getViewport({ scale: 1, rotation })
    const vp = p.getViewport({ scale: w / base.width, rotation })
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(vp.width))
    c.height = Math.max(1, Math.round(vp.height))
    await p.render({ canvas: null, canvasContext: c.getContext('2d')!, viewport: vp }).promise
    ctx.drawImage(c, 0, 0, w, h)
    return true
  } catch {
    return false
  }
}
