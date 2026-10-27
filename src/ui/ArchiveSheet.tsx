// 보관함 관리 — 기기 브랜치·옛 머지 백업·이 기기 스냅샷·자동 고정·안 쓰는 노트 조각을 한눈에 보고 정리한다 (sync/archive.ts).
// 동기화 패널의 '보관함 관리'로 연다. 클라우드 파일은 Drive 휴지통으로 옮긴다(30일 보관).
import { useCallback, useEffect, useState } from 'react'
import { create } from 'zustand'
import { useUI } from '../app/store'
import { confirmDialog } from '../app/dialogs'
import { formatBytesShort, formatDate } from '../shared/util'
import { cleanObjects, loadArchive, releaseAutoPins, scanObjects, trashBranches, trashFiles, type ArchiveReport, type ObjectScan } from '../sync/archive'
import { clearSnapshots, pruneSnapshots } from '../sync/snapshots'
import { Icon } from './Icon'
import { useEscClose } from './sheetParts'

const useArchive = create<{ open: boolean }>(() => ({ open: false }))
export const openArchive = () => useArchive.setState({ open: true })
const closeArchive = () => useArchive.setState({ open: false })

/** App이 한 번 그린다 */
export function ArchiveHost() {
  return useArchive((s) => s.open) ? <ArchiveSheet /> : null
}

/** 이 항목이 어디에 있나 — 클라우드(모든 기기가 함께 쓴다, 한 기기에서 정리하면 된다) · 이 기기(기기마다 따로) */
function Where({ at }: { at: 'cloud' | 'device' }) {
  return at === 'cloud' ? (
    <span className="archive-where cloud" title="Google Drive에 있습니다 — 모든 기기가 함께 쓰고, 어느 기기에서 정리해도 같습니다">
      클라우드
    </span>
  ) : (
    <span className="archive-where device" title="이 기기에만 있습니다 — 기기마다 따로 정리합니다">
      이 기기
    </span>
  )
}

const toast = (text: string, kind: 'info' | 'success' | 'error' = 'success') => useUI.getState().toast(text, kind)

