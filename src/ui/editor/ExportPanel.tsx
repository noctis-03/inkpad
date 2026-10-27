import { useState, useSyncExternalStore } from 'react'
import type { Engine } from '../../engine/engine'
import { useUI } from '../../app/store'
import { askPdfPassword } from '../../app/dialogs'
import type { DocumentMeta } from '../../shared/model'
import { parsePageRange } from '../../shared/util'
import { Icon } from '../Icon'
import { exportDocumentPdf } from '../../io/pdfExport'
import { exportInkpad } from '../../io/inkpadFormat'
import { saveFile } from '../../io/download'
import { trackActivity } from '../../shared/activity'

export function ExportPanel({ engine, doc }: { engine: Engine; doc: DocumentMeta }) {
  const close = useUI((s) => s.setPanel)
  const view = useUI((s) => s.view)
  const toast = useUI((s) => s.toast)
  const [range, setRange] = useState<'all' | 'current' | 'custom'>('all')
  const [custom, setCustom] = useState('')
  const [pattern, setPattern] = useState(true)
  // 보조 용지는 페이지가 아니라 기본은 빼고 내보낸다. 붙은(snap) 용지만 넣을 수 있다
  const [withSheets, setWithSheets] = useState(false)
  useSyncExternalStore(engine.subscribeSheets, engine.sheetsVersion)
  const snapped = engine.sheets.filter((s) => s.sheet!.snap).length
  const floating = engine.sheets.length - snapped
  // 살아 있는 블록 수 — 1개 이상이면 PDF 섹션에 제외 안내를 표시한다
  const blockCount = useSyncExternalStore(engine.blocks.subscribe, () => engine.blocks.list().length)
  const paged = doc.mode === 'paged'

  const exportPdf = async () => {
    let pageIndices: number[] | undefined
    if (paged && range === 'current') pageIndices = [view.currentPage]
    else if (paged && range === 'custom') {
      const r = parsePageRange(custom, view.pageCount)
      if (!r || !r.length) return toast('페이지 범위를 확인해 주세요. 예: 1-3, 5', 'error')
      pageIndices = r
    }
    try {
      await engine.flush()
      // 화면을 막지 않고 탭 바 상태 칸(전송)에 보인다
      const blob = await trackActivity('export', `${doc.title}.pdf`, (a) =>
        exportDocumentPdf(doc.id, {
          pageIndices,
          includePattern: pattern,
          includeSheets: withSheets,
          askPassword: askPdfPassword,
          onProgress: (d, t, phase) => a.update({ detail: phase, progress: t ? d / t : undefined })
        }))
      await saveFile(blob, `${doc.title}.pdf`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const oom = /memory|allocation|RangeError/i.test(msg)
      toast(oom ? '메모리가 부족합니다. 페이지 범위를 나눠서 내보내 보세요.' : `PDF 내보내기 실패: ${msg}`, 'error')
    }
  }

  const exportOwn = async () => {
    try {
      await engine.flush()
      const blob = await trackActivity('export', `${doc.title}.inkpad`, () => exportInkpad([doc.id], 'document'))
      await saveFile(blob, `${doc.title}.inkpad`)
    } catch (e) {
      toast(e instanceof Error ? e.message : '내보내기 실패', 'error')
    }
  }

  return (
    <aside id="export-panel" className="side-panel" aria-label="내보내기">
      <header className="panel-header">
        <h2>내보내기</h2>
        <button className="tb-btn" onClick={() => close('export')} aria-label="닫기">
          <Icon name="close" />
        </button>
      </header>
      <section className="panel-section">
        <h3>PDF</h3>
        <p className="hint">
          {paged ? '원본 PDF 위에 필기를 벡터로 합칩니다. 원본 PDF는 바뀌지 않습니다.' : '필기가 있는 영역 전체를 PDF 1페이지로 내보냅니다.'}
        </p>
        {blockCount > 0 && (
          <p className="hint block-export-note">
            <Icon name="noPdf" size={14} /> 메모·링크 등 블록 {blockCount}개는 PDF에 포함되지 않습니다.
          </p>
        )}
        {paged && (
          <>
            <div className="seg full" style={{ marginTop: 10 }}>
              <button className={range === 'all' ? 'is-active' : ''} onClick={() => setRange('all')}>
                전체 ({view.pageCount})
              </button>
              <button className={range === 'current' ? 'is-active' : ''} onClick={() => setRange('current')}>
                현재 ({view.currentPage + 1})
              </button>
              <button className={range === 'custom' ? 'is-active' : ''} onClick={() => setRange('custom')}>
                범위
              </button>
            </div>
            {range === 'custom' && (
              <input className="modal-input" placeholder="예: 1-3, 5, 8-" value={custom} onChange={(e) => setCustom(e.target.value)} style={{ marginTop: 8 }} />
            )}
            <label className="setting-row">
              <span className="setting-label">속지 무늬 포함</span>
              <input type="checkbox" className="switch" checked={pattern} onChange={(e) => setPattern(e.target.checked)} />
            </label>
            {engine.sheets.length > 0 && (
              <>
                <label className="setting-row">
                  <span className="setting-label">보조 용지 포함</span>
                  <input type="checkbox" className="switch" checked={withSheets} disabled={!snapped} onChange={(e) => setWithSheets(e.target.checked)} />
                </label>
                <p className="hint">
                  {snapped
                    ? `페이지에 붙은 용지 ${snapped}장을 페이지 옆에 붙여 넓은 페이지로 내보냅니다.`
                    : '페이지에 붙은 용지가 없습니다. 용지를 페이지 왼쪽·오른쪽에 붙이면 함께 내보낼 수 있습니다.'}
                  {floating > 0 && ` 떠 있는 용지 ${floating}장은 넣지 않습니다.`}
                </p>
              </>
            )}
          </>
        )}
        <button id="export-pdf-btn" className="primary-btn full" onClick={exportPdf}>
          <Icon name="filePdf" size={18} /> PDF로 내보내기
        </button>
      </section>
      <section className="panel-section">
        <h3>Inkpad 파일</h3>
        <p className="hint">필기 데이터와 PDF 원본을 그대로 담은 .inkpad 파일입니다. 다른 기기에서 가져와 이어서 편집할 수 있습니다. 메모·링크 등 블록도 함께 담깁니다.</p>
        <button className="text-btn full" onClick={exportOwn}>
          <Icon name="download" size={18} /> .inkpad로 내보내기
        </button>
      </section>
    </aside>
  )
}
