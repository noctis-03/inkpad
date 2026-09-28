import { useState } from 'react'
import type { Engine } from '../../engine/engine'
import { useUI } from '../../app/store'
import { askPdfPassword, confirmDialog } from '../../app/dialogs'
import { BACKGROUND_LABELS, PAGE_SIZES, makeBackground, type BackgroundType, type DocumentMeta } from '../../shared/model'
import { Icon } from '../Icon'
import { pickFiles } from '../../io/download'
import { pdfPagesFor, readPdf } from '../../io/pdfImport'
import { closePdf } from '../../engine/pdf/pdfjs'

const PAGED: BackgroundType[] = ['blank', 'lined', 'grid', 'dot', 'cornell']
const INFINITE: BackgroundType[] = ['dot', 'grid', 'lined', 'blank']

export function PagePanel({ engine, doc }: { engine: Engine; doc: DocumentMeta }) {
  const close = useUI((s) => s.setPanel)
  const view = useUI((s) => s.view)
  const toast = useUI((s) => s.toast)
  const setBusy = useUI((s) => s.setBusy)
  const [scope, setScope] = useState<'current' | 'all'>('current')
  const paged = doc.mode === 'paged'
  const page = engine.pages[paged ? view.currentPage : 0]
  const isPdf = !!page?.pdf

  const indices = () => (scope === 'all' ? undefined : [view.currentPage])

  const setBg = (t: BackgroundType) => {
    if (!paged) {
      engine.setBackground(makeBackground(t, t === 'dot' ? 32 : 32), [0])
      return
    }
    engine.setBackground(makeBackground(t), indices())
  }

  const setSize = (w: number, h: number) => engine.setPageSize({ w, h }, indices())

  const orient = (landscape: boolean) => {
    const targets = scope === 'all' ? engine.pages : [page]
    for (const p of targets) {
      if (!p?.size || p.pdf) continue
      const { w, h } = p.size
      const isLand = w > h
      if (isLand !== landscape) engine.setPageSize({ w: h, h: w }, [engine.pages.indexOf(p)])
    }
  }

  const insertPdf = async () => {
    const [f] = await pickFiles('application/pdf,.pdf')
    if (!f) return
    try {
      setBusy({ text: `${f.name} 읽는 중`, progress: 0 })
      const info = await readPdf(f, f.name, askPdfPassword, (p) => setBusy({ text: `${f.name} 읽는 중`, progress: p }))
      if (info.failedPages.length && !(await confirmDialog('일부 페이지를 읽을 수 없습니다', { message: `${info.pages.length}개 페이지만 삽입할까요?` }))) return
      const pages = pdfPagesFor(doc.id, info)
      await closePdf(info.pdf)
      engine.insertPages(view.currentPage, pages)
      toast(`${pages.length}개 페이지를 삽입했습니다.`, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'PDF를 삽입하지 못했습니다.', 'error')
    } finally {
      setBusy(null)
    }
  }

  const bgType = page?.background.type

  return (
    <aside id="page-panel" className="side-panel" aria-label="페이지 설정">
      <header className="panel-header">
        <h2>{paged ? '페이지' : '배경'}</h2>
        <button className="tb-btn" onClick={() => close('page')} aria-label="닫기">
          <Icon name="close" />
        </button>
      </header>

      {paged && (
        <section className="panel-section">
          <div className="seg full">
            <button className={scope === 'current' ? 'is-active' : ''} onClick={() => setScope('current')}>
              현재 페이지 ({view.currentPage + 1})
            </button>
            <button className={scope === 'all' ? 'is-active' : ''} onClick={() => setScope('all')}>
              모든 페이지
            </button>
          </div>
          {isPdf && scope === 'current' && <p className="hint">PDF 페이지는 속지와 크기를 바꿀 수 없습니다.</p>}
        </section>
      )}

      <section className="panel-section">
        <h3>{paged ? '속지' : '배경'}</h3>
        <div className="paper-picker">
          {(paged ? PAGED : INFINITE).map((t) => (
            <button key={t} className={'paper-option' + (bgType === t ? ' is-active' : '')} onClick={() => setBg(t)} disabled={paged && isPdf && scope === 'current'}>
              <span className={`paper-preview paper-${t}`} />
              {BACKGROUND_LABELS[t]}
            </button>
          ))}
        </div>
      </section>

      {paged && (
        <>
          <section className="panel-section">
            <h3>크기</h3>
            <div className="btn-row">
              {(Object.keys(PAGE_SIZES) as (keyof typeof PAGE_SIZES)[]).map((k) => (
                <button
                  key={k}
                  className="text-btn"
                  disabled={isPdf && scope === 'current'}
                  onClick={() => {
                    const land = page?.size ? page.size.w > page.size.h : false
                    const s = PAGE_SIZES[k]
                    setSize(land ? s.h : s.w, land ? s.w : s.h)
                  }}
                >
                  {PAGE_SIZES[k].label}
                </button>
              ))}
            </div>
            <div className="btn-row" style={{ marginTop: 8 }}>
              <button className="text-btn" disabled={isPdf && scope === 'current'} onClick={() => orient(false)}>
                세로
              </button>
              <button className="text-btn" disabled={isPdf && scope === 'current'} onClick={() => orient(true)}>
                가로
              </button>
            </div>
          </section>
          <section className="panel-section">
            <h3>페이지</h3>
            <div className="btn-row">
              <button className="text-btn" onClick={() => engine.addPage(view.currentPage)}>
                <Icon name="plus" size={16} /> 뒤에 새 페이지
              </button>
              <button className="text-btn" onClick={() => engine.duplicatePage(view.currentPage)}>
                <Icon name="copy" size={16} /> 복제
              </button>
              <button className="text-btn" onClick={insertPdf}>
                <Icon name="filePdf" size={16} /> PDF 페이지 삽입
              </button>
              <button
                className="text-btn danger"
                disabled={view.pageCount <= 1}
                onClick={async () => {
                  if (await confirmDialog(`${view.currentPage + 1}페이지 삭제`, { message: '실행 취소로 되돌릴 수 있습니다.', ok: '삭제', danger: true }))
                    engine.deletePage(view.currentPage)
                }}
              >
                <Icon name="trash" size={16} /> 삭제
              </button>
            </div>
          </section>
        </>
      )}
    </aside>
  )
}
