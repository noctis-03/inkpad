// 앱 · 기타 파일 전용 동기화 시트 — 동기화(노트) 패널에서 분리해 각각 따로 받고 올린다.
// 라이브러리 상단바의 앱 · 기타 파일 버튼으로 열며, 클라우드 목록을 상태별로 보여준다.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useUI } from '../app/store'
import { confirmDialog } from '../app/dialogs'
import { Icon } from './Icon'
import { onSyncStatus, pullAppsOnly, pullFilesOnly, pushAppsOnly, pushFilesOnly, type SyncStatus, type ItemSyncResult } from '../sync/sync'
import {
  listCloudApps,
  downloadCloudApp,
  deleteCloudApp,
  type CloudAppInfo,
  type CloudAppState
} from '../sync/apps'
import {
  listCloudFiles,
  downloadCloudFile,
  deleteCloudFile,
  type CloudFileInfo
} from '../sync/files'
import { login } from '../sync/token'
import { formatDate } from '../shared/util'
import type { FileKind } from '../shared/model'

type Kind = 'apps' | 'files'

/** 목록 행 — 앱/파일을 한 컴포넌트에서 다루려고 공통 모양으로 만든다 */
interface Row {
  id: string
  driveFileId: string
  title: string
  category: string | null
  updatedAt: number
  state: CloudAppState
  sub: string
  file?: { name: string; mime: string; size: number; kind: FileKind }
}

/** 상태별 표시 정보 — 레일 색과 배지 문구의 단일 출처 (동기화 패널과 같은 어휘) */
const STATE_META: Record<CloudAppState, { label: string; tone: 'recv' | 'push' | 'fresh' | 'gone' }> = {
  'remote-new': { label: '받을 것', tone: 'recv' },
  pending: { label: '올릴 것', tone: 'push' },
  same: { label: '최신', tone: 'fresh' },
  'deleted-local': { label: '삭제 대기', tone: 'gone' }
}

const STATE_ORDER: CloudAppState[] = ['remote-new', 'pending', 'same', 'deleted-local']

const GROUPS: { key: CloudAppState; title: string; tone: 'recv' | 'push' | 'fresh' | 'gone'; startCollapsed: boolean }[] = [
  { key: 'remote-new', title: '받을 것', tone: 'recv', startCollapsed: false },
  { key: 'pending', title: '올릴 것', tone: 'push', startCollapsed: false },
  { key: 'same', title: '최신', tone: 'fresh', startCollapsed: true },
  { key: 'deleted-local', title: '삭제 대기', tone: 'gone', startCollapsed: true }
]

interface KindApi {
  label: string
  icon: string
  empty: string
  list: () => Promise<Row[]>
  pull: () => Promise<ItemSyncResult>
  push: () => Promise<ItemSyncResult>
  download: (r: Row) => Promise<'applied' | 'skipped'>
  del: (r: Row) => Promise<void>
}

function apiFor(kind: Kind): KindApi {
  if (kind === 'apps') {
    return {
      label: '앱',
      icon: 'app',
      empty: '클라우드에 앱이 없습니다.',
      list: async () =>
        (await listCloudApps()).map((a: CloudAppInfo) => ({
          id: a.appId,
          driveFileId: a.driveFileId,
          title: a.title,
          category: a.category,
          updatedAt: a.updatedAt,
          state: a.state,
          sub: 'HTML 앱'
        })),
      pull: pullAppsOnly,
      push: pushAppsOnly,
      download: (r) =>
        downloadCloudApp({
          appId: r.id,
          driveFileId: r.driveFileId,
          title: r.title,
          category: r.category,
          updatedAt: r.updatedAt,
          state: r.state
        }),
      del: (r) => deleteCloudApp({ appId: r.id, driveFileId: r.driveFileId })
    }
  }
  return {
    label: '기타 파일',
    icon: 'file',
    empty: '클라우드에 파일이 없습니다.',
    list: async () =>
      (await listCloudFiles()).map((f: CloudFileInfo) => ({
        id: f.id,
        driveFileId: f.driveFileId,
        title: f.title,
        category: f.category,
        updatedAt: f.updatedAt,
        state: f.state,
        sub: f.name,
        file: { name: f.name, mime: f.mime, size: f.size, kind: f.kind }
      })),
    pull: pullFilesOnly,
    push: pushFilesOnly,
    download: (r) =>
      downloadCloudFile({
        id: r.id,
        driveFileId: r.driveFileId,
        title: r.title,
        category: r.category,
        name: r.file?.name ?? r.sub,
        mime: r.file?.mime ?? 'application/octet-stream',
        size: r.file?.size ?? 0,
        kind: r.file?.kind ?? 'other',
        updatedAt: r.updatedAt,
        state: r.state
      }),
    del: (r) => deleteCloudFile({ id: r.id, driveFileId: r.driveFileId })
  }
}

