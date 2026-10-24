// 문서(text 모드) 내보내기 — Markdown(.md) · PDF(인쇄) · .inkpad
import { useUI } from '../../app/store'
import { saveFile } from '../../io/download'
import { exportInkpad } from '../../io/inkpadFormat'
import type { DocumentMeta } from '../../shared/model'
import { blocksToMarkdown } from '../../textdoc/markdown'
import type { TextDocModel } from '../../textdoc/model'
import { printTextDoc } from '../../textdoc/print'
import { Icon } from '../Icon'

export function TextExportPanel({ model, doc }: { model: TextDocModel; doc: DocumentMeta }) {
  const close = useUI((s) => s.setPanel)
  const toast = useUI((s) => s.toast)
  const setBusy = useUI((s) => s.setBusy)
  const title = doc.title || '제목 없음'

  const exportMd = async () => {
    try {
      model.commitTyping()
      const md = blocksToMarkdown(title, model.blocks)
      await saveFile(new Blob([md], { type: 'text/markdown;charset=utf-8' }), `${title}.md`)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Markdown으로 내보내지 못했습니다.', 'error')
    }
  }

  const exportPdf = () => {
    model.commitTyping()
    printTextDoc(title, model.blocks)
  }

  const exportOwn = async () => {
    try {
      await model.flush()
      setBusy({ text: '내보내는 중' })
      const blob = await exportInkpad([doc.id], 'document')
      setBusy(null)
      await saveFile(blob, `${title}.inkpad`)
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
        <h3>Markdown</h3>
        <p className="hint">노션·옵시디언 같은 다른 앱으로 옮기기 좋은 .md 파일입니다. 제목·목록·할 일·인용·코드·굵게·링크를 그대로 옮기고, 토글은 글머리 목록이 됩니다.</p>
        <button id="export-md-btn" className="primary-btn full" onClick={() => void exportMd()}>
          <Icon name="download" size={18} /> Markdown으로 내보내기
        </button>
      </section>
      <section className="panel-section">
        <h3>PDF</h3>
        <p className="hint">인쇄 창이 열리면 'PDF로 저장'을 고르세요 (iPad는 공유 단추 → 파일에 저장). 접어 둔 토글도 펼쳐서 싣습니다.</p>
        <button id="export-pdf-btn" className="text-btn full" onClick={exportPdf}>
          <Icon name="filePdf" size={18} /> PDF로 저장 (인쇄)
        </button>
      </section>
      <section className="panel-section">
        <h3>Inkpad 파일</h3>
        <p className="hint">문서를 그대로 담은 .inkpad 파일입니다. 다른 기기에서 가져와 이어서 편집할 수 있습니다.</p>
        <button className="text-btn full" onClick={() => void exportOwn()}>
          <Icon name="download" size={18} /> .inkpad로 내보내기
        </button>
      </section>
    </aside>
  )
}
