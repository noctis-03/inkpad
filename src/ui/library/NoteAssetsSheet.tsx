import { useEffect, useState, useRef } from 'react'
import { useUI } from '../../app/store'
import type { DocumentMeta, ID } from '../../shared/model'
import type { AssetRow } from '../../storage/db'
import { formatBytes } from '../../shared/util'
import { fetchAssetBlob } from '../../sync/assets'
import { assetFileName } from '../../sync/pack'
import { confirmTransfer } from '../../sync/transfer'
import { saveFile } from '../../io/download'
import { Icon } from '../Icon'
import { useEscClose, useSheetHeightMotion } from '../sheetParts'
import { noteAssetRows } from './parts'

const titleOf = (r: AssetRow) => r.name?.trim() || `${r.kind === 'pdf' ? 'PDF' : '이미지'} 원본 ${r.sha256.slice(0, 8)}`
const fileNameOf = (r: AssetRow) => r.name || assetFileName(r.sha256, r.mime).split('/').pop()!

/**
 * 원본 파일 저장 — 노트 카드 ⋯ 메뉴. 원본 관리 시트에서 그 노트의 원본을 찾지 않고 바로 기기에 저장한다.
 * 그 노트가 쓰는 PDF·이미지 원본을 줄마다 보이고, 각 줄의 「기기에 저장」은 원본 관리 시트의 '기기에 저장'과 같다:
 * 이 기기에 받아 둔 원본은 그대로 저장하고(네트워크 없음), 없으면 클라우드에서 받아 저장만 한다(앱에는 남기지 않는다)
 */
export function NoteAssetsSheet({ doc, onClose }: { doc: DocumentMeta; onClose: () => void }) {
  const toast = useUI((s) => s.toast)
  const [rows, setRows] = useState<AssetRow[] | null>(null)
  const [saving, setSaving] = useState<ID | null>(null)
  useEscClose(onClose, !saving)
  const sheetRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  useSheetHeightMotion(sheetRef, bodyRef)

  useEffect(() => {
    void noteAssetRows(doc.id).then((r) => setRows(r.sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'ko'))))
  }, [doc.id])

  /** 원본 관리 시트의 saveToDevice와 같은 순서 — 있으면 그대로, 없으면 (큰 전송 확인 후) 클라우드에서 받아 저장 */
  const saveToDevice = async (r: AssetRow) => {
    if (saving) return
    setSaving(r.id)
    try {
      if (!r.blob) {
        if (!navigator.onLine) {
          toast('오프라인이라 내려받을 수 없습니다. 연결된 뒤 다시 시도해 주세요.', 'error')
          return
        }
        if (!(await confirmTransfer('down', r.size))) return
      }
      await saveFile(await fetchAssetBlob(r), fileNameOf(r))
      toast(`"${titleOf(r)}" 원본을 기기에 저장했습니다.`, 'success')
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : '저장하지 못했습니다.', 'error')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <div className="modal note-assets" ref={sheetRef} role="dialog" aria-label="원본 파일 저장">
        <header className="note-assets-head">
          <div className="note-assets-head-text">
            <h2>원본 파일 저장</h2>
            <p className="note-assets-sub">「{doc.title}」에 쓰인 원본을 기기에 저장합니다.</p>
          </div>
          <button className="sheet-close" onClick={onClose} disabled={!!saving} aria-label="닫기">
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="note-assets-body" ref={bodyRef}>
          {rows && rows.length === 0 ? (
            <p className="note-assets-empty">이 노트는 PDF·이미지 원본을 쓰지 않습니다.</p>
          ) : (
            <div className="note-assets-list" role="list">
              {rows === null && <div className="note-assets-row skel" aria-hidden="true" />}
              {rows?.map((r) => (
                <div key={r.id} className="note-assets-row" role="listitem">
                  <span className={'note-assets-ico ' + r.kind} aria-hidden="true">
                    <Icon name={r.kind === 'pdf' ? 'filePdf' : 'photo'} size={18} />
                  </span>
                  <span className="nm">{titleOf(r)}</span>
                  <span className="sz">{formatBytes(r.size || 0)}</span>
                  <button className="row-act note-assets-save" disabled={!!saving} onClick={() => void saveToDevice(r)} title={r.blob ? '이 기기에 있는 원본을 저장합니다' : '클라우드에서 받아 저장합니다(앱에는 남기지 않습니다)'}>
                    {saving === r.id ? <span className="spinner sm" /> : <Icon name="download" size={16} />}
                    기기에 저장
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