/** runExclusive의 실패 사유를 안내문으로 바꾼다 */
function reportFailure(toast: (t: string, k?: 'info' | 'error' | 'success') => void, r: Extract<ItemSyncResult, { ok: false }>, verb: string) {
  if (r.reason === 'offline') toast(`오프라인이라 ${verb} 수 없습니다. 연결한 뒤 다시 시도해 주세요.`, 'info')
  else if (r.reason === 'busy') toast('다른 탭에서 동기화 중입니다. 잠시 뒤 다시 시도해 주세요.', 'info')
  else toast(`${verb}에 실패했습니다. 로그인 상태를 확인해 주세요.`, 'error')
}

export function AppsSheet({ onClose }: { onClose: () => void }) {
  return <CloudItemsSheet kind="apps" onClose={onClose} />
}

export function FilesSheet({ onClose }: { onClose: () => void }) {
  return <CloudItemsSheet kind="files" onClose={onClose} />
}

function CloudItemsSheet({ kind, onClose }: { kind: Kind; onClose: () => void }) {
  const api = useMemo(() => apiFor(kind), [kind])
  const toast = useUI((s) => s.toast)
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [items, setItems] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CloudAppState | 'all'>('all')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ same: true, 'deleted-local': true })
  const [openMenu, setOpenMenu] = useState<string | null>(null)

  useEffect(() => onSyncStatus(setStatus), [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await api.list())
    } catch (e) {
      toast(e instanceof Error ? e.message : '클라우드 목록을 가져오지 못했습니다.', 'error')
    } finally {
      setLoading(false)
    }
  }, [api, toast])

  useEffect(() => {
    void load()
  }, [load])

  const busy = loading || status === 'syncing'

  const doPull = async () => {
    const r = await api.pull()
    if (!r.ok) return reportFailure(toast, r, '받기')
    toast(r.count ? `${api.label} ${r.count}개를 받았습니다.` : '이미 최신 상태입니다.', r.count ? 'success' : 'info')
    await load()
  }

  const doPush = async () => {
    const r = await api.push()
    if (!r.ok) return reportFailure(toast, r, '올리기')
    toast(r.count ? `${api.label} ${r.count}개를 올렸습니다.` : '올릴 변경이 없습니다. 이미 최신 상태입니다.', r.count ? 'success' : 'info')
    await load()
  }

  const downloadOne = async (r: Row) => {
    setLoading(true)
    try {
      const res = await api.download(r)
      if (res === 'applied') toast(`"${r.title}"을(를) 받았습니다.`)
      else toast('이 기기에서 수정 중인 항목이라 받지 못했습니다. 먼저 "올리기"를 눌러 주세요.', 'info')
      await load()
    } catch (e) {
      toast(e instanceof Error ? e.message : '받기 실패', 'error')
      setLoading(false)
    }
  }

  const deleteOne = async (r: Row) => {
    if (
      !(await confirmDialog('클라우드에서 삭제', {
        message: `"${r.title}"을(를) 클라우드에서 지우고, 이 기기의 사본도 삭제합니다. 다른 기기에서도 받기 때 사라집니다.`,
        ok: '삭제',
        danger: true
      }))
    )
      return
    setLoading(true)
    try {
      await api.del(r)
      toast('클라우드에서 지웠습니다.')
      await load()
    } catch (e) {
      toast(e instanceof Error ? e.message : '삭제 실패', 'error')
      setLoading(false)
    }
  }

  const counts = useMemo(() => {
    const c: Record<CloudAppState, number> = { 'remote-new': 0, pending: 0, same: 0, 'deleted-local': 0 }
    for (const r of items ?? []) c[r.state]++
    return c
  }, [items])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (items ?? []).filter((r) => {
      if (filter !== 'all' && r.state !== filter) return false
      if (!q) return true
      return `${r.title} ${r.category ?? ''} ${r.sub}`.toLowerCase().includes(q)
    })
  }, [items, filter, query])

  const groups = useMemo(
    () => GROUPS.map((g) => ({ ...g, items: visible.filter((r) => r.state === g.key) })).filter((g) => g.items.length > 0),
    [visible]
  )

  const pendingCount = counts.pending + counts['deleted-local']

  // ── 로그인 전 / 서버 미설정 ──
  if (status === 'auth-required' || status === 'disabled') {
    return (
      <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="sheet" role="dialog" aria-label={`${api.label} 동기화`}>
          <header className="sheet-header">
            <h2>{api.label}</h2>
            <button className="tb-btn" onClick={onClose} aria-label="닫기">
              <Icon name="close" />
            </button>
          </header>
          <div className="sheet-scroll">
            <section className="panel-section">
              {status === 'auth-required' ? (
                <div className="btn-row">
                  <button className="primary-btn" onClick={() => login()}>
                    <Icon name="upload" size={18} /> Google로 로그인
                  </button>
                </div>
              ) : (
                <p className="hint warn">서버에 OAuth 설정이 없습니다. 로컬 저장은 계속 동작합니다.</p>
              )}
            </section>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-label={`${api.label} 동기화`}>
        <header className="sheet-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name={api.icon} size={18} /> {api.label}
          </h2>
          <button className="tb-btn" onClick={onClose} aria-label="닫기">
            <Icon name="close" />
          </button>
        </header>
        <div className="sheet-scroll">
          <section className="panel-section">
            <div className="btn-row">
              <button className="text-btn" onClick={() => void doPull()} disabled={busy}>
                <Icon name="download" size={16} /> 받기
              </button>
              <button className="text-btn" onClick={() => void doPush()} disabled={busy}>
                <Icon name="upload" size={16} /> 올리기
                {pendingCount > 0 && <b>&nbsp;({pendingCount})</b>}
              </button>
              <button className="text-btn small" style={{ marginLeft: 'auto' }} onClick={() => void load()} disabled={busy}>
                새로 고침
              </button>
            </div>
            {pendingCount > 0 && (
              <p className="hint">
                이 기기에서 바뀐 {api.label} {pendingCount}건이 클라우드 반영을 기다립니다.
              </p>
            )}
          </section>

          <section className="panel-section">
            {items === null ? (
              <div className="cloud-panel">
                <div className="cloud-items">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="cloud-skel">
                      <span className="bar t" />
                      <span className="bar m" />
                      <span className="bar s" />
                    </div>
                  ))}
                </div>
              </div>
            ) : !items.length ? (
              <p className="cloud-empty">
                {api.empty}
                <br />
                라이브러리에서 {api.label}을(를) 추가한 뒤 <b>올리기</b>를 눌러 주세요.
              </p>
            ) : (
              <div className="cloud-panel">
                <div className="cloud-toolbar">
                  <span className="cloud-search">
                    <Icon name="search" size={16} />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="제목 · 카테고리 검색"
                      aria-label={`클라우드 ${api.label} 검색`}
                    />
                    {query && (
                      <button className="cloud-clear" onClick={() => setQuery('')} aria-label="검색 지우기">
                        <Icon name="close" size={13} />
                      </button>
                    )}
                  </span>
                  {filter !== 'all' && (
                    <button className="text-btn small" onClick={() => setFilter('all')}>
                      전체
                    </button>
                  )}
                </div>

                <div className="cloud-summary" role="group" aria-label="상태별 필터">
                  {STATE_ORDER.map((k) => {
                    const m = STATE_META[k]
                    const on = filter === k
                    return (
                      <button
                        key={k}
                        className={'cloud-sum ' + m.tone + (on ? ' is-active' : '')}
                        aria-pressed={on}
                        title={on ? '필터 해제' : `${m.label}만 보기`}
                        onClick={() => setFilter(on ? 'all' : k)}
                      >
                        <b>{counts[k]}</b>
                        <span>{m.label}</span>
                      </button>
                    )
                  })}
                </div>

                {groups.length === 0 && <p className="cloud-empty">조건에 맞는 항목이 없습니다.</p>}

                {groups.map((g) => {
                  const isOpen = !collapsed[g.key]
                  return (
                    <section className="cloud-group" key={g.key}>
                      <button
                        className={'cloud-group-head ' + g.tone}
                        onClick={() => setCollapsed((m) => ({ ...m, [g.key]: !m[g.key] }))}
                        aria-expanded={isOpen}
                      >
                        <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={13} />
                        <span>{g.title}</span>
                        <b>{g.items.length}</b>
                      </button>

                      {isOpen && (
                        <div className="cloud-items">
                          {g.items.map((r) => {
                            const m = STATE_META[r.state]
                            // 받을 것은 행 전체를 눌러 바로 받는다
                            const tappable = r.state === 'remote-new'
                            return (
                              <div key={r.id} className="cloud-item-wrap">
                                <div
                                  className={'cloud-item ' + m.tone + (tappable ? ' is-tappable' : '')}
                                  role={tappable ? 'button' : undefined}
                                  tabIndex={tappable ? 0 : undefined}
                                  aria-label={tappable ? `${r.title} — 이 기기로 받기` : undefined}
                                  onClick={tappable ? () => void downloadOne(r) : undefined}
                                  onKeyDown={
                                    tappable
                                      ? (e) => {
                                          if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault()
                                            void downloadOne(r)
                                          }
                                        }
                                      : undefined
                                  }
                                >
                                  <div className="cloud-body">
                                    <div className="cloud-name">{r.title}</div>
                                    <div className="cloud-sub">
                                      {r.category && <span>{r.category}</span>}
                                      <span>{r.sub}</span>
                                      <span>{formatDate(r.updatedAt)}</span>
                                    </div>
                                  </div>

                                  {r.state === 'remote-new' ? (
                                    <span className="cloud-badge recv">받기</span>
                                  ) : (
                                    <span className={'cloud-badge ' + m.tone}>{m.label}</span>
                                  )}

                                  <button
                                    className="cloud-more"
                                    aria-label="더보기"
                                    aria-expanded={openMenu === r.id}
                                    disabled={busy}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setOpenMenu((prev) => (prev === r.id ? null : r.id))
                                    }}
                                  >
                                    <Icon name="more" size={16} />
                                  </button>
                                </div>

                                {openMenu === r.id && (
                                  <div className="cloud-actions">
                                    {r.state === 'pending' || r.state === 'deleted-local' ? (
                                      <button
                                        className="cloud-act"
                                        disabled={busy}
                                        onClick={() => {
                                          setOpenMenu(null)
                                          void doPush()
                                        }}
                                      >
                                        <Icon name="upload" size={14} /> 지금 올리기
                                      </button>
                                    ) : (
                                      <button
                                        className="cloud-act"
                                        disabled={busy}
                                        onClick={() => {
                                          setOpenMenu(null)
                                          void downloadOne(r)
                                        }}
                                      >
                                        <Icon name="download" size={14} /> 이 기기로 받기
                                      </button>
                                    )}
                                    <button
                                      className="cloud-act danger"
                                      disabled={busy}
                                      onClick={() => {
                                        setOpenMenu(null)
                                        void deleteOne(r)
                                      }}
                                    >
                                      <Icon name="trash" size={14} /> 클라우드에서 삭제
                                    </button>
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </section>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
