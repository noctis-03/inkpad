import { useCallback, useEffect, useMemo, useState } from 'react'
import { useUI } from '../app/store'
import { confirmDialog } from '../app/dialogs'
import { pickFiles } from '../io/download'
import { formatDate } from '../shared/util'
import { AuthRequiredError, login } from '../sync/token'
import { onSyncStatus, type SyncStatus } from '../sync/sync'
import {
  APPS_EVENT,
  addApp,
  deleteAppFromCloud,
  flushPendingApps,
  installApp,
  listCloudApps,
  reuploadApp,
  uninstallApp,
  updateAllApps,
  updateInstalledApp,
  type CloudAppInfo,
  type CloudAppState
} from '../sync/apps'
import { Icon } from './Icon'

// 앱 메뉴: Drive의 Inkpad/apps/ = 스토어. 각 기기는 원하는 앱만 설치/업데이트/제거한다.
// 상태별 표시 정보 — 레일 색과 배지 문구의 단일 출처 (SyncSection의 tone을 재사용)
const STATE_META: Record<CloudAppState, { label: string; tone: 'recv' | 'push' | 'fresh' | 'gone' }> = {
  update: { label: '업데이트', tone: 'recv' },
  pending: { label: '올릴 것', tone: 'push' },
  'local-only': { label: '올릴 것', tone: 'push' },
  installed: { label: '설치됨', tone: 'fresh' },
  available: { label: '설치 안 됨', tone: 'recv' },
  'cloud-missing': { label: '사라짐', tone: 'gone' }
}

const GROUPS: { key: 'update' | 'push' | 'installed' | 'available' | 'missing'; title: string; tone: 'recv' | 'push' | 'fresh' | 'gone' }[] = [
  { key: 'update', title: '업데이트 있음', tone: 'recv' },
  { key: 'push', title: '올릴 것', tone: 'push' },
  { key: 'installed', title: '설치됨', tone: 'fresh' },
  { key: 'available', title: '설치 안 됨', tone: 'recv' },
  { key: 'missing', title: '클라우드에서 사라짐', tone: 'gone' }
]

function groupOf(state: CloudAppState) {
  if (state === 'update') return 'update'
  if (state === 'pending' || state === 'local-only') return 'push'
  if (state === 'installed') return 'installed'
  if (state === 'available') return 'available'
  return 'missing'
}

type Filter = 'all' | 'installed' | 'update' | 'available'
const matchFilter = (state: CloudAppState, f: Filter) =>
  f === 'all' ||
  (f === 'installed' && state !== 'available') ||
  (f === 'update' && state === 'update') ||
  (f === 'available' && state === 'available')

