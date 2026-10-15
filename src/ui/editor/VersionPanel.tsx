import { useCallback, useEffect, useState } from 'react'
import { useUI } from '../../app/store'
import { confirmDialog } from '../../app/dialogs'
import { formatBytesShort, formatDate } from '../../shared/util'
import type { ID } from '../../shared/model'
import { db } from '../../storage/db'
import { AuthRequiredError, SyncNotConfiguredError, getDeviceName } from '../../sync/token'
import { onSyncStatus, syncNow } from '../../sync/sync'
import { getSync } from '../../sync/folders'
import { packDocument } from '../../sync/pack'
import { deleteSnapshots, listSnapshots, type SnapshotInfo, type SnapshotWhy } from '../../sync/snapshots'
import {
  deleteDocRevision,
  fetchRevisionTags,
  listDocBranches,
  listDocRevisions,
  loadVersionFile,
  pinDocRevision,
  restoreVersion,
  unpinDocRevision,
  type DocBranch,
  type DocRevision,
  type VersionRef
} from '../../sync/revisions'
import { renderFilePreview } from '../../io/docThumb'
import { Icon } from '../Icon'

/** 되돌림 표식 — 이 기기가 어느 버전 위에 서 있는지 (기기별 로컬 전용) */
interface CurMarker {
  revId: string
  updatedAt: number
}

/** 펼쳐 본 미리보기 — 첫 페이지 그림과 지금 이 기기 노트 대비 획 증감 */
interface Preview {
  key: string
  loading?: boolean
  url?: string | null
  added?: number
  removed?: number
  error?: string
}

const WHY_LABEL: Record<SnapshotWhy, string> = { pull: '받기 전', align: '클라우드에 맞추기 전', merge: '머지 전', restore: '되돌리기 전' }

const errText = (e: unknown, fallback: string) =>
  e instanceof AuthRequiredError ? '먼저 Google로 로그인해 주세요.' : e instanceof SyncNotConfiguredError ? '서버에 OAuth 설정이 없습니다.' : e instanceof Error ? e.message : fallback

