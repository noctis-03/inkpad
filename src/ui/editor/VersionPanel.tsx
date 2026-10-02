import { useCallback, useEffect, useState } from 'react'
import { useUI } from '../../app/store'
import { confirmDialog } from '../../app/dialogs'
import { formatDate } from '../../shared/util'
import type { ID } from '../../shared/model'
import { db } from '../../storage/db'
import { AuthRequiredError, SyncNotConfiguredError } from '../../sync/token'
import { onSyncStatus, syncNow } from '../../sync/sync'
import { getSync } from '../../sync/folders'
import {
  deleteDocRevision,
  fetchRevisionTags,
  listDocRevisions,
  pinDocRevision,
  restoreDocRevision,
  unpinDocRevision,
  type DocRevision
} from '../../sync/revisions'
import { Icon } from '../Icon'

function fmtSize(n: number) {
  if (!n) return ''
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

/** 되돌림 표식 — 이 기기가 어느 리비전 위에 서 있는지 (기기별 로컬 전용) */
interface CurMarker {
  revId: string
  updatedAt: number
}

export function VersionPanel({ docId }: { docId: ID }) {
  const close = useUI((s) => s.setPanel)
  const toast = useUI((s) => s.toast)
  const setBusy = useUI((s) => s.setBusy)
  const [revs, setRevs] = useState<DocRevision[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [marker, setMarker] = useState<CurMarker | null>(null)
  const [docUpdatedAt, setDocUpdatedAt] = useState<number | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [list, cur, doc] = await Promise.all([
        listDocRevisions(docId),
        getSync<CurMarker>(`curRev:${docId}`),
        db.documents.get(docId)
      ])
      setRevs(list)
      setMarker(cur ?? null)
      setDocUpdatedAt(doc?.updatedAt ?? null)
      // 표식을 아직 못 읽은 고정 리비전은 내려받아 기기명·태그를 채운다 (하나씩 올 때마다 목록 갱신)
      if (list.some((r) => !r.tagged)) void fetchRevisionTags(docId, list, (next) => setRevs(next))
    } catch (e) {
      const msg =
        e instanceof AuthRequiredError
          ? '먼저 Google로 로그인해 주세요.'
          : e instanceof SyncNotConfiguredError
            ? '서버에 OAuth 설정이 없습니다.'
            : e instanceof Error
              ? e.message
              : '버전 기록을 가져오지 못했습니다.'
      setError(msg)
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

  // '현재' 해석: 되돌림 표식이 있고 그 리비전이 목록에 살아 있으면 그 행이 현재. 없으면 헤드가 현재.
  const curId = marker && revs?.some((r) => r.id === marker.revId) ? marker.revId : null
  // 되돌린 뒤 이 기기에서 다시 편집했으면 현재 내용은 그 리비전과도 다르다
  const stale = !!marker && docUpdatedAt != null && marker.updatedAt !== docUpdatedAt

  const restore = async (r: DocRevision) => {
    if (
      !(await confirmDialog('이 버전으로 되돌리기', {
        message: `${formatDate(Date.parse(r.modifiedTime))} 시점으로 되돌립니다. 지금 내용은 버전 기록에 남습니다. 되돌린 버전이 '현재'로 표시되고, 동기화로 올리면 다른 기기에도 반영됩니다. (Drive 규칙상 옛 버전을 읽으려면 고정해야 해서, 되돌린 버전이 고정됨으로 표시됩니다)`,
        ok: '되돌리기'
      }))
    )
      return
    setBusyId(r.id)
    setBusy({ text: '버전 불러오는 중' })
    try {
      await restoreDocRevision(docId, r.id)
      toast('되돌렸습니다. 동기화를 누르면 다른 기기에도 반영됩니다.', 'success', {
        label: '동기화',
        run: () => void syncNow()
      })
      await load()
    } catch (e) {
      toast(e instanceof Error ? e.message : '되돌리지 못했습니다.', 'error')
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
      toast(e instanceof Error ? e.message : '바꾸지 못했습니다.', 'error')
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
      toast(e instanceof Error ? e.message : '삭제하지 못했습니다.', 'error')
    } finally {
      setBusyId(null)
    }
  }

  const pinnedBytes = (revs ?? []).filter((r) => r.keepForever).reduce((s, r) => s + r.size, 0)

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
          <p className="hint">아직 버전 기록이 없습니다. 동기화로 문서를 올리면 그때부터 버전이 쌓입니다.</p>
        </section>
      )}

      {!error && revs && revs.length > 0 && (
        <>
          <section className="panel-section">
            <div className="setting-row">
              <span className="setting-label">
                버전 {revs.length}개
                <small>고정한 버전은 자동 삭제되지 않습니다</small>
              </span>
              <span className="setting-control">
                {pinnedBytes > 0 ? `${fmtSize(pinnedBytes)} 고정됨` : '고정 없음'}
              </span>
            </div>
          </section>

          <section className="panel-section">
            <ul className="rev-list">
              {[...revs].reverse().map((r) => {
                const isCur = r.id === curId
                return (
                  <li key={r.id} className={'rev-row' + (r.isHead ? ' is-head' : '')}>
                    <div className="rev-main">
                      <span className="rev-time">{formatDate(Date.parse(r.modifiedTime))}</span>
                      <span className="rev-tags">
                        {isCur && <span className="rev-tag head">현재</span>}
                        {isCur && stale && <span className="rev-tag edited">편집됨</span>}
                        {!isCur && r.isHead && <span className="rev-tag cloud">클라우드 최신</span>}
                        {r.revKind === 'merge' && <span className="rev-tag merged">머지됨</span>}
                        {r.revKind === 'merge-backup' && <span className="rev-tag dropped">버려짐</span>}
                        {r.revKind === 'restore' && <span className="rev-tag restored">되돌림</span>}
                        {r.keepForever && <span className="rev-tag pinned">고정됨</span>}
                        {r.conflicts ? <span className="rev-size">충돌 {r.conflicts}</span> : null}
                        {r.device && <span className="rev-size">{r.device}</span>}
                        {r.size > 0 && <span className="rev-size">{fmtSize(r.size)}</span>}
                      </span>
                    </div>
                    <div className="rev-actions">
                      <button
                        className="text-btn small"
                        disabled={isCur || (r.isHead && !curId) || busyId === r.id}
                        onClick={() => void restore(r)}
                      >
                        되돌리기
                      </button>
                      <button className="text-btn small" disabled={busyId === r.id} onClick={() => void togglePin(r)}>
                        {r.keepForever ? '고정 해제' : '고정'}
                      </button>
                      <button
                        className="text-btn small danger"
                        disabled={r.isHead || busyId === r.id}
                        onClick={() => void remove(r)}
                      >
                        삭제
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>

          <section className="panel-section">
            <p className="hint">
              되돌리면 그 버전이 이 기기의 '현재'가 되고, 동기화로 올리면 새 버전이 다시 '현재'가 됩니다. 버려짐은 머지에서 밀린 이 기기 편집의 백업, 머지됨은 머지 결과입니다.
              고정하지 않은 버전은 새 버전이 올라온 뒤 약 30일이 지나면 Google Drive가 자동으로 지웁니다. 고정은 파일당 최대 200개까지 가능하고 용량을 차지합니다. 맨 마지막
              버전(클라우드 최신)은 삭제할 수 없습니다.
            </p>
            <div className="btn-row">
              <button className="text-btn" onClick={() => void load()}>
                새로 고침
              </button>
            </div>
          </section>
        </>
      )}
    </aside>
  )
}
