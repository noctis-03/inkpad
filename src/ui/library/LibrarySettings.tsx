import { useEffect, useState } from 'react'
import { useUI } from '../../app/store'
import { confirmDialog } from '../../app/dialogs'
import { Icon } from '../Icon'
import { SettingsSections } from '../SettingsPanel'
import { formatBytes, isStandalone } from '../../shared/util'
import { listDocuments, purgeExpiredTrash, storageStats } from '../../storage/repo'
import { exportInkpad, importInkpad } from '../../io/inkpadFormat'
import { pickFiles, saveFile } from '../../io/download'

type Stats = Awaited<ReturnType<typeof storageStats>>

export function LibrarySettings({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const toast = useUI((s) => s.toast)
  const setBusy = useUI((s) => s.setBusy)
  const reset = useUI((s) => s.resetSettings)
  const [stats, setStats] = useState<Stats | null>(null)
  const [tab, setTab] = useState<'pen' | 'data'>('pen')

  const load = () => void storageStats().then(setStats)
  useEffect(load, [])

  const backup = async () => {
    try {
      const docs = await listDocuments()
      if (!docs.length) return toast('백업할 문서가 없습니다.')
      setBusy({ text: '전체 백업 만드는 중', progress: 0 })
      const blob = await exportInkpad(
        docs.map((d) => d.id),
        'backup',
        (d, t) => setBusy({ text: '전체 백업 만드는 중', progress: d / t })
      )
      const date = new Date().toISOString().slice(0, 10)
      await saveFile(blob, `inkpad_backup_${date}.inkpad`)
    } catch (e) {
      toast(e instanceof Error ? e.message : '백업 실패', 'error')
    } finally {
      setBusy(null)
    }
  }

  const restore = async () => {
    const [f] = await pickFiles('.inkpad,.zip,application/zip')
    if (!f) return
    const ok = await confirmDialog('백업에서 가져오기', {
      message: '백업의 문서와 폴더를 새 사본으로 추가합니다. 기존 문서는 그대로 둡니다.',
      ok: '가져오기'
    })
    if (!ok) return
    try {
      setBusy({ text: '백업 가져오는 중' })
      const r = await importInkpad(f, null, (d, t) => setBusy({ text: '백업 가져오는 중', progress: d / t }))
      toast(`문서 ${r.documents.length}개를 가져왔습니다.`, 'success')
      onChanged()
      load()
    } catch (e) {
      toast(e instanceof Error ? e.message : '가져오기 실패', 'error')
    } finally {
      setBusy(null)
    }
  }

  const persist = async () => {
    const ok = await navigator.storage?.persist?.()
    toast(ok ? '저장소 보존이 허용되었습니다.' : '브라우저가 보존 요청을 거절했습니다. 홈 화면에 추가하면 허용될 가능성이 높습니다.', ok ? 'success' : 'info')
    load()
  }

  const cleanTrash = async () => {
    const n = await purgeExpiredTrash()
    toast(n ? `오래된 휴지통 문서 ${n}개를 정리했습니다.` : '정리할 문서가 없습니다.')
    onChanged()
    load()
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet tall" role="dialog" aria-label="설정">
        <header className="sheet-header">
          <h2>설정</h2>
          <div className="seg small">
            <button className={tab === 'pen' ? 'is-active' : ''} onClick={() => setTab('pen')}>
              필기
            </button>
            <button className={tab === 'data' ? 'is-active' : ''} onClick={() => setTab('data')}>
              저장소 · 백업
            </button>
          </div>
          <button className="tb-btn" onClick={onClose} aria-label="닫기">
            <Icon name="close" />
          </button>
        </header>
        <div className="sheet-scroll">
          {tab === 'pen' ? (
            <>
              <SettingsSections />
              <div className="panel-footer">
                <button className="text-btn" onClick={reset}>
                  필기 설정 기본값으로
                </button>
              </div>
            </>
          ) : (
            <>
              <section className="panel-section">
                <h3>기기 저장소</h3>
                {stats && (
                  <>
                    <div className="usage-bar">
                      <span style={{ width: `${stats.quota ? Math.min(100, (stats.usage / stats.quota) * 100) : 0}%` }} />
                    </div>
                    <dl className="stat-list">
                      <div>
                        <dt>사용 중</dt>
                        <dd>
                          {formatBytes(stats.usage)} {stats.quota ? `/ ${formatBytes(stats.quota)}` : ''}
                        </dd>
                      </div>
                      <div>
                        <dt>문서 / 페이지</dt>
                        <dd>
                          {stats.docs} / {stats.pages}
                        </dd>
                      </div>
                      <div>
                        <dt>PDF 원본</dt>
                        <dd>
                          {stats.assets}개 · {formatBytes(stats.assetBytes)}
                        </dd>
                      </div>
                      <div>
                        <dt>동기화 대기</dt>
                        <dd>{stats.pending}건</dd>
                      </div>
                      <div>
                        <dt>저장소 보존</dt>
                        <dd>{stats.persisted ? '허용됨 ✓' : '허용 안 됨'}</dd>
                      </div>
                      <div>
                        <dt>실행 방식</dt>
                        <dd>{isStandalone() ? '홈 화면 앱' : 'Safari 탭'}</dd>
                      </div>
                    </dl>
                  </>
                )}
                {stats && !stats.persisted && (
                  <p className="hint warn">
                    Safari는 오래 쓰지 않은 사이트의 데이터를 지울 수 있습니다. 홈 화면에 추가하고, 정기적으로 전체 백업을 받아 두세요. 동기화를 설정해 두면 GitHub 허브에서 복구할 수 있습니다. (설정 탭의 "동기화 · GitHub")
                  </p>
                )}
                <div className="btn-row">
                  {stats && !stats.persisted && (
                    <button className="text-btn" onClick={persist}>
                      보존 요청
                    </button>
                  )}
                  <button className="text-btn" onClick={cleanTrash}>
                    오래된 휴지통 정리
                  </button>
                </div>
              </section>
              <section className="panel-section">
                <h3>백업</h3>
                <p className="hint">모든 문서, 폴더, PDF 원본을 .inkpad 파일 하나로 저장합니다. 가져올 때는 새 사본으로 추가됩니다.</p>
                <div className="btn-row">
                  <button id="backup-btn" className="primary-btn" onClick={backup}>
                    <Icon name="download" size={18} /> 전체 백업 내보내기
                  </button>
                  <button className="text-btn" onClick={restore}>
                    <Icon name="upload" size={18} /> 백업 가져오기
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
