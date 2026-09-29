import { useCallback, useEffect, useState } from 'react'
import { useUI } from '../../app/store'
import { confirmDialog } from '../../app/dialogs'
import { formatDate } from '../../shared/util'
import type { ID } from '../../shared/model'
import { AuthRequiredError, SyncNotConfiguredError } from '../../sync/token'
import { syncNow } from '../../sync/sync'
import { listDocRevisions, restoreDocRevision, type DocRevision } from '../../sync/revisions'
import { Icon } from '../Icon'

function fmtSize(n: number) {
  if (!n) return ''
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}
void fmtSize

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
          ? '먼저 설정에서 GitHub 저장소를 연결해 주세요.'
          : e instanceof SyncNotConfiguredError
            ? 'GitHub 저장소가 연결되어 있지 않습니다.'
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
        message: `${formatDate(Date.parse(r.modifiedTime))} 시점으로 되돌립니다. 지금 내용은 버전 기록에 남습니다. 다른 기기에 반영하려면 되돌린 뒤 올리기를 눌러 주세요.`,
        ok: '되돌리기'
      }))
    )
      return
    setBusyId(r.id)
    setBusy({ text: '버전 불러오는 중' })
    try {
      await restoreDocRevision(docId, r.id)
      toast('되돌렸습니다. 올리기를 누르면 다른 기기에도 반영됩니다.', 'success', {
        label: '올리기',
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
                <small>GitHub 커밋 이력 — 모든 버전이 영구 보존됩니다</small>
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
                      {r.author && <span className="rev-size">{r.author}</span>}
                    </span>
                  </div>
                  {r.message && <p className="rev-message">{r.message}</p>}
                  <div className="rev-actions">
                    <button
                      className="text-btn small"
                      disabled={r.isHead || busyId === r.id}
                      onClick={() => void restore(r)}
                    >
                      되돌리기
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel-section">
            <p className="hint">
              버전은 GitHub 커밋 이력으로 남으므로 지워지지 않고, 충돌로 보존된 이 기기의 편집도 여기서 되돌릴 수 있습니다.
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