function ArchiveSheet() {
  const [report, setReport] = useState<ArchiveReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /** 조각 검사 결과 — 누를 때만 (노트 파일을 모두 읽는다) */
  const [scan, setScan] = useState<ObjectScan | null | undefined>(undefined)
  const [scanProgress, setScanProgress] = useState<string | null>(null)

  const runScan = async () => {
    setBusy('scan')
    setScanProgress('살펴보는 중…')
    try {
      setScan(await scanObjects((d, t) => setScanProgress(`노트 파일 ${d}/${t} 살펴보는 중…`)))
    } catch (e) {
      toast(e instanceof Error ? e.message : '조각을 살펴보지 못했습니다.', 'error')
    } finally {
      setBusy(null)
      setScanProgress(null)
    }
  }

  const load = useCallback(async () => {
    setError(null)
    try {
      setReport(await loadArchive())
    } catch (e) {
      setError(e instanceof Error ? e.message : '보관함을 읽지 못했습니다.')
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  /** 정리 동작 하나 — 확인 → 실행 → 알림 → 다시 읽기 */
  const run = async (key: string, confirm: { title: string; message: string; ok: string } | null, fn: () => Promise<string>) => {
    if (confirm && !(await confirmDialog(confirm.title, { ...confirm, danger: true }))) return
    setBusy(key)
    try {
      toast(await fn())
      await load()
    } catch (e) {
      toast(e instanceof Error ? e.message : '정리하지 못했습니다.', 'error')
    } finally {
      setBusy(null)
    }
  }

  const merged = report?.branches.filter((b) => b.merged) ?? []
  const mergedBytes = merged.reduce((n, b) => n + b.size, 0)
  const orphanCount = (report?.branches.filter((b) => b.orphan).length ?? 0) + (report?.backups.filter((b) => b.orphan).length ?? 0)
  const backupBytes = report?.backups.reduce((n, b) => n + b.size, 0) ?? 0
  useEscClose(closeArchive)

  return (
    <div className="modal-backdrop archive-host" onPointerDown={(e) => e.target === e.currentTarget && closeArchive()}>
      <div className="sheet archive-sheet" role="dialog" aria-label="보관함 관리">
        <header className="sheet-header">
          <h2>보관함 관리</h2>
          <button className="tb-btn" onClick={closeArchive} aria-label="닫기">
            <Icon name="close" />
          </button>
        </header>
        <div className="sheet-scroll">
          {error && (
            <section className="archive-section">
              <p className="hint warn">{error}</p>
              <button className="text-btn" onClick={() => void load()}>
                다시 시도
              </button>
            </section>
          )}
          {!report && !error && (
            <section className="archive-section">
              <p className="hint">클라우드 보관함을 확인하는 중…</p>
            </section>
          )}
          {report && (
            <>
              <section className="archive-section">
                <h3>
                  기기 브랜치 <Where at="cloud" />
                </h3>
                <p className="hint">기기마다 노트별로 마지막으로 올린 상태입니다. 머지가 끝난 브랜치는 지워도 잃는 것이 없습니다(main에 들어갔거나 버린 것).</p>
                {report.devices.length === 0 ? (
                  <p className="hint">브랜치가 없습니다.</p>
                ) : (
                  <ul className="archive-list">
                    {report.devices.map((d) => (
                      <li key={d.deviceId} className="archive-row">
                        <div className="archive-main">
                          <b>
                            {d.device}
                            {d.mine && <span className="archive-tag">사용 중인 기기</span>}
                          </b>
                          <span>
                            브랜치 {d.branches}개 · {formatBytesShort(d.bytes)}
                            {d.unmerged > 0 && <em> · 머지 안 됨 {d.unmerged}</em>} · 마지막 {formatDate(d.lastAt)}
                          </span>
                        </div>
                        {!d.mine && (
                          <button
                            className="text-btn danger"
                            disabled={!!busy}
                            onClick={() =>
                              void run(
                                'retire:' + d.deviceId,
                                {
                                  title: `${d.device} 퇴역`,
                                  message: `더는 쓰지 않는 기기로 보고 그 기기의 브랜치 ${d.branches}개를 Drive 휴지통으로 옮깁니다(30일 보관).${
                                    d.unmerged ? ` 그중 ${d.unmerged}개는 아직 머지하지 않은 내용입니다 — 지우면 머지 관리에서도 사라집니다.` : ''
                                  } 그 기기를 다시 쓰면 다음 올리기 때 새 브랜치가 생깁니다.`,
                                  ok: '퇴역'
                                },
                                async () => `${d.device} 브랜치 ${await trashBranches(report.branches.filter((b) => b.deviceId === d.deviceId))}개를 휴지통으로 옮겼습니다.`
                              )
                            }
                          >
                            퇴역
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  className="text-btn"
                  disabled={!merged.length || !!busy}
                  onClick={() =>
                    void run(
                      'merged',
                      { title: '머지 끝난 브랜치 지우기', message: `머지가 끝난 브랜치 ${merged.length}개(${formatBytesShort(mergedBytes)})를 Drive 휴지통으로 옮깁니다.`, ok: '지우기' },
                      async () => `브랜치 ${await trashBranches(merged)}개를 휴지통으로 옮겼습니다.`
                    )
                  }
                >
                  머지 끝난 브랜치 지우기 ({merged.length}개 · {formatBytesShort(mergedBytes)})
                </button>
              </section>

              <section className="archive-section">
                <h3>
                  옛 머지 백업 <Where at="cloud" />
                </h3>
                <p className="hint">자동 머지를 쓰던 때 머지에서 밀린 이 기기 상태를 따로 올려 둔 파일입니다. 이제는 새로 만들지 않습니다.</p>
                <button
                  className="text-btn"
                  disabled={!report.backups.length || !!busy}
                  onClick={() =>
                    void run(
                      'backups',
                      { title: '옛 머지 백업 지우기', message: `옛 머지 백업 ${report.backups.length}개(${formatBytesShort(backupBytes)})를 Drive 휴지통으로 옮깁니다.`, ok: '지우기' },
                      async () => `옛 머지 백업 ${await trashFiles(report.backups.map((b) => b.fileId))}개를 휴지통으로 옮겼습니다.`
                    )
                  }
                >
                  모두 지우기 ({report.backups.length}개 · {formatBytesShort(backupBytes)})
                </button>
                {orphanCount > 0 && <p className="hint">노트가 클라우드에서 지워진 뒤 남은 파일 {orphanCount}개도 위 두 정리에 함께 들어갑니다.</p>}
              </section>

              <section className="archive-section">
                <h3>
                  이 기기 스냅샷 <Where at="device" />
                </h3>
                <p className="hint">
                  받기·맞추기·머지·되돌리기로 노트가 덮이기 직전에 이 기기에 자동으로 남긴 것입니다(노트당 최근 20개, 전체 200MB까지). 지금 {report.snapshots.count}개 ·{' '}
                  {formatBytesShort(report.snapshots.bytes)} · 노트 {report.snapshots.docs}개.
                </p>
                <div className="btn-row">
                  <button
                    className="text-btn"
                    disabled={!report.snapshots.count || !!busy}
                    onClick={() => void run('snap5', null, async () => `스냅샷 ${await pruneSnapshots(undefined, 5)}개를 지웠습니다.`)}
                  >
                    노트당 최근 5개만 남기기
                  </button>
                  <button
                    className="text-btn danger"
                    disabled={!report.snapshots.count || !!busy}
                    onClick={() =>
                      void run(
                        'snapAll',
                        { title: '스냅샷 모두 지우기', message: `이 기기의 스냅샷 ${report.snapshots.count}개를 지웁니다. 되돌릴 수 없습니다.`, ok: '모두 지우기' },
                        async () => `스냅샷 ${await clearSnapshots()}개를 지웠습니다.`
                      )
                    }
                  >
                    모두 지우기
                  </button>
                </div>
              </section>

              <section className="archive-section">
                <h3>
                  노트 조각 <Where at="cloud" />
                </h3>
                <p className="hint">
                  노트는 페이지마다 조각으로 올라가 바뀐 페이지만 오갑니다. 노트를 고치면 옛 조각이 남는데, 아무 노트·브랜치·고정한 버전도 쓰지 않는 조각은
                  정리에서 '안 씀'으로 표시하고, 45일 뒤 다시 정리할 때도 여전히 안 쓰면 Drive 휴지통으로 옮깁니다(그사이 옛 버전 되돌리기가 쓸 수 있게).
                </p>
                {scan === null && <p className="hint">아직 조각이 없습니다.</p>}
                {scan && (
                  <p className="hint">
                    조각 {scan.total}개 · {formatBytesShort(scan.bytes)} — 안 쓰는 조각 {scan.unused.length}개 · {formatBytesShort(scan.unusedBytes)}
                    {scan.ready > 0 ? ` (이번 정리에 휴지통으로 ${scan.ready}개 · ${formatBytesShort(scan.readyBytes)})` : ''}. 노트 파일 {scan.files}개를
                    살펴봤습니다.
                  </p>
                )}
                <div className="btn-row">
                  <button className="text-btn" disabled={!!busy} onClick={() => void runScan()}>
                    {scanProgress ?? (scan ? '다시 살펴보기' : '조각 살펴보기')}
                  </button>
                  {scan && (
                    <button
                      className="text-btn"
                      disabled={!!busy || (!scan.unused.length && !scan.revived.length)}
                      onClick={() =>
                        void run('objects', null, async () => {
                          const r = await cleanObjects(scan)
                          setScan(undefined)
                          return r.trashed
                            ? `안 쓰는 조각 ${r.trashed}개를 휴지통으로 옮겼습니다${r.marked ? `(새로 표시 ${r.marked}개)` : ''}.`
                            : r.marked
                              ? `안 쓰는 조각 ${r.marked}개를 표시했습니다 — 45일 뒤 정리할 때도 안 쓰면 휴지통으로 옮깁니다.`
                              : '정리할 조각이 없습니다.'
                        })
                      }
                    >
                      안 쓰는 조각 정리
                    </button>
                  )}
                </div>
              </section>

              <section className="archive-section">
                <h3>
                  자동 고정 <Where at="cloud" />
                </h3>
                <p className="hint">
                  옛 버전으로 되돌릴 때 Drive가 고정을 요구해 이 기기가 대신 고정한 버전입니다(파일당 200개 한도). 고정을 풀어도 내용은 약 30일 동안 버전 기록에 남습니다. 지금{' '}
                  {report.autoPins.length}개.
                </p>
                <button
                  className="text-btn"
                  disabled={!report.autoPins.length || !!busy}
                  onClick={() =>
                    void run('pins', null, async () => {
                      const r = await releaseAutoPins(report.autoPins)
                      return r.failed ? `고정 ${r.released}개를 풀었고 ${r.failed}개는 풀지 못했습니다.` : `고정 ${r.released}개를 풀었습니다.`
                    })
                  }
                >
                  자동 고정 풀기 ({report.autoPins.length}개)
                </button>
              </section>
            </>
          )}
          <section className="archive-section">
            <p className="hint">클라우드 파일은 지우지 않고 Drive 휴지통으로 옮깁니다 — 30일 안에는 Drive에서 되살릴 수 있습니다.</p>
            <button className="text-btn" onClick={() => void load()} disabled={!!busy}>
              {busy ? '정리하는 중…' : '새로 고침'}
            </button>
          </section>
        </div>
      </div>
    </div>
  )
}
