// 비교 화면 — 이 기기에서 바꾼 것을 마지막으로 맞춘 상태(기준본) 위에 보여 주고, 버릴지·덮을지·올릴지 고른다.
// 받기 미리보기의 '비교', 편집 화면 노트 칩의 '변경 버리기'·'받기'(이 기기 변경이 있을 때), 노트를 닫을 때 알림,
// 동기화 목록·라이브러리의 '클라우드에 맞추기'가 연다. 비교 자체는 네트워크를 쓰지 않는다(sync/localChanges.ts).
//
//   (일렁이는 빛 테두리로 — 파란 펜 획과 헷갈리지 않게)
//   파랑 = 이 기기에서 새로 쓴 획(버리거나 덮으면 사라짐) · 빨강 = 이 기기에서 지운 획(버리거나 덮으면 돌아옴) · 보라 = 고친 획
import { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { useUI } from '../app/store'
import type { ID } from '../shared/model'
import { flushOpenDocs } from '../storage/docGuard'
import { emptyDraft } from '../sync/merge'
import { localChanges, type LocalChanges } from '../sync/localChanges'
import { alignWithCloud, discardLocalChanges, pushOneNote } from '../sync/sync'
import { closePdf, type PDFDocumentProxy } from '../engine/pdf/pdfjs'
import { Icon } from './Icon'
import { PageCanvas, buildPages, type ViewPage } from './merge/MergeCanvas'

/** 비교 화면에서 고를 수 있는 동작 */
export type ChangeAction = 'discard' | 'align' | 'push'

interface Opened {
  docId: ID
  title: string
  actions: ChangeAction[]
}

const useChanges = create<{ open: Opened | null }>(() => ({ open: null }))
export const openChanges = (o: Opened) => useChanges.setState({ open: o })
const close = () => useChanges.setState({ open: null })

/** App이 한 번 그린다 */
export function ChangesHost() {
  const o = useChanges((s) => s.open)
  return o ? <ChangesView key={o.docId} {...o} /> : null
}

const toast = (text: string, kind: 'info' | 'success' | 'error' = 'success') => useUI.getState().toast(text, kind)
const noop = () => {}
const VISIBLE = { common: true, mainOnly: true, branchOnly: true, modified: true }
/** 지운 획은 빨강 (머지 화면의 출처 색은 주황 그대로 — 거기서 빨강은 지우개) */
const CHANGE_COLORS = { mainOnly: '#e5484d' }

function ChangesView({ docId, title, actions }: Opened) {
  const [lc, setLc] = useState<LocalChanges | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [allPages, setAllPages] = useState(false)
  const [busy, setBusy] = useState(false)
  const [width, setWidth] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  const pdfs = useRef(new Map<ID, Promise<PDFDocumentProxy | null>>())

  useEffect(() => {
    void (async () => {
      try {
        await flushOpenDocs() // 편집 화면이 아직 기록하지 않은 마지막 획까지
        setLc(await localChanges(docId))
      } catch (e) {
        setError(e instanceof Error ? e.message : '비교하지 못했습니다.')
      }
    })()
  }, [docId])
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.min(760, Math.max(200, el.clientWidth - 32))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [lc])
  useEffect(() => {
    const map = pdfs.current
    return () => {
      for (const p of map.values()) void p.then((d) => closePdf(d)).catch(() => {})
      map.clear()
    }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && !document.querySelector('.dialog-host') && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy])

  const pages: ViewPage[] = useMemo(() => {
    if (!lc) return []
    const all = buildPages({ plan: lc.plan, main: lc.base, branch: lc.local }, emptyDraft(), false)
    return allPages ? all : all.filter((p) => p.changes > 0)
  }, [lc, allPages])

  const run = async (a: ChangeAction) => {
    setBusy(true)
    try {
      if (a === 'discard') {
        const r = await discardLocalChanges(docId)
        toast(r === 'reverted' ? `“${title}”을(를) 마지막 동기화 상태로 되돌렸습니다. 지운 내용은 버전 기록의 스냅샷에 남아 있습니다.` : '마지막으로 맞춘 기록이 없어 되돌릴 수 없습니다.', r === 'reverted' ? 'success' : 'info')
      } else if (a === 'align') {
        const r = await alignWithCloud(docId)
        toast(r === 'applied' ? `“${title}”을(를) 클라우드 버전으로 맞췄습니다. 이 기기 내용은 스냅샷에 남아 있습니다.` : r === 'notfound' ? '클라우드에 이 노트가 없습니다. 먼저 올려 주세요.' : '다른 탭에서 편집 중이라 맞추지 못했습니다.', r === 'applied' ? 'success' : 'info')
      } else {
        const r = await pushOneNote(docId)
        toast(r === 'diverged' ? '다른 기기에서도 바뀌어 이 기기 브랜치에만 올렸습니다(갈라짐). 머지 관리에서 합쳐 주세요.' : r === 'skipped' ? '바뀐 내용이 없어 올리지 않았습니다.' : `“${title}”을(를) 올렸습니다.`, r === 'ff' ? 'success' : 'info')
      }
      close()
    } catch (e) {
      toast(e instanceof Error ? e.message : '하지 못했습니다.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const LABEL: Record<ChangeAction, string> = { discard: '변경 버리기', align: '클라우드로 맞추기', push: '올리기' }
  const ICON: Record<ChangeAction, string> = { discard: 'undo', align: 'cloudDown', push: 'upload' }

  return (
    <div className="modal-backdrop changes-host" onPointerDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div className="sheet tall changes-sheet" role="dialog" aria-label="이 기기에서 바꾼 것">
        <header className="sheet-header">
          <h2>이 기기에서 바꾼 것 — {title || '제목 없음'}</h2>
          <button className="tb-btn" onClick={close} disabled={busy} aria-label="닫기">
            <Icon name="close" />
          </button>
        </header>

        <div className="changes-summary">
          {lc === undefined && !error && <span className="hint">비교하는 중…</span>}
          {error && <span className="hint warn">{error}</span>}
          {lc === null && <span className="hint">이 노트는 마지막으로 맞춘 기록이 없어 비교할 수 없습니다.</span>}
          {lc && lc.total === 0 && <span className="hint">마지막 동기화 이후 이 기기에서 바꾼 것이 없습니다.</span>}
          {lc && lc.total > 0 && (
            <>
              <span className="changes-chip add">새로 쓴 획 +{lc.added}</span>
              <span className="changes-chip del">지운 획 −{lc.removed}</span>
              {lc.modified > 0 && <span className="changes-chip mod">고친 획 {lc.modified}</span>}
              {lc.other > 0 && <span className="changes-chip">페이지·블록·제목 {lc.other}</span>}
              <label className="changes-all">
                <input type="checkbox" checked={allPages} onChange={(e) => setAllPages(e.target.checked)} /> 모든 페이지
              </label>
            </>
          )}
        </div>
        {lc && lc.total > 0 && (
          <p className="changes-legend">
            빛나는 테두리 — <i className="add" /> 새로 쓴 획(버리거나 덮으면 사라짐) <i className="del" /> 지운 획(버리거나 덮으면 돌아옴) <i className="mod" /> 고친 획
          </p>
        )}

        <div className="sheet-scroll changes-pages" ref={scroller}>
          {width > 0 &&
            pages.map((p, i) => (
              <section key={p.id} className="merge-page">
                <div className="merge-page-head">
                  <span>{p.page.sheet ? `보조 용지${p.page.sheet.title ? ` · ${p.page.sheet.title}` : ''}` : `p.${(lc?.local.doc.pageOrder.indexOf(p.id) ?? i) + 1}`}</span>
                  {p.changes > 0 && <span className="merge-page-changes">변경 {p.changes}</span>}
                </div>
                <PageCanvas
                  vp={p}
                  width={width}
                  visible={VISIBLE}
                  focus={null}
                  resultOnly={false}
                  outline
                  glow
                  colors={CHANGE_COLORS}
                  tool="view"
                  fingerTool={false}
                  selection={null}
                  editable={() => false}
                  onSelect={noop}
                  onMove={noop}
                  onErase={noop}
                  scroller={scroller.current}
                  pdfs={pdfs.current}
                />
              </section>
            ))}
        </div>

        <footer className="changes-foot">
          <button className="text-btn" onClick={close} disabled={busy}>
            {actions.length ? '그대로 두기' : '닫기'}
          </button>
          {actions.map((a) => (
            <button
              key={a}
              className={a === 'push' ? 'primary-btn' : 'text-btn danger'}
              disabled={busy || (a === 'discard' && !lc)}
              onClick={() => void run(a)}
            >
              <Icon name={ICON[a]} size={16} /> {LABEL[a]}
            </button>
          ))}
        </footer>
      </div>
    </div>
  )
}
