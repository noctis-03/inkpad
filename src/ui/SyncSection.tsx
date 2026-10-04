import { useCallback, useEffect, useMemo, useState } from 'react'
import { useUI } from '../app/store'
import { login, logout } from '../sync/token'
import {
  downloadCloudNote,
  deleteCloudNote,
  listCloudNotes,
  onSyncStatus,
  planPush,
  pullNow,
  pushNow,
  pushOneNote,
  syncNow,
  type CloudNoteInfo,
  type CloudNoteState,
  type PushPlan,
  type SyncStatus
} from '../sync/sync'
import { onAssetProgress } from '../sync/assets'
import { db } from '../storage/db'
import { formatDate } from '../shared/util'
import { confirmDialog } from '../app/dialogs'
import { Icon } from './Icon'

const STATUS_LABEL: Record<SyncStatus, string> = {
  idle: '동기화됨',
  syncing: '작업 중…',
  offline: '오프라인',
  'auth-required': '로그인 필요',
  error: '오류',
  disabled: '서버 미설정'
}

/** 이 기기 이름 정하기 — 클라우드 목록에 표시된다 */
function DeviceNameRow() {
  const [name, setName] = useState('')
  const [saved, setSaved] = useState('')
  useEffect(() => {
    void import('../sync/token').then(({ getDeviceName }) => void getDeviceName().then(setSaved))
  }, [])
  const save = async () => {
    const { setDeviceName } = await import('../sync/token')
    await setDeviceName(name)
    setSaved(name.trim())
    setName('')
    toast(`기기 이름을 "${saved}"(으)로 정했습니다. 다음 올리기부터 적용됩니다.`)
  }
  return (
    <div className="setting-row">
      <span className="setting-label">
        이 기기 이름
        <small>클라우드 목록에 표시됩니다</small>
      </span>
      <span className="setting-control">
        <span className="device-name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={saved || '기기 이름'}
            aria-label="기기 이름"
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && void save()}
          />
          <button className="text-btn small" disabled={!name.trim()} onClick={() => void save()}>
            저장
          </button>
        </span>
      </span>
    </div>
  )
}

function toast(text: string, kind: 'info' | 'success' | 'error' = 'success') {
  void import('../app/store').then(({ useUI }) => useUI.getState().toast(text, kind))
}

// ───────────────── 클라우드 노트 목록 ─────────────────

type GroupKey = 'recv' | 'push' | 'fresh' | 'gone'

/**
 * 문구의 단일 출처 — 요약 칸·그룹 제목은 GROUPS.title을, 행 배지는 STATE_META.badge를 쓴다.
 * 각 상태가 어느 그룹(요약 칸·그룹 제목·색을 정함)에 속하는지도 여기서 정한다 (지시서 1번)
 */
const STATE_META: Record<CloudNoteState, { group: GroupKey; badge: string }> = {
  'remote-new': { group: 'recv', badge: '새 버전' },
  new: { group: 'push', badge: '새 파일' },
  pending: { group: 'push', badge: '변경됨' },
  'cloud-deleted': { group: 'push', badge: '클라우드에서 삭제됨' },
  same: { group: 'fresh', badge: '최신' },
  'deleted-local': { group: 'gone', badge: '삭제됨' }
}

/** 목록 그룹 — 받을 것 → 올릴 것(새 파일·변경·클라우드 삭제 포함) → 최신(접힘) → 이 기기에서 삭제됨(접힘) */
const GROUPS: { key: GroupKey; title: string; states: CloudNoteState[]; startCollapsed: boolean }[] = [
  { key: 'recv', title: '받을 것', states: ['remote-new'], startCollapsed: false },
  { key: 'push', title: '올릴 것', states: ['new', 'pending', 'cloud-deleted'], startCollapsed: false },
  { key: 'fresh', title: '최신', states: ['same'], startCollapsed: true },
  { key: 'gone', title: '이 기기에서 삭제됨', states: ['deleted-local'], startCollapsed: true }
]

const groupOf = (state: CloudNoteState) => GROUPS.find((g) => g.key === STATE_META[state].group)!

