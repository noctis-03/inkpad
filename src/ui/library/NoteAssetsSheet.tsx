import { useCallback, useEffect, useState } from 'react'
import { useUI } from '../../app/store'
import type { DocumentMeta, ID } from '../../shared/model'
import type { AssetRow } from '../../storage/db'
import { formatBytes } from '../../shared/util'
import { downloadMissing } from '../../sync/assets'
import { confirmTransfer } from '../../sync/transfer'
import { refreshAllThumbnailsWithToast } from '../../io/docThumb'
import { Icon } from '../Icon'
import { useEscClose, useOnline } from '../sheetParts'
import { noteAssetRows } from './parts'
import { collectAssetUsage, listDocuments } from '../../storage/repo'

const nameOf = (r: AssetRow) => r.name?.trim() || `${r.kind === 'pdf' ? 'PDF' : '이미지'} 원본 ${r.sha256.slice(0, 8)}`

/**
 * 이 노트의 원본 받기 — 노트 카드 ⋯ 메뉴의 「원본 파일 받기」.
 * 그 노트가 쓰는 PDF·이미지 원본을 보여 주고, 이 기기에 없는 것을 골라 받는다(원본 관리 시트의 '원본 받기'와 같은 받기 — 앱 저장소로).
 * 이 기기에 없는 것은 처음부터 골라 둔다. 받은 뒤 그 원본을 쓰는 노트들(이 노트만이 아니다)의 카드 미리보기를 다시 만든다
 */
export function NoteAssetsSheet({ doc, onClose }: { doc: DocumentMeta; onClose: () => void }) {
  const toast = useUI((s) => s.toast)
  const online = useOnline()
  const [rows, setRows] = useState<AssetRow[] | null>(null)
  const [picked, setPicked] = useState<Set<ID>>(new Set())
  const [busy, setBusy] = useState(false)
  useEscClose(onClose, !busy)

  const load = useCallback(async (first: boolean) => {
    const r = await noteAssetRows(doc.id)
    r.sort((a, b) => Number(!!a.blob) - Number(!!b.blob) || nameOf(a).localeCompare(nameOf(b), 'ko')) // 받을 것 먼저
    setRows(r)
    if (first) setPicked(new Set(r.filter((x) => !x.blob).map((x) => x.id)))
    else setPicked((p) => new Set([...p].filter((id) => r.some((x) => x.id === id && !x.blob))))
  }, [doc.id])
  useEffect(() => {
    void load(true)
  }, [load])

  const missing = (rows ?? []).filter((r) => !r.blob)
  const chosen = missing.filter((r) => picked.has(r.id))
  const bytes = chosen.reduce((n, r) => n + (r.size || 0), 0)
  const toggle = (id: ID) => setPicked((p) => (p.has(id) ? new Set([...p].filter((x) => x !== id)) : new Set([...p, id])))
  const allOn = missing.length > 0 && chosen.length === missing.length

  const receive = async () => {
    if (!chosen.length || busy) return
    if (!navigator.onLine) return toast('오프라인이라 원본을 받을 수 없습니다. 연결한 뒤 다시 시도해 주세요.', 'error')
    if (!(await confirmTransfer('down', bytes, chosen.length, '노트 원본'))) return
    setBusy(true)
    try {
      const r = await downloadMissing(chosen) // 받는 동안은 탭 바 상태 칸(전송)에 보인다
      if (r.authFailed) toast('Google 로그인이 만료되었습니다. 로그인한 뒤 다시 시도해 주세요.', 'error')
      else if (r.failed) toast(`원본 ${r.ok}개를 받았습니다. ${r.failed}개는 받지 못했습니다.`, 'error')
      else toast(`"${doc.title}"의 원본 ${r.ok}개를 받았습니다.`, 'success')
      if (r.ok) {
        // 원본이 없어 필기만 그렸던 미리보기를 실제 모습으로 — 같은 원본을 쓰는 다른 노트도 함께(전체 받기와 같다)
        const [usage, docs] = await Promise.all([collectAssetUsage(), listDocuments()])
        const live = new Set(docs.map((d) => d.id))
        const ids = new Set<ID>([doc.id])
        for (const a of chosen) for (const id of usage.get(a.id) ?? []) if (live.has(id)) ids.add(id)
        void refreshAllThumbnailsWithToast([...ids])
      }
      await load(false)
    } catch (e) {
      toast(`원본을 받지 못했습니다: ${(e as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal note-assets" role="dialog" aria-label="원본 파일 받기">
        <h2 className="modal-title">원본 파일 받기</h2>
        <p className="note-assets-sub">
          「{doc.title}」에 쓰인 원본 {rows ? `${rows.length}개` : ''}
          {rows && (missing.length ? ` · 이 기기에 없는 것 ${missing.length}개` : ' · 모두 이 기기에 있습니다')}
        </p>
        {!online && missing.length > 0 && <p className="note-assets-off">오프라인 — 연결되면 받을 수 있습니다.</p>}

        {missing.length > 1 && (
          <button className="note-assets-all" onClick={() => setPicked(allOn ? new Set() : new Set(missing.map((r) => r.id)))}>
            {allOn ? '모두 해제' : '받을 것 모두 고르기'}
          </button>
        )}

        <div className="note-assets-list" role="list">
          {rows === null && <div className="note-assets-row skel" aria-hidden="true" />}
          {rows?.map((r) => {
            const has = !!r.blob
            return (
              <label key={r.id} className={'note-assets-row' + (has ? ' has' : '')} role="listitem">
                <input
                  type="checkbox"
                  checked={has || picked.has(r.id)}
                  disabled={has || busy}
                  onChange={() => toggle(r.id)}
                  aria-label={`${nameOf(r)} ${has ? '— 이 기기에 있음' : '받기'}`}
                />
                <Icon name={r.kind === 'pdf' ? 'filePdf' : 'photo'} size={16} />
                <span className="nm">{nameOf(r)}</span>
                <span className="sz">{formatBytes(r.size || 0)}</span>
                <span className={'st' + (has ? ' ok' : '')}>{has ? '이 기기에 있음' : '클라우드'}</span>
              </label>
            )
          })}
        </div>

        <div className="modal-actions">
          <span className="push-total">{chosen.length ? `${chosen.length}개 · 약 ${formatBytes(bytes)}` : missing.length ? '받을 원본을 고르세요' : ''}</span>
          <button className="text-btn" onClick={onClose} disabled={busy}>
            닫기
          </button>
          <button className="primary-btn" onClick={() => void receive()} disabled={!chosen.length || busy || !online}>
            {busy ? <span className="spinner sm" /> : <Icon name="download" size={18} />} {chosen.length ? `${chosen.length}개 받기` : '받기'}
          </button>
        </div>
      </div>
    </div>
  )
}