export function AppsSheet({ onClose }: { onClose: () => void }) {
  const toast = useUI((s) => s.toast)
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [items, setItems] = useState<CloudAppInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [openMenu, setOpenMenu] = useState<string | null>(null)

  useEffect(() => onSyncStatus(setStatus), [])

  const load = useCallback(async () => {
    try {
      setItems(await listCloudApps())
    } catch (e) {
      setItems([])
      if (e instanceof AuthRequiredError) setStatus('auth-required')
      else toast(e instanceof Error ? e.message : '앱 목록을 가져오지 못했습니다.', 'error')
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  // 다른 탭·기기의 앱 변경 반영
  useEffect(() => {
    const on = () => void load()
    window.addEventListener(APPS_EVENT, on)
    return () => window.removeEventListener(APPS_EVENT, on)
  }, [load])

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try {
      await fn()
      if (ok) toast(ok)
    } catch (e) {
      toast(e instanceof Error ? e.message : '작업 실패', 'error')
    } finally {
      setBusy(false)
      void load()
    }
  }

  const updateCount = useMemo(() => (items ?? []).filter((a) => a.state === 'update').length, [items])
  const pendingCount = useMemo(() => (items ?? []).filter((a) => a.state === 'pending' || a.state === 'local-only').length, [items])

  const onAdd = async () => {
    const files = await pickFiles('.html,.htm,text/html', true)
    if (!files.length) return
    setBusy(true)
    let offline = false
    try {
      for (const f of files) {
        const r = await addApp(f, null)
        if (!r.uploaded) offline = true
      }
      toast(offline ? '앱을 추가했습니다. 클라우드에는 다음 올리기 때 저장됩니다.' : '앱을 추가하고 클라우드에 저장했습니다.')
    } catch (e) {
      toast(e instanceof Error ? e.message : '앱을 추가하지 못했습니다.', 'error')
    } finally {
      setBusy(false)
      void load()
    }
  }

  const removeLocal = async (a: CloudAppInfo) => {
    const warn = a.state === 'pending' || a.state === 'local-only' ? '클라우드에 없는 변경이 사라집니다. ' : ''
    if (!(await confirmDialog('이 기기에서 제거', { message: `${warn}"${a.title}"을(를) 이 기기에서만 제거합니다. 클라우드 사본은 남습니다.`, ok: '제거', danger: true }))) return
    await run(() => uninstallApp(a.appId), `"${a.title}"을(를) 이 기기에서 제거했습니다.`)
  }

  const clearAndRemove = async (a: CloudAppInfo) => {
    if (!(await confirmDialog('앱 데이터까지 지우기', { message: `"${a.title}"을(를) 앱 데이터(저장값)와 함께 이 기기에서 제거합니다. 되돌릴 수 없습니다.`, ok: '지우고 제거', danger: true }))) return
    await run(() => uninstallApp(a.appId, { clearData: true }), '앱 데이터까지 지웠습니다.')
  }

  const removeCloud = async (a: CloudAppInfo) => {
    if (!(await confirmDialog('클라우드에서 삭제', { message: `"${a.title}"을(를) 클라우드에서 지웁니다. 모든 기기의 스토어에서 사라집니다. 이미 설치한 기기에는 남아 있습니다.`, ok: '삭제', danger: true }))) return
    await run(() => deleteAppFromCloud(a.appId), '클라우드에서 지웠습니다.')
  }

  const doUpdateAll = () =>
    run(async () => {
      const n = await updateAllApps()
      toast(n ? `${n}개를 업데이트했습니다.` : '업데이트할 앱이 없습니다.', n ? 'success' : 'info')
    })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (items ?? []).filter((a) => {
      if (!matchFilter(a.state, filter)) return false
      if (!q) return true
      return `${a.title} ${a.category ?? ''}`.toLowerCase().includes(q)
    })
  }, [items, filter, query])

  const groups = GROUPS.map((g) => ({ ...g, items: filtered.filter((a) => groupOf(a.state) === g.key) })).filter((g) => g.items.length > 0)
  const offline = !navigator.onLine

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-label="앱">
        <header className="sheet-header">
          <h2>앱</h2>
          <button className="tb-btn" onClick={onClose} aria-label="닫기">
            <Icon name="close" />
          </button>
        </header>
        <div className="sheet-scroll">
          {status === 'auth-required' ? (
            <div className="cloud-empty">
              <p>앱 스토어를 보려면 Google 로그인이 필요합니다.</p>
              <div className="btn-row center">
                <button className="primary-btn" onClick={() => login()}>
                  <Icon name="upload" size={18} /> Google로 로그인
                </button>
              </div>
            </div>
          ) : (
            <>
              {offline && <p className="hint warn">오프라인입니다. 이 기기에 설치된 앱만 보입니다.</p>}
              <div className="btn-row">
                <button className="text-btn" onClick={() => void onAdd()} disabled={busy}>
                  <Icon name="plus" size={16} /> 새 앱 추가
                </button>
                <button className="text-btn" onClick={() => void doUpdateAll()} disabled={busy || !updateCount}>
                  <Icon name="download" size={16} /> 모두 업데이트{updateCount ? ` (${updateCount})` : ''}
                </button>
                {pendingCount > 0 && (
                  <button className="text-btn" onClick={() => void run(() => flushPendingApps(), '올렸습니다.')} disabled={busy}>
                    <Icon name="upload" size={16} /> 올리기 ({pendingCount})
                  </button>
                )}
              </div>

              <div className="cloud-panel">
                <div className="cloud-toolbar">
                  <span className="cloud-search">
                    <Icon name="search" size={16} />
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="앱 검색" aria-label="앱 검색" />
                    {query && (
                      <button className="cloud-clear" onClick={() => setQuery('')} aria-label="검색 지우기">
                        <Icon name="close" size={13} />
                      </button>
                    )}
                  </span>
                </div>
                <div className="cloud-summary" role="group" aria-label="상태 필터">
                  {(
                    [
                      ['all', '전체'],
                      ['installed', '설치됨'],
                      ['update', '업데이트'],
                      ['available', '설치 안 됨']
                    ] as [Filter, string][]
                  ).map(([k, label]) => {
                    const on = filter === k
                    return (
                      <button key={k} className={'cloud-sum fresh' + (on ? ' is-active' : '')} aria-pressed={on} onClick={() => setFilter(on && k !== 'all' ? 'all' : k)}>
                        <b>{(items ?? []).filter((a) => matchFilter(a.state, k)).length}</b>
                        <span>{label}</span>
                      </button>
                    )
                  })}
                </div>

                {groups.length === 0 && <p className="cloud-empty">{items === null ? '앱 목록을 불러오는 중…' : '조건에 맞는 앱이 없습니다.'}</p>}

                {groups.map((g) => (
                  <section className="cloud-group" key={g.key}>
                    <div className={'cloud-group-head ' + g.tone}>
                      <Icon name="chevronDown" size={13} />
                      <span>{g.title}</span>
                      <b>{g.items.length}</b>
                    </div>
                    <div className="cloud-items">
                      {g.items.map((a) => {
                        const m = STATE_META[a.state]
                        const at = a.remoteUpdatedAt ?? a.localUpdatedAt
                        const tappable = a.state === 'available'
                        const install = () => void run(() => installApp(a.appId), `"${a.title}"을(를) 설치했습니다.`)
                        return (
                          <div key={a.appId} className="cloud-item-wrap">
                            <div
                              className={'cloud-item ' + m.tone + (tappable ? ' is-tappable' : '')}
                              role={tappable ? 'button' : undefined}
                              tabIndex={tappable ? 0 : undefined}
                              aria-label={tappable ? `${a.title} — 설치` : undefined}
                              onClick={tappable ? install : undefined}
                              onKeyDown={
                                tappable
                                  ? (e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault()
                                        install()
                                      }
                                    }
                                  : undefined
                              }
                            >
                              <div className="cloud-body">
                                <div className="cloud-name">{a.title}</div>
                                <div className="cloud-sub">
                                  {a.category && <span>{a.category}</span>}
                                  {at ? <span>{formatDate(at)}</span> : null}
                                </div>
                              </div>
                              {a.state === 'available' ? <span className="cloud-badge recv">설치</span> : <span className={'cloud-badge ' + m.tone}>{m.label}</span>}
                              {a.state !== 'available' && (
                                <button
                                  className="cloud-more"
                                  aria-label="더보기"
                                  aria-expanded={openMenu === a.appId}
                                  disabled={busy}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setOpenMenu((p) => (p === a.appId ? null : a.appId))
                                  }}
                                >
                                  <Icon name="more" size={16} />
                                </button>
                              )}
                            </div>

                            {openMenu === a.appId && (
                              <div className="cloud-actions">
                                {a.state === 'update' && (
                                  <button className="cloud-act" disabled={busy} onClick={() => { setOpenMenu(null); void run(() => updateInstalledApp(a.appId), `"${a.title}"을(를) 업데이트했습니다.`) }}>
                                    <Icon name="download" size={14} /> 업데이트
                                  </button>
                                )}
                                {(a.state === 'pending' || a.state === 'local-only') && (
                                  <button className="cloud-act" disabled={busy} onClick={() => { setOpenMenu(null); void run(() => flushPendingApps(), '올렸습니다.') }}>
                                    <Icon name="upload" size={14} /> 지금 올리기
                                  </button>
                                )}
                                {a.state === 'cloud-missing' && (
                                  <button className="cloud-act" disabled={busy} onClick={() => { setOpenMenu(null); void run(() => reuploadApp(a.appId), '다시 올렸습니다.') }}>
                                    <Icon name="upload" size={14} /> 다시 올리기
                                  </button>
                                )}
                                <button className="cloud-act danger" disabled={busy} onClick={() => { setOpenMenu(null); void removeLocal(a) }}>
                                  <Icon name="trash" size={14} /> 이 기기에서 제거
                                </button>
                                {a.state === 'installed' && (
                                  <button className="cloud-act" disabled={busy} onClick={() => { setOpenMenu(null); void clearAndRemove(a) }}>
                                    <Icon name="eraser" size={14} /> 앱 데이터까지 지우고 제거
                                  </button>
                                )}
                                <button className="cloud-act danger" disabled={busy} onClick={() => { setOpenMenu(null); void removeCloud(a) }}>
                                  <Icon name="trash" size={14} /> 클라우드에서 삭제
                                </button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </section>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
