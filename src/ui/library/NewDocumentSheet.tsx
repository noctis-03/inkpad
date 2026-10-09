import { useState } from 'react'
import { Icon } from '../Icon'
import { createDocument } from '../../storage/repo'
import {
  BACKGROUND_LABELS,
  PAGE_SIZES,
  makeBackground,
  type BackgroundType,
  type DocumentMeta,
  type ID,
  type PageSizeKey
} from '../../shared/model'

const PAGED_BGS: BackgroundType[] = ['blank', 'lined', 'grid', 'dot', 'cornell']
const INFINITE_BGS: BackgroundType[] = ['dot', 'grid', 'lined', 'blank']

export function NewDocumentSheet(props: {
  folderId: ID | null
  /** 카테고리 뷰에서 만들면 그 카테고리를 기본값으로 */
  category?: string | null
  onClose: () => void
  onCreated: (d: DocumentMeta) => void
  onImportPdf: () => void
  onImportInkpad: () => void
  onAddApp: () => void
  onAddFile: () => void
}) {
  const [mode, setMode] = useState<'paged' | 'infinite'>('paged')
  const [title, setTitle] = useState('')
  const [sizeKey, setSizeKey] = useState<PageSizeKey>('a4')
  // 입력 중에는 문자열로 들고 있다가 blur·'만들기' 때 범위를 맞춘다 (A-3)
  const [customText, setCustomText] = useState({ w: '210', h: '297' }) // mm
  const [landscape, setLandscape] = useState(false)
  const [bg, setBg] = useState<BackgroundType>('lined')
  const [pageCountText, setPageCountText] = useState('1')

  const clampMm = (mm: number) => Math.max(50, Math.min(1000, mm))
  const customMm = () => ({ w: clampMm(Math.round(parseFloat(customText.w) || 0)), h: clampMm(Math.round(parseFloat(customText.h) || 0)) })
  const pageCountNum = () => Math.max(1, Math.min(200, Math.round(parseFloat(pageCountText) || 0)))
  const stepPage = (d: number) => setPageCountText(String(Math.max(1, Math.min(200, pageCountNum() + d))))

  const size = () => {
    const mm = customMm()
    const base =
      sizeKey === 'custom'
        ? { w: (mm.w * 72) / 25.4, h: (mm.h * 72) / 25.4 }
        : { w: PAGE_SIZES[sizeKey].w, h: PAGE_SIZES[sizeKey].h }
    return landscape ? { w: base.h, h: base.w } : base
  }

  const create = async () => {
    const t = title.trim() || (mode === 'infinite' ? '무한 캔버스' : '새 노트')
    const background = makeBackground(mode === 'infinite' && bg === 'cornell' ? 'dot' : bg, mode === 'infinite' ? 32 : 24)
    const s = size()
    const doc = await createDocument({
      title: t,
      mode,
      folderId: props.folderId,
      category: props.category ?? undefined,
      pages: Array.from({ length: mode === 'paged' ? pageCountNum() : 1 }, () => ({ size: mode === 'paged' ? s : null, background }))
    })
    props.onCreated(doc)
  }

  const bgs = mode === 'paged' ? PAGED_BGS : INFINITE_BGS

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="sheet" role="dialog" aria-label="새로 만들기">
        <header className="sheet-header">
          <h2>새로 만들기</h2>
          <button className="tb-btn" onClick={props.onClose} aria-label="닫기">
            <Icon name="close" />
          </button>
        </header>

        <div className="mode-cards">
          <button className={'mode-card' + (mode === 'paged' ? ' is-active' : '')} onClick={() => (setMode('paged'), setBg('lined'))}>
            <Icon name="notebook" size={30} />
            <strong>노트</strong>
            <small>페이지 단위 문서</small>
          </button>
          <button className={'mode-card' + (mode === 'infinite' ? ' is-active' : '')} onClick={() => (setMode('infinite'), setBg('dot'))}>
            <Icon name="infinite" size={30} />
            <strong>무한 캔버스</strong>
            <small>스케치, 마인드맵</small>
          </button>
          <button className="mode-card" onClick={props.onImportPdf}>
            <Icon name="filePdf" size={30} />
            <strong>PDF 가져오기</strong>
            <small>필기 후 PDF로 내보내기</small>
          </button>
          <button className="mode-card" onClick={props.onAddApp}>
            <Icon name="app" size={30} />
            <strong>HTML 앱 추가</strong>
            <small>단일 .html 파일 실행</small>
          </button>
          <button className="mode-card" onClick={props.onAddFile}>
            <Icon name="file" size={30} />
            <strong>파일 추가</strong>
            <small>이미지 · 텍스트 · PDF 등</small>
          </button>
        </div>

        <section className="sheet-section">
          <label className="field">
            <span>제목</span>
            <input id="new-doc-title" value={title} placeholder={mode === 'infinite' ? '무한 캔버스' : '새 노트'} onChange={(e) => setTitle(e.target.value)} />
          </label>

          {mode === 'paged' && (
            <>
              <div className="field">
                <span>페이지 크기</span>
                <div className="seg">
                  {(Object.keys(PAGE_SIZES) as (keyof typeof PAGE_SIZES)[]).map((k) => (
                    <button key={k} className={sizeKey === k ? 'is-active' : ''} onClick={() => setSizeKey(k)}>
                      {PAGE_SIZES[k].label}
                    </button>
                  ))}
                  <button className={sizeKey === 'custom' ? 'is-active' : ''} onClick={() => setSizeKey('custom')}>
                    사용자 지정
                  </button>
                </div>
              </div>
              {sizeKey === 'custom' && (
                <div className="field inline">
                  <span>크기 (mm)</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={50}
                    max={1000}
                    value={customText.w}
                    onChange={(e) => setCustomText({ ...customText, w: e.target.value })}
                    onBlur={() => setCustomText((t) => ({ ...t, w: String(customMm().w) }))}
                  />
                  ×
                  <input
                    type="number"
                    inputMode="numeric"
                    min={50}
                    max={1000}
                    value={customText.h}
                    onChange={(e) => setCustomText({ ...customText, h: e.target.value })}
                    onBlur={() => setCustomText((t) => ({ ...t, h: String(customMm().h) }))}
                  />
                </div>
              )}
              <div className="field">
                <span>방향</span>
                <div className="seg">
                  <button className={!landscape ? 'is-active' : ''} onClick={() => setLandscape(false)}>
                    세로
                  </button>
                  <button className={landscape ? 'is-active' : ''} onClick={() => setLandscape(true)}>
                    가로
                  </button>
                </div>
              </div>
              {/* 스테퍼 버튼이 안에 있으므로 label이 아니라 div로 그린다 (A-1과 같은 이유) */}
              <div className="field inline">
                <span>페이지 수</span>
                <div className="stepper">
                  <button type="button" className="stepper-btn" aria-label="페이지 수 줄이기" onClick={() => stepPage(-1)}>
                    −
                  </button>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={200}
                    value={pageCountText}
                    onChange={(e) => setPageCountText(e.target.value.replace(/[^0-9]/g, ''))}
                    onBlur={() => setPageCountText(String(pageCountNum()))}
                  />
                  <button type="button" className="stepper-btn" aria-label="페이지 수 늘리기" onClick={() => stepPage(1)}>
                    +
                  </button>
                </div>
              </div>
            </>
          )}

          <div className="field">
            <span>{mode === 'paged' ? '속지' : '배경'}</span>
            <div className="paper-picker">
              {bgs.map((t) => (
                <button key={t} className={'paper-option' + (bg === t ? ' is-active' : '')} onClick={() => setBg(t)}>
                  <span className={`paper-preview paper-${t}`} />
                  {BACKGROUND_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
        </section>

        <footer className="sheet-footer">
          <button className="text-btn" onClick={props.onImportInkpad}>
            <Icon name="upload" size={18} /> .inkpad / 백업 가져오기
          </button>
          <button id="create-doc-btn" className="primary-btn" onClick={create}>
            만들기
          </button>
        </footer>
      </div>
    </div>
  )
}