export function VersionPanel({ docId }: { docId: ID }) {
  const close = useUI((s) => s.setPanel)
  const toast = useUI((s) => s.toast)
  const setBusy = useUI((s) => s.setBusy)
  const [revs, setRevs] = useState<DocRevision[] | null>(null)
  const [branches, setBranches] = useState<DocBranch[]>([])
  const [snaps, setSnaps] = useState<SnapshotInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [marker, setMarker] = useState<CurMarker | null>(null)
  const [docUpdatedAt, setDocUpdatedAt] = useState<number | null>(null)
  const [myDevice, setMyDevice] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)

  useEffect(() => {
    void getDeviceName().then(setMyDevice)
  }, [])

  const load = useCallback(async () => {
    setError(null)
    // 이 기기 스냅샷은 네트워크 없이 — 오프라인이어도 되돌릴 수 있다
    const [cur, doc, snapList] = await Promise.all([getSync<CurMarker>(`curRev:${docId}`), db.documents.get(docId), listSnapshots(docId)])
    setMarker(cur ?? null)
    setDocUpdatedAt(doc?.updatedAt ?? null)
    setSnaps(snapList)
    try {
      const [list, br] = await Promise.all([listDocRevisions(docId), listDocBranches(docId).catch(() => [] as DocBranch[])])
      setRevs(list)
      setBranches(br)
      // 표식을 아직 못 읽은 고정 리비전은 내려받아 기기명·태그를 채운다 (하나씩 올 때마다 목록 갱신)
      if (list.some((r) => !r.tagged)) void fetchRevisionTags(docId, list, (next) => setRevs(next))
    } catch (e) {
      setError(errText(e, '버전 기록을 가져오지 못했습니다.'))
      setRevs(null)
    }
  }, [docId])

  useEffect(() => {
    void load()
  }, [load])

  // 동기화가 끝나면 목록을 다시 읽는다 — 되돌린 내용이 올라가면 새 헤드가 다시 '현재'가 된다
  useEffect(() => {
    const un = onSyncStatus((s) => {
      if (s === 'idle') void load()
    })
    return un
  }, [load])

  // 미리보기 그림 주소는 닫을 때 정리한다
  useEffect(() => () => void (preview?.url && URL.revokeObjectURL(preview.url)), [preview?.url])

  // '현재' 해석: 되돌림 표식이 있고 그 리비전이 목록에 살아 있으면 그 행이 현재. 없으면 헤드가 현재.
  const curId = marker && revs?.some((r) => r.id === marker.revId) ? marker.revId : null
  // 되돌린 뒤 이 기기에서 다시 편집했으면 현재 내용은 그 리비전과도 다르다
  const stale = !!marker && docUpdatedAt != null && marker.updatedAt !== docUpdatedAt

  const showPreview = async (key: string, ref: VersionRef) => {
    if (preview?.key === key) return setPreview(null) // 다시 누르면 접는다
    setPreview({ key, loading: true })
    try {
      const file = await loadVersionFile(docId, ref)
      const ids = (f: { chunks: { elements: { id: string }[] }[] }) => new Set(f.chunks.flatMap((c) => c.elements.map((e) => e.id)))
      const there = ids(file)
      const here = ids(await packDocument(docId).catch(() => ({ chunks: [] })))
      const blob = await renderFilePreview(file).catch(() => null)
      setPreview({
        key,
        url: blob ? URL.createObjectURL(blob) : null,
        added: [...there].filter((id) => !here.has(id)).length,
        removed: [...here].filter((id) => !there.has(id)).length
      })
    } catch (e) {
      setPreview({ key, error: errText(e, '미리 보지 못했습니다.') })
    }
  }

  const restore = async (key: string, ref: VersionRef, when: string) => {
    if (
      !(await confirmDialog('이 버전으로 되돌리기', {
        message: `${when} 내용으로 되돌립니다. 지금 이 기기 내용은 스냅샷으로 남아 다시 되돌릴 수 있습니다. 되돌린 내용은 '올릴 것'이 되고, 동기화로 올리면 다른 기기에도 반영됩니다.${
          ref.kind === 'rev' ? ' (옛 버전을 Drive가 고정해야만 내준다면 자동으로 고정하고, 보관함 관리에서 정리할 수 있습니다)' : ''
        }`,
        ok: '되돌리기'
      }))
    )
      return
    setBusyId(key)
    setBusy({ text: '버전 불러오는 중' })
    try {
      await restoreVersion(docId, ref)
      toast('되돌렸습니다. 동기화를 누르면 다른 기기에도 반영됩니다.', 'success', {
        label: '동기화',
        run: () => void syncNow()
      })
      setPreview(null)
      await load()
    } catch (e) {
      toast(errText(e, '되돌리지 못했습니다.'), 'error')
    } finally {
      setBusy(null)
      setBusyId(null)
    }
  }

  const togglePin = async (r: DocRevision) => {
    setBusyId(r.id)
    try {
      if (r.keepForever) {
        await unpinDocRevision(docId, r.id)
        toast('고정을 해제했습니다.', 'success')
      } else {
        await pinDocRevision(docId, r.id)
        toast('이 버전을 고정했습니다.', 'success')
      }
      await load()
    } catch (e) {
      toast(errText(e, '바꾸지 못했습니다.'), 'error')
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (r: DocRevision) => {
    if (
      !(await confirmDialog('버전 삭제', {
        message: `${formatDate(Date.parse(r.modifiedTime))} 시점의 기록을 완전히 삭제합니다. 되돌릴 수 없습니다.`,
        ok: '삭제',
        danger: true
      }))
    )
      return
    setBusyId(r.id)
    try {
      await deleteDocRevision(docId, r.id)
      toast('버전을 삭제했습니다.', 'success')
      await load()
    } catch (e) {
      toast(errText(e, '삭제하지 못했습니다.'), 'error')
    } finally {
      setBusyId(null)
    }
  }

  const removeSnapshot = async (s: SnapshotInfo) => {
    await deleteSnapshots([s.id])
    if (preview?.key === s.id) setPreview(null)
    setSnaps(await listSnapshots(docId))
  }

  const previewBlock = (key: string) =>
    preview?.key === key && (
      <div className="rev-preview">
        {preview.loading ? (
          <span className="hint">불러오는 중…</span>
        ) : preview.error ? (
          <span className="hint warn">{preview.error}</span>
        ) : (
          <>
            {preview.url ? <img src={preview.url} alt="첫 페이지 미리보기" /> : <span className="hint">그릴 수 있는 첫 페이지가 없습니다.</span>}
            <span className="rev-diff">
              지금 이 기기 대비 <b className="plus">획 +{preview.added}</b> <b className="minus">−{preview.removed}</b>
            </span>
          </>
        )}
      </div>
    )

  const pinnedBytes = (revs ?? []).filter((r) => r.keepForever && !r.backupFileId).reduce((s, r) => s + r.size, 0)

  return (
    <aside id="version-panel" className="side-panel" aria-label="버전 기록">
      <header className="panel-header">
        <h2>버전 기록</h2>
        <button className="tb-btn" onClick={() => close('history')} aria-label="닫기">
          <Icon name="close" />
        </button>
      </header>

      {error && (
        <section className="panel-section">
          <p className="hint warn">{error}</p>
          <div className="btn-row">
            <button className="text-btn" onClick={() => void load()}>
              다시 시도
            </button>
          </div>
        </section>
      )}

      {!error && revs === null && (
        <section className="panel-section">
          <p className="hint">버전 기록을 불러오는 중…</p>
        </section>
      )}

      {!error && revs && revs.length === 0 && (
        <section className="panel-section">
          <p className="hint">아직 클라우드 버전 기록이 없습니다. 동기화로 문서를 올리면 그때부터 버전이 쌓입니다.</p>
        </section>
      )}

      {!error && revs && revs.length > 0 && (
        <>
          <section className="panel-section">
            <div className="setting-row">
              <span className="setting-label">
                클라우드 버전 {revs.length}개<small>main 노트 파일의 기록 · 고정한 버전은 자동 삭제되지 않습니다</small>
              </span>
              <span className="setting-control">{pinnedBytes > 0 ? `${formatBytesShort(pinnedBytes)} 고정됨` : '고정 없음'}</span>
            </div>
          </section>

          <section className="panel-section">
            <ul className="rev-list">
              {[...revs].reverse().map((r) => {
                const isCur = r.id === curId
                const when = formatDate(Date.parse(r.modifiedTime))
                return (
                  <li key={r.id} className={'rev-row' + (r.isHead ? ' is-head' : '')}>
                    <div className="rev-main">
                      <span className="rev-time">{when}</span>
                      <span className="rev-tags">
                        {isCur && <span className="rev-tag head">현재</span>}
                        {isCur && stale && <span className="rev-tag edited">편집됨</span>}
                        {!isCur && r.isHead && <span className="rev-tag cloud">클라우드 최신</span>}
                        {r.revKind === 'merge' && <span className="rev-tag merged">머지됨</span>}
                        {r.revKind === 'merge-backup' && <span className="rev-tag dropped">버려짐</span>}
                        {r.revKind === 'restore' && <span className="rev-tag restored">되돌림</span>}
                        {r.backupFileId ? <span className="rev-tag pinned">별도 보관</span> : r.keepForever && <span className="rev-tag pinned">고정됨</span>}
                        {r.conflicts ? <span className="rev-size">충돌 {r.conflicts}</span> : null}
                        {/* 이 기기가 올린 버전 → 태그로, 다른 기기가 올렸고 이름을 알면 → 기기명으로, 모르면 → 표시 없음 */}
                        {r.device && (r.device === myDevice ? <span className="rev-tag mine">이 기기에서 올림</span> : <span className="rev-size">{r.device}</span>)}
                        {r.size > 0 && <span className="rev-size">{formatBytesShort(r.size)}</span>}
                      </span>
                    </div>
                    <div className="rev-actions">
                      <button className="text-btn small" disabled={busyId === r.id} onClick={() => void showPreview(r.id, { kind: 'rev', id: r.id })}>
                        미리보기
                      </button>
                      <button className="text-btn small" disabled={isCur || (r.isHead && !curId) || busyId === r.id} onClick={() => void restore(r.id, { kind: 'rev', id: r.id }, when)}>
                        되돌리기
                      </button>
                      {!r.backupFileId && (
                        <button className="text-btn small" disabled={busyId === r.id} onClick={() => void togglePin(r)}>
                          {r.keepForever ? '고정 해제' : '고정'}
                        </button>
                      )}
                      <button className="text-btn small danger" disabled={r.isHead || busyId === r.id} onClick={() => void remove(r)}>
                        삭제
                      </button>
                    </div>
                    {previewBlock(r.id)}
                  </li>
                )
              })}
            </ul>
          </section>
        </>
      )}

      {branches.length > 0 && (
        <section className="panel-section">
          <h3 className="rev-section-title">기기 브랜치</h3>
          <p className="hint">기기마다 마지막으로 올린 이 노트 — 머지 전 그 기기의 모습입니다.</p>
          <ul className="rev-list">
            {branches.map((b) => {
              const key = 'branch:' + b.fileId
              const when = formatDate(b.at)
              return (
                <li key={b.fileId} className="rev-row">
                  <div className="rev-main">
                    <span className="rev-time">{when}</span>
                    <span className="rev-tags">
                      {b.mine ? <span className="rev-tag mine">이 기기 브랜치</span> : <span className="rev-tag cloud">{b.device} 브랜치</span>}
                      <span className="rev-size">#{b.seq}</span>
                      {b.size > 0 && <span className="rev-size">{formatBytesShort(b.size)}</span>}
                    </span>
                  </div>
                  <div className="rev-actions">
                    <button className="text-btn small" disabled={busyId === key} onClick={() => void showPreview(key, { kind: 'branch', fileId: b.fileId })}>
                      미리보기
                    </button>
                    <button className="text-btn small" disabled={busyId === key} onClick={() => void restore(key, { kind: 'branch', fileId: b.fileId }, `${b.device} 브랜치(${when})`)}>
                      되돌리기
                    </button>
                  </div>
                  {previewBlock(key)}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <section className="panel-section">
        <h3 className="rev-section-title">이 기기 스냅샷 {snaps.length > 0 && <small>{snaps.length}개</small>}</h3>
        {snaps.length === 0 ? (
          <p className="hint">받기·맞추기·머지·되돌리기로 이 기기 노트가 덮이기 직전에 자동으로 남습니다. 아직 없습니다.</p>
        ) : (
          <ul className="rev-list">
            {snaps.map((s) => {
              const when = formatDate(s.at)
              return (
                <li key={s.id} className="rev-row">
                  <div className="rev-main">
                    <span className="rev-time">{when}</span>
                    <span className="rev-tags">
                      <span className="rev-tag restored">{WHY_LABEL[s.why]}</span>
                      <span className="rev-size">획 {s.strokes}</span>
                      <span className="rev-size">{formatBytesShort(s.size)}</span>
                    </span>
                  </div>
                  <div className="rev-actions">
                    <button className="text-btn small" disabled={busyId === s.id} onClick={() => void showPreview(s.id, { kind: 'snapshot', id: s.id })}>
                      미리보기
                    </button>
                    <button className="text-btn small" disabled={busyId === s.id} onClick={() => void restore(s.id, { kind: 'snapshot', id: s.id }, `이 기기 스냅샷(${when}, ${WHY_LABEL[s.why]})`)}>
                      되돌리기
                    </button>
                    <button className="text-btn small danger" disabled={busyId === s.id} onClick={() => void removeSnapshot(s)}>
                      삭제
                    </button>
                  </div>
                  {previewBlock(s.id)}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="panel-section">
        <p className="hint">
          되돌리면 그 내용이 이 기기의 '현재'가 되고(지금 내용은 스냅샷으로 남는다), 동기화로 올리면 다른 기기에도 반영됩니다. 머지됨은 머지 결과, 되돌림은 되돌린 내용을 올린 버전입니다.
          버려짐·별도 보관은 자동 머지를 쓰던 때의 머지 백업입니다. 고정하지 않은 클라우드 버전은 새 버전이 올라온 뒤 약 30일이 지나면 Google Drive가 자동으로 지웁니다. 고정은
          파일당 최대 200개까지 가능하고 용량을 차지합니다. 스냅샷은 이 기기에만 노트당 최근 20개까지 남습니다. 정리는 동기화 › 보관함 관리에서 합니다.
        </p>
        <div className="btn-row">
          <button className="text-btn" onClick={() => void load()}>
            새로 고침
          </button>
        </div>
      </section>
    </aside>
  )
}