function CloudList({
  cloud,
  busy,
  onDownload,
  onDelete,
  onPush,
  onPushOne
}: {
  cloud: CloudNoteInfo[] | null
  busy: boolean
  onDownload: (info: CloudNoteInfo) => void
  onDelete: (info: CloudNoteInfo) => void
  onPush: () => void
  onPushOne: (info: CloudNoteInfo) => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<GroupKey | 'all'>('all')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ fresh: true, gone: true })
  const [openMenu, setOpenMenu] = useState<string | null>(null)

  const counts = useMemo(() => {
    const c: Record<GroupKey, number> = { recv: 0, push: 0, fresh: 0, gone: 0 }
    for (const n of cloud ?? []) c[STATE_META[n.state].group]++
    return c
  }, [cloud])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (cloud ?? []).filter((n) => {
      if (filter !== 'all' && STATE_META[n.state].group !== filter) return false
      if (!q) return true
      return `${n.title} ${n.category ?? ''} ${n.device ?? ''}`.toLowerCase().includes(q)
    })
  }, [cloud, filter, query])

  const groups = GROUPS.map((g) => ({ ...g, items: visible.filter((n) => STATE_META[n.state].group === g.key) })).filter((g) => g.items.length > 0)

  // 아직 못 받아 온 상태 — 빈 공간 대신 같은 골격의 스켈레톤
  if (cloud === null) {
    return (
      <div className="cloud-panel">
        <div className="cloud-toolbar">
          <span className="cloud-search">
            <Icon name="search" size={16} />
            <input value="" placeholder="노트 검색" aria-label="클라우드 노트 검색" disabled readOnly />
          </span>
        </div>
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
    )
  }

  if (!cloud.length) {
    return (
      <p className="cloud-empty">
        클라우드에 노트가 없습니다.
        <br />
        노트를 만든 뒤 <b>올리기</b>를 눌러 주세요.
      </p>
    )
  }

  return (
    <div className="cloud-panel">
      <div className="cloud-toolbar">
        <span className="cloud-search">
          <Icon name="search" size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="제목 · 카테고리 · 기기 검색"
            aria-label="클라우드 노트 검색"
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
        {GROUPS.map((g) => {
          const on = filter === g.key
          return (
            <button
              key={g.key}
              className={'cloud-sum ' + g.key + (on ? ' is-active' : '')}
              aria-pressed={on}
              title={on ? '필터 해제' : `${g.title}만 보기`}
              onClick={() => setFilter(on ? 'all' : g.key)}
            >
              <b>{counts[g.key]}</b>
              <span>{g.title}</span>
            </button>
          )
        })}
      </div>

      {groups.length === 0 && <p className="cloud-empty">조건에 맞는 노트가 없습니다.</p>}

      {groups.map((g) => {
        const isOpen = !collapsed[g.key]
        return (
          <section className="cloud-group" key={g.key}>
            <button
              className={'cloud-group-head ' + g.key}
              onClick={() => setCollapsed((m) => ({ ...m, [g.key]: !m[g.key] }))}
              aria-expanded={isOpen}
            >
              <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={13} />
              <span>{g.title}</span>
              <b>{g.items.length}</b>
            </button>

            {isOpen && (
              <div className="cloud-items">
                {g.items.map((c) => {
                  const m = STATE_META[c.state]
                  const tone = groupOf(c.state).key
                  // 받을 것 · 클라우드에서 삭제됨 · 이 기기에서 삭제됨 행은 행 전체를 눌러 바로 처리한다
                  const tappable = c.state === 'remote-new' || c.state === 'deleted-local' || c.state === 'cloud-deleted'
                  const act = c.state === 'deleted-local' ? '이 기기로 되살리기' : c.state === 'cloud-deleted' ? '다시 올리기' : '이 기기로 받기'
                  const tap = () => (c.state === 'cloud-deleted' ? onPushOne(c) : onDownload(c))
                  return (
                    <div key={c.docId} className="cloud-item-wrap">
                      <div
                        className={'cloud-item ' + tone + (tappable ? ' is-tappable' : '')}
                        role={tappable ? 'button' : undefined}
                        tabIndex={tappable ? 0 : undefined}
                        aria-label={tappable ? `${c.title} — ${act}` : undefined}
                        onClick={tappable ? tap : undefined}
                        onKeyDown={
                          tappable
                            ? (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  tap()
                                }
                              }
                            : undefined
                        }
                      >
                        <div className="cloud-body">
                          <div className="cloud-name">{c.title}</div>
                          <div className="cloud-sub">
                            {c.category && <span>{c.category}</span>}
                            {c.device && <span>{c.device}</span>}
                            <span>{formatDate(c.updatedAt)}</span>
                          </div>
                        </div>

                        <span className={'cloud-badge ' + tone}>{m.badge}</span>

                        <button
                          className="cloud-more"
                          aria-label="더보기"
                          aria-expanded={openMenu === c.docId}
                          disabled={busy}
                          onClick={(e) => {
                            e.stopPropagation()
                            setOpenMenu((prev) => (prev === c.docId ? null : c.docId))
                          }}
                        >
                          <Icon name="more" size={16} />
                        </button>
                      </div>

                      {openMenu === c.docId && (
                        <div className="cloud-actions">
                          {c.state === 'pending' || c.state === 'new' ? (
                            <button
                              className="cloud-act"
                              disabled={busy}
                              onClick={() => {
                                setOpenMenu(null)
                                onPush()
                              }}
                            >
                              <Icon name="upload" size={14} /> 지금 올리기
                            </button>
                          ) : c.state === 'cloud-deleted' ? (
                            <button
                              className="cloud-act"
                              disabled={busy}
                              onClick={() => {
                                setOpenMenu(null)
                                onPushOne(c)
                              }}
                            >
                              <Icon name="upload" size={14} /> 다시 올리기
                            </button>
                          ) : (
                            <button
                              className="cloud-act"
                              disabled={busy}
                              onClick={() => {
                                setOpenMenu(null)
                                onDownload(c)
                              }}
                            >
                              <Icon name={c.state === 'deleted-local' ? 'restore' : 'download'} size={14} /> {act}
                            </button>
                          )}
                          {c.state !== 'new' && c.state !== 'cloud-deleted' && (
                            <button
                              className="cloud-act danger"
                              disabled={busy}
                              onClick={() => {
                                setOpenMenu(null)
                                onDelete(c)
                              }}
                            >
                              <Icon name="trash" size={14} /> 클라우드에서 삭제
                            </button>
                          )}
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
  )
}

export function SyncSection() {
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [last, setLast] = useState<number | null>(null)
  const [cloud, setCloud] = useState<CloudNoteInfo[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState<{ loaded: number; total: number | null } | null>(null)
  const [preview, setPreview] = useState<PushPlan | null>(null)

  useEffect(() => {
    const un = onSyncStatus(setStatus)
    return () => {
      un()
    }
  }, [])

  // 원본(PDF·이미지) 받는 중 표시
  useEffect(() => {
    const off = onAssetProgress((e) => setFetching(e.done ? null : { loaded: e.loaded, total: e.total }))
    return () => {
      off()
      setFetching(null)
    }
  }, [])

  const loadCloud = useCallback(async () => {
    setLoading(true)
    try {
      // 이 기기의 대기 변경이 방금 올려졌다면 먼저 비워 버전 판정이 정확해진다
      setCloud(await listCloudNotes())
    } catch (e) {
      toast(e instanceof Error ? e.message : '클라우드 목록을 가져오지 못했습니다.', 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void db.syncState.get('lastPushAt').then((v) => setLast((v?.value as number) ?? null))
    if (status !== 'auth-required' && status !== 'disabled') void loadCloud()
  }, [status, loadCloud])

  const doPull = async () => {
    const r = await pullNow()
    if (r) {
      toast(r.docs ? `노트 ${r.docs}개를 받았습니다.` : '이미 최신 상태입니다.', r.docs ? 'success' : 'info')
      void loadCloud()
    }
  }

  const doPush = async () => {
    try {
      const plan = await planPush()
      if (!plan.docs.length && !plan.assets.count) {
        toast('올릴 변경이 없습니다. 이미 최신 상태입니다.', 'info')
        return
      }
      setPreview(plan)
    } catch (e) {
      toast(e instanceof Error ? e.message : '상태를 확인하지 못했습니다.', 'error')
    }
  }

  const confirmPush = async () => {
    setPreview(null)
    await pushNow()
    void loadCloud()
  }

  const downloadOne = async (info: CloudNoteInfo) => {
    setLoading(true)
    try {
      const r = await downloadCloudNote(info)
      if (r === 'applied') toast(`"${info.title}"을(를) 받았습니다.`)
      else if (r === 'skipped') toast('이 기기에서 수정 중인 노트라 받지 못했습니다. 먼저 "올리기"를 눌러 주세요.', 'info')
      else toast('클라우드에서 그 노트를 찾지 못했습니다.', 'error')
      await loadCloud()
    } catch (e) {
      toast(e instanceof Error ? e.message : '받기 실패', 'error')
      setLoading(false)
    }
  }

  const deleteOne = async (info: CloudNoteInfo) => {
    if (
      !(await confirmDialog('클라우드에서 삭제', {
        message: `"${info.title}"을(를) 클라우드에서 지웁니다. 각 기기에 저장된 사본은 그대로 남습니다.`,
        ok: '삭제',
        danger: true
      }))
    )
      return
    setLoading(true)
    try {
      await deleteCloudNote(info)
      toast('클라우드에서 지웠습니다.')
      await loadCloud()
    } catch (e) {
      toast(e instanceof Error ? e.message : '삭제 실패', 'error')
      setLoading(false)
    }
  }

  /** 클라우드에서 삭제된 노트를 이 기기의 사본으로 다시 올린다 (지시서 3번) */
  const pushOne = async (info: CloudNoteInfo) => {
    if (
      !(await confirmDialog('다시 올리기', {
        message: '클라우드에서 삭제된 노트입니다. 이 기기의 사본을 다시 올릴까요?',
        ok: '올리기'
      }))
    )
      return
    setLoading(true)
    try {
      await pushOneNote(info.docId)
      toast(`"${info.title}"을(를) 다시 올렸습니다.`)
      await loadCloud()
    } catch (e) {
      toast(e instanceof Error ? e.message : '올리기 실패', 'error')
      setLoading(false)
    }
  }

  if (status === 'auth-required' || status === 'disabled') {
    return (
      <section className="panel-section" id="sync-settings">
        <h3>동기화 · Google Drive</h3>
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
    )
  }

  return (
    <section className="panel-section" id="sync-settings">
      <h3>동기화 · Google Drive</h3>
      <div className="setting-row">
        <span className="setting-label">
          상태
          <small>{last ? `마지막 동기화 ${formatDate(last)}` : '아직 동기화 전'}</small>
        </span>
        <span className="setting-control">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: status === 'idle' ? '#16a34a' : status === 'syncing' ? '#2563eb' : '#dc2626', flexShrink: 0 }} />
            {STATUS_LABEL[status]}
          </span>
          <button className="text-btn small" onClick={() => void logout().then(() => void syncNow())}>
            로그아웃
          </button>
        </span>
      </div>

      {fetching && (
        <p className="hint">
          원본 받는 중… {Math.round(fetching.loaded / 1024)}KB{fetching.total ? ` / ${Math.round(fetching.total / 1024)}KB` : ''}
        </p>
      )}

      <div className="btn-row">
        <button className="text-btn" onClick={() => void doPull()} disabled={status === 'syncing'}>
          <Icon name="download" size={16} /> 받기
        </button>
        <button className="text-btn" onClick={() => void doPush()} disabled={status === 'syncing'}>
          <Icon name="upload" size={16} /> 올리기
        </button>
      </div>
      <p className="hint">
        앱과 기타 파일은 각 메뉴에서 관리합니다.
      </p>

      <DeviceNameRow />

      <div className="setting-row" style={{ marginTop: 10 }}>
        <span className="setting-label">
          클라우드 노트
          <small>Drive에 저장된 노트 — 받을 것을 먼저 보여줍니다</small>
        </span>
        <span className="setting-control">
          <button className="text-btn small" onClick={() => void loadCloud()} disabled={loading || status === 'syncing'}>
            새로 고침
          </button>
        </span>
      </div>

      <CloudList
        cloud={cloud}
        busy={loading || status === 'syncing'}
        onDownload={(c) => void downloadOne(c)}
        onDelete={(c) => void deleteOne(c)}
        onPush={() => void doPush()}
        onPushOne={(c) => void pushOne(c)}
      />

      {preview && <PushPreview plan={preview} busy={status === 'syncing'} onConfirm={() => void confirmPush()} onClose={() => setPreview(null)} />}
    </section>
  )
}

/** 올리기 미리보기 — 이번 올리기에 클라우드로 올라갈 변경 목록 */
function PushPreview({ plan, busy, onConfirm, onClose }: { plan: PushPlan; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  // 삭제한 노트는 Drive에 올라가는 게 없어 미리보기에 세지 않는다 (지시서 4번)
  const groups = [
    { key: 'add' as const, label: '새 노트', icon: 'plus', items: plan.docs.filter((d) => d.change === 'add') },
    { key: 'modify' as const, label: '수정한 노트', icon: 'edit', items: plan.docs.filter((d) => d.change === 'modify') }
  ].filter((g) => g.items.length > 0)
  const total = plan.docs.length + plan.assets.count
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal push-modal" role="dialog" aria-label="올리기 미리보기">
        <header className="push-head">
          <span className="push-count">{total}</span>
          <div>
            <h2 className="modal-title">올리기 미리보기</h2>
            <p className="push-sub">클라우드에 이렇게 올라갑니다 · 올린 뒤 다른 기기의 변경도 받아옵니다</p>
          </div>
        </header>

        <div className="push-list">
          {groups.map((g) => (
            <section key={g.key} className="push-group">
              <h4 className="push-group-label">
                <Icon name={g.icon} size={13} /> {g.label} <b>{g.items.length}</b>
              </h4>
              {g.items.map((d) => (
                <div key={d.docId} className="push-row">
                  <span className={'push-stripe ' + g.key} />
                  <span className="push-name">{d.title}</span>
                  <Icon name={g.key === 'add' ? 'upload' : 'edit'} size={14} className="push-ico" />
                </div>
              ))}
            </section>
          ))}
          {plan.assets.count > 0 && (
            <section className="push-group">
              <h4 className="push-group-label">
                <Icon name="file" size={13} /> 원본 (PDF·이미지) <b>{plan.assets.count}</b>
              </h4>
              <div className="push-row">
                <span className="push-stripe add" />
                <span className="push-name">{Math.round(plan.assets.bytes / 1024)}KB</span>
                <Icon name="upload" size={14} className="push-ico" />
              </div>
            </section>
          )}
        </div>

        <div className="modal-actions">
          <button className="text-btn" onClick={onClose}>
            취소
          </button>
          <button className="primary-btn" onClick={onConfirm} disabled={busy}>
            <Icon name="upload" size={18} /> {total ? `${total}건 올리기` : '올리기'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 동기화 전용 사이드 패널 — 설정 패널에서 분리되어 툴바의 동기화 버튼으로 연다 */
export function SyncPanel() {
  const close = useUI((s) => s.setPanel)
  return (
    <aside id="sync-panel" className="side-panel" aria-label="동기화">
      <header className="panel-header">
        <h2>동기화</h2>
        <button className="tb-btn" onClick={() => close('sync')} aria-label="닫기">
          <Icon name="close" />
        </button>
      </header>
      <SyncSection />
    </aside>
  )
}

/** 라이브러리용 동기화 시트 — 설정 버튼 옆 초록 동기화 버튼으로 연다 */
export function SyncSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-label="동기화">
        <header className="sheet-header">
          <h2>동기화</h2>
          <button className="tb-btn" onClick={onClose} aria-label="닫기">
            <Icon name="close" />
          </button>
        </header>
        <div className="sheet-scroll">
          <SyncSection />
        </div>
      </div>
    </div>
  )
}
