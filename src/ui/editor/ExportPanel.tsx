import { useState } from 'react'
import type { Engine } from '../../engine/engine'
import { useUI } from '../../app/store'
import { askPdfPassword } from '../../app/dialogs'
import type { DocumentMeta } from '../../shared/model'
import { parsePageRange } from '../../shared/util'
import { Icon } from '../Icon'
import { exportDocumentPdf } from '../../io/pdfExport'
import { exportInkpad } from '../../io/inkpadFormat'
import { saveFile } from '../../io/download'

export function ExportPanel({ engine, doc }: { engine: Engine; doc: DocumentMeta }) {
  const close = useUI((s) => s.setPanel)
  const view = useUI((s) => s.view)
  const toast = useUI((s) => s.toast)
  const setBusy = useUI((s) => s.setBusy)
  const [range, setRange] = useState<'all' | 'current' | 'custom'>('all')
  const [custom, setCustom] = useState('')
  const [pattern, setPattern] = useState(true)
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
      setBusy({ text: 'PDF 만드는 중', progress: 0 })
      const blob = await exportDocumentPdf(doc.id, {
        pageIndices,
        includePattern: pattern,
        askPassword: askPdfPassword,
        onWarning: (m) => toast(m, 'info'),
        onProgress: (d, t, phase) => setBusy({ text: phase, progress: t ? d / t : undefined })
      })
      setBusy(null)
      await saveFile(blob, `${doc.title}.pdf`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const oom = /memory|allocation|RangeError/i.test(msg)
      toast(oom ? '메모리가 부족합니다. 페이지 범위를 나눠서 내보내 보세요.' : `PDF 내보내기 실패: ${msg}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const exportOwn = async () => {
    try {
      await engine.flush()
      setBusy({ text: '내보내는 중' })
      const blob = await exportInkpad([doc.id], 'document')
      setBusy(null)
      await saveFile(blob, `${doc.title}.inkpad`)
    } catch (e) {
      toast(e instanceof Error ? e.message : '내보내기 실패', 'error')
    } finally {
      setBusy(null)
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
          </>
        )}
        <button id="export-pdf-btn" className="primary-btn full" onClick={exportPdf}>
          <Icon name="filePdf" size={18} /> PDF로 내보내기
        </button>
      </section>
      <section className="panel-section">
        <h3>Inkpad 파일</h3>
        <p className="hint">필기 데이터와 PDF 원본을 그대로 담은 .inkpad 파일입니다. 다른 기기에서 가져와 이어서 편집할 수 있습니다.</p>
        <button className="text-btn full" onClick={exportOwn}>
          <Icon name="download" size={18} /> .inkpad로 내보내기
        </button>
      </section>
    </aside>
  )
}
