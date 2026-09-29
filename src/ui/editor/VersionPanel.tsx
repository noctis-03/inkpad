import { useCallback, useEffect, useState } from 'react'
import { useUI } from '../../app/store'
import { confirmDialog } from '../../app/dialogs'
import { formatDate } from '../../shared/util'
import type { ID } from '../../shared/model'
import { AuthRequiredError, SyncNotConfiguredError } from '../../sync/token'
import { syncNow } from '../../sync/sync'
import {
  deleteDocRevision,
  listDocRevisions,
  pinDocRevision,
  unpinDocRevision,
  restoreDocRevision,
  type DocRevision
} from '../../sync/revisions'
import { Icon } from '../Icon'

function fmtSize(n: number) {
  if (!n) return ''
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

export function VersionPanel({ docId }: { docId: ID }) {
  const close = useUI((s) => s.setPanel)
  const toast = useUI((s) => s.toast)
  const setBusy = useUI((s) => s.setBusy)
  const [revs, setRevs] = useState<DocRevision[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setRevs(await listDocRevisions(docId))
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

  const restore = async (r: DocRevision) => {
    if (
      !(await confirmDialog('이 버전으로 되돌리기', {
        message: `${formatDate(Date.parse(r.modifiedTime))} 시점으로 되돌립니다. 지금 내용은 버전 기록에 남습니다. (Drive 규칙상 옛 버전을 읽으려면 고정해야 해서, 되돌린 버전이 고정됨으로 표시됩니다) 되돌린 뒤 올리기를 누르면 다른 기기에도 반영됩니다.`,
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
              {[...revs].reverse().map((r) => (
                <li key={r.id} className={'rev-row' + (r.isHead ? ' is-head' : '')}>
                  <div className="rev-main">
                    <span className="rev-time">{formatDate(Date.parse(r.modifiedTime))}</span>
                    <span className="rev-tags">
                      {r.isHead && <span className="rev-tag head">현재</span>}
                      {r.keepForever && <span className="rev-tag pinned">고정됨</span>}
                      {r.size > 0 && <span className="rev-size">{fmtSize(r.size)}</span>}
                    </span>
                  </div>
                  <div className="rev-actions">
                    <button
                      className="text-btn small"
                      disabled={r.isHead || busyId === r.id}
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
              ))}
            </ul>
          </section>

          <section className="panel-section">
            <p className="hint">
              고정하지 않은 버전은 새 버전이 올라온 뒤 약 30일이 지나면 Google Drive가 자동으로 지웁니다. 고정은 파일당 최대 200개까지 가능하고 용량을 차지합니다. 맨 마지막
              버전(현재)은 삭제할 수 없습니다.
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
