import { useCallback, useEffect, useMemo, useState } from 'react'
import { useUI } from '../app/store'
import { login, logout, getDeviceName, setDeviceName } from '../sync/token'
import {
  downloadCloudNote,
  deleteCloudNote,
  excludeFromPush,
  listCloudNotes,
  onSyncProgress,
  onSyncStatus,
  planPush,
  pullNow,
  pushNow,
  pushOneNote,
  syncNow,
  type CloudNoteInfo,
  type CloudNoteState,
  type PushPlan,
  type SyncProgress,
  type SyncStatus
} from '../sync/sync'
import { onAssetProgress } from '../sync/assets'
import { analyzeGc, onGcProgress, runGc, type GcAnalysis } from '../sync/gcRun'
import { db } from '../storage/db'
import { formatDate } from '../shared/util'
import { confirmDialog } from '../app/dialogs'
import { Icon } from './Icon'

function toast(text: string, kind: 'info' | 'success' | 'error' = 'success') {
  void import('../app/store').then(({ useUI }) => useUI.getState().toast(text, kind))
}

/**
 * 상태 표시의 단일 출처 — 문구·톤·아이콘을 한곳에 모았다 (개선 1·구현 메모 ②).
 * 오프라인은 회색, 오류만 빨강으로 나눠 단순 오프라인이 오류처럼 보이지 않게 한다.
 */
type StatusTone = 'idle' | 'syncing' | 'offline' | 'error'
const STATUS_META: Record<SyncStatus, { label: string; tone: StatusTone; icon: string }> = {
  idle: { label: '동기화됨', tone: 'idle', icon: 'checkCircle' },
  syncing: { label: '동기화 중…', tone: 'syncing', icon: '' }, // 스피너
  offline: { label: '오프라인', tone: 'offline', icon: 'wifiOff' },
  'auth-required': { label: '로그인 필요', tone: 'error', icon: 'lock' },
  error: { label: '동기화 오류', tone: 'error', icon: 'alert' },
  disabled: { label: '서버 미설정', tone: 'offline', icon: 'cloud' }
}

// ───────────────── 클라우드 노트 목록 ─────────────────

type GroupKey = 'recv' | 'push' | 'fresh' | 'gone'
type RowAction = 'download' | 'pushOne' | 'repush' | 'restore' | null

/**
 * 행 표시의 단일 출처 — 배지·아이콘·그룹과 행의 주 동작까지 데이터로 둔다 (개선 7·구현 메모 ③).
 * action이 있는 행만 오른쪽에 주 동작 버튼을 렌더한다 — 숨은 "행 탭 = 즉시 실행"은 없다 (개선 5).
 * pending/new의 올리기는 onPush()(전체 미리보기)가 아니라 pushOneNote로 그 노트만 올린다 (개선 6).
 */
const STATE_META: Record<CloudNoteState, { group: GroupKey; badge: string; icon: string; action: RowAction }> = {
  'remote-new': { group: 'recv', badge: '새 버전', icon: 'cloudDown', action: 'download' },
  new: { group: 'push', badge: '새 파일', icon: 'plus', action: 'pushOne' },
  pending: { group: 'push', badge: '변경됨', icon: 'edit', action: 'pushOne' },
  'cloud-deleted': { group: 'push', badge: '클라우드에 없음', icon: 'alert', action: 'repush' },
  same: { group: 'fresh', badge: '최신', icon: 'check', action: null },
  'deleted-local': { group: 'gone', badge: '이 기기에서 삭제', icon: 'trash', action: 'restore' }
}

/** 행 주 동작 버튼의 문구·아이콘 */
const ACTION_UI: Record<Exclude<RowAction, null>, { label: string; icon: string }> = {
  download: { label: '받기', icon: 'download' },
  pushOne: { label: '올리기', icon: 'upload' },
  repush: { label: '다시 올리기', icon: 'upload' },
  restore: { label: '되살리기', icon: 'restore' }
}

/** 목록 그룹 — 받을 것 → 올릴 것(새 파일·변경·클라우드 삭제 포함) → 최신(접힘) → 이 기기에서 삭제됨(접힘) */
const GROUPS: { key: GroupKey; title: string; chip: string; states: CloudNoteState[]; startCollapsed: boolean }[] = [
  { key: 'recv', title: '받을 것', chip: '받을 것', states: ['remote-new'], startCollapsed: false },
  { key: 'push', title: '올릴 것', chip: '올릴 것', states: ['new', 'pending', 'cloud-deleted'], startCollapsed: false },
  { key: 'fresh', title: '최신', chip: '최신', states: ['same'], startCollapsed: true },
  { key: 'gone', title: '이 기기에서 삭제됨', chip: '삭제됨', states: ['deleted-local'], startCollapsed: true }
]

/** 요약 칸과 그룹 헤더가 같은 숫자를 두 번 보여 주던 것을 정리 — 건수는 한 곳에서 계산해 버튼·칩·헤더가 나눠 쓴다 (개선 2·4) */
interface CloudCounts extends Record<GroupKey, number> {
  pending: number
  new: number
  cdel: number
  bulkPush: number
}

function countCloud(cloud: CloudNoteInfo[]): CloudCounts {
  const c: CloudCounts = { recv: 0, push: 0, fresh: 0, gone: 0, pending: 0, new: 0, cdel: 0, bulkPush: 0 }
  for (const n of cloud) {
    c[STATE_META[n.state].group]++
    if (n.state === 'pending') c.pending++
    else if (n.state === 'new') c.new++
    else if (n.state === 'cloud-deleted') c.cdel++
  }
  c.bulkPush = c.pending + c.new // 클라우드에서 삭제된 노트는 일괄 올리기에서 제외 (clouddel 규칙)
  return c
}

/** 목록 로딩 중 — 같은 골격의 스켈레톤 */
function CloudSkeleton() {
  return (
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
  )
}

function CloudRow({
  c,
  busy,
  busyId,
  onPrimary,
  onDelete,
  onExclude
}: {
  c: CloudNoteInfo
  busy: boolean
  busyId: string | null
  onPrimary: (info: CloudNoteInfo) => void
  onDelete: (info: CloudNoteInfo) => void
  onExclude: (info: CloudNoteInfo) => void
}) {
  const [openMenu, setOpenMenu] = useState(false)
  const m = STATE_META[c.state]
  const rowBusy = busyId === c.docId
  const act = m.action ? ACTION_UI[m.action] : null
  // 모든 행에 ⋯ 메뉴를 두어 행 모양을 통일한다. 메뉴 항목은 클라우드에 실제 파일이 있는지로 정한다 —
  // new(한 번도 안 올림)는 일괄 올리기에서 뺄 수 있고, cloud-deleted는 클라우드에 지울 파일 자체가 없다
  const menuItem =
    c.state === 'new' ? (
      <button
        className="warn"
        onClick={() => {
          setOpenMenu(false)
          onExclude(c)
        }}
      >
        <Icon name="minus" size={16} /> 일괄 올리기에서 제외
      </button>
    ) : c.state === 'cloud-deleted' ? (
      <div className="cloud-menu-note">클라우드에 올라가 있지 않아 삭제할 것이 없습니다</div>
    ) : (
      <button
        className="danger"
        onClick={() => {
          setOpenMenu(false)
          onDelete(c)
        }}
      >
        <Icon name="trash" size={16} /> 클라우드에서 삭제
      </button>
    )
  return (
    <div className={'cloud-row g-' + m.group}>
      <span className="cloud-ico" aria-hidden="true">
        <Icon name={m.icon} size={15} />
      </span>
      <div className="cloud-body">
        <div className="cloud-name">{c.title}</div>
        <div className="cloud-meta">
          <span className="bdg">{m.badge}</span>
          {c.category && <span>{c.category}</span>}
          {c.device && <span>{c.device}</span>}
          <span>{formatDate(c.updatedAt)}</span>
          {c.state === 'cloud-deleted' && <span className="note">일괄 올리기에서 제외</span>}
        </div>
      </div>

      {act && (
        <button className="cloud-act-main" disabled={busy || rowBusy} onClick={() => onPrimary(c)}>
          {rowBusy ? <span className="spinner sm" /> : <Icon name={act.icon} size={14} />}
          <span>{rowBusy ? '처리 중' : act.label}</span>
        </button>
      )}

      <button className="cloud-more" aria-label="더보기" aria-expanded={openMenu} disabled={busy} onClick={() => setOpenMenu((v) => !v)}>
        <Icon name="more" size={16} />
      </button>
      {openMenu && (
        <>
          <button className="cloud-menu-bg" aria-label="메뉴 닫기" onClick={() => setOpenMenu(false)} />
          <div className="cloud-menu" role="menu">
            {menuItem}
          </div>
        </>
      )}
    </div>
  )
}

function CloudList({
  cloud,
  counts,
  busy,
  busyId,
  onPrimary,
  onDelete,
  onExclude,
  onPullAll,
  onPushPreview
}: {
  cloud: CloudNoteInfo[] | null
  counts: CloudCounts
  busy: boolean
  busyId: string | null
  onPrimary: (info: CloudNoteInfo) => void
  onDelete: (info: CloudNoteInfo) => void
  onExclude: (info: CloudNoteInfo) => void
  onPullAll: () => void
  onPushPreview: () => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<GroupKey | 'all'>('all')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ fresh: true, gone: true })

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (cloud ?? []).filter((n) => {
      if (filter !== 'all' && STATE_META[n.state].group !== filter) return false
      if (!q) return true
      return `${n.title} ${n.category ?? ''} ${n.device ?? ''}`.toLowerCase().includes(q)
    })
  }, [cloud, filter, query])

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
        <CloudSkeleton />
      </div>
    )
  }

  if (!cloud.length) {
    return (
      <div className="cloud-empty">
        <span className="big">
          <Icon name="cloud" size={24} />
        </span>
        <b>클라우드에 노트가 없습니다</b>
        <span>
          노트를 만든 뒤 위의 <b>올리기</b>를 눌러 주세요.
        </span>
      </div>
    )
  }

  const groups = GROUPS.map((g) => ({ ...g, items: visible.filter((n) => STATE_META[n.state].group === g.key) })).filter((g) => g.items.length > 0)

  return (
    <div className="cloud-panel">
      {/* 가로 스크롤 칩 한 줄로 필터 — 요약 칸 + 접히는 헤더의 이중 체계를 정리했다 (개선 4) */}
      <div className="cloud-chips" role="group" aria-label="상태별 필터">
        <button className={'cloud-chip' + (filter === 'all' ? ' on' : '')} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          전체<span>{cloud.length}</span>
        </button>
        {GROUPS.map((g) => {
          const on = filter === g.key
          return (
            <button
              key={g.key}
              className={'cloud-chip g-' + g.key + (on ? ' on' : '')}
              aria-pressed={on}
              title={on ? '필터 해제' : `${g.title}만 보기`}
              disabled={counts[g.key] === 0 && !on}
              onClick={() => setFilter(on ? 'all' : g.key)}
            >
              <i className="dot" />
              {g.chip}
              <span>{counts[g.key]}</span>
            </button>
          )
        })}
      </div>

      {groups.length === 0 && (
        <div className="cloud-empty">
          <span className="big">
            <Icon name="search" size={22} />
          </span>
          <span>조건에 맞는 노트가 없습니다.</span>
          <button
            className="sync-link"
            onClick={() => {
              setFilter('all')
              setQuery('')
            }}
          >
            필터·검색 지우기
          </button>
        </div>
      )}

      {groups.map((g) => {
        // 칩을 골랐거나 검색 중이면 접힌 그룹도 자동으로 펼친다 (개선 4)
        const isOpen = filter !== 'all' || !!query.trim() || !collapsed[g.key]
        return (
          <section className={'cloud-group g-' + g.key} key={g.key}>
            <div className="cloud-ghead">
              <button className="cloud-gtoggle" onClick={() => setCollapsed((m) => ({ ...m, [g.key]: !m[g.key] }))} aria-expanded={isOpen}>
                <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} />
                <span>{g.title}</span>
                <b>{g.items.length}</b>
              </button>
              {/* 그룹 자리에서 바로 처리하는 일괄 동작 (개선 9) */}
              {g.key === 'recv' && (
                <button className="cloud-bulk" disabled={busy} onClick={onPullAll}>
                  <Icon name="download" size={13} /> 모두 받기
                </button>
              )}
              {g.key === 'push' && counts.bulkPush > 0 && (
                <button className="cloud-bulk" disabled={busy} onClick={onPushPreview}>
                  <Icon name="upload" size={13} /> 미리보기
                </button>
              )}
            </div>

            {isOpen && (
              <div className="cloud-items">
                {g.items.map((c) => (
                  <CloudRow key={c.docId} c={c} busy={busy} busyId={busyId} onPrimary={onPrimary} onDelete={onDelete} onExclude={onExclude} />
                ))}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

// ───────────────── 섹션 ─────────────────

export function SyncSection() {
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [last, setLast] = useState<number | null>(null)
  const [cloud, setCloud] = useState<CloudNoteInfo[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [fetching, setFetching] = useState<{ loaded: number; total: number | null } | null>(null)
  const [prog, setProg] = useState<SyncProgress | null>(null)
  const [checked, setChecked] = useState<string | null>(null)
  const [device, setDevice] = useState('')
  const [preview, setPreview] = useState<PushPlan | null>(null)
  const [gcBusy, setGcBusy] = useState(false) // 에셋 GC 분석·실행 중 — SYNC_LOCK을 잡으므로 받기·올리기를 막는다

  useEffect(() => {
    const un = onSyncStatus((s) => {
      setStatus(s)
      if (s !== 'syncing') setProg(null)
    })
    const off = onSyncProgress(setProg)
    return () => {
      un()
      off()
    }
  }, [])

  useEffect(() => {
    void getDeviceName().then(setDevice)
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
      setChecked('방금 확인')
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

  const counts = useMemo(() => countCloud(cloud ?? []), [cloud])

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

  /** 새 노트를 일괄 올리기에서 뺀다 — 새 파일 행 메뉴의 "일괄 올리기에서 제외" */
  const excludeOne = async (info: CloudNoteInfo) => {
    try {
      await excludeFromPush(info.docId)
      toast(`"${info.title}"을(를) 일괄 올리기에서 제외했습니다.`)
      await loadCloud()
    } catch (e) {
      toast(e instanceof Error ? e.message : '제외하지 못했습니다.', 'error')
    }
  }

  /** 행의 주 동작 — 상태가 정한 하나의 동작을 실행한다 (개선 5) */
  const onPrimary = (info: CloudNoteInfo) => {
    const a = STATE_META[info.state].action
    if (a === 'pushOne' || a === 'repush') void pushOneRow(info)
    else void downloadOne(info)
  }

  const downloadOne = async (info: CloudNoteInfo) => {
    setBusyId(info.docId)
    try {
      const r = await downloadCloudNote(info)
      if (r === 'applied') toast(`"${info.title}"을(를) 받았습니다.`)
      else if (r === 'skipped') toast('이 기기에서 수정 중인 노트라 받지 못했습니다. 먼저 "올리기"를 눌러 주세요.', 'info')
      else toast('클라우드에서 그 노트를 찾지 못했습니다.', 'error')
      await loadCloud()
    } catch (e) {
      toast(e instanceof Error ? e.message : '받기 실패', 'error')
    } finally {
      setBusyId(null)
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
    setBusyId(info.docId)
    try {
      await deleteCloudNote(info)
      toast('클라우드에서 지웠습니다.')
      await loadCloud()
    } catch (e) {
      toast(e instanceof Error ? e.message : '삭제 실패', 'error')
    } finally {
      setBusyId(null)
    }
  }

  /**
   * 그 노트만 올린다 — 행 버튼은 이미 있는 pushOneNote(docId)를 쓴다 (개선 6).
   * 클라우드에서 삭제된 노트는 확인하고 다시 올린다.
   */
  const pushOneRow = async (info: CloudNoteInfo) => {
    const repush = info.state === 'cloud-deleted'
    if (
      repush &&
      !(await confirmDialog('다시 올리기', {
        message: '클라우드에서 삭제된 노트입니다. 이 기기의 사본을 다시 올릴까요?',
        ok: '올리기'
      }))
    )
      return
    setBusyId(info.docId)
    try {
      await pushOneNote(info.docId)
      toast(repush ? `"${info.title}"을(를) 다시 올렸습니다.` : `"${info.title}"을(를) 올렸습니다.`)
      await loadCloud()
    } catch (e) {
      toast(e instanceof Error ? e.message : '올리기 실패', 'error')
    } finally {
      setBusyId(null)
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

  const m = STATUS_META[status]
  // 받기·올리기 중에는 "노트 2/5 올리는 중" 같은 진행 문구를 보여 준다 (개선 8·구현 메모 ④)
  const syncMsg = prog ? (prog.phase === 'push' ? `노트 ${prog.done}/${prog.total} 올리는 중` : `노트 ${prog.done}/${prog.total} 받는 중`) : ''
  const pushSub =
    [counts.pending ? `변경 ${counts.pending}` : '', counts.new ? `새 파일 ${counts.new}` : ''].filter(Boolean).join(' · ') || '올릴 것 없음'

  return (
    <section className="panel-section" id="sync-settings">
      <h3>동기화 · Google Drive</h3>

      {/* 상태 카드 — 색만으로 전달하지 않게 톤·아이콘·설명을 갖춘다 (개선 1) */}
      <div className={'sync-status tone-' + m.tone} role="status" aria-live="polite">
        <span className="sync-status-ic" aria-hidden="true">
          {status === 'syncing' ? <span className="spinner" /> : <Icon name={m.icon} size={18} />}
        </span>
        <span className="sync-status-txt">
          <b>{m.label}</b>
          <small>
            {status === 'idle' && (last ? `마지막 동기화 ${formatDate(last)}${device ? ` · ${device}` : ''}` : '아직 동기화 전')}
            {status === 'syncing' && (syncMsg || 'Drive와 맞추는 중')}
            {status === 'offline' && '연결되면 받기·올리기를 할 수 있어요. 필기는 이 기기에 계속 저장됩니다.'}
            {status === 'error' && 'Drive 응답을 받지 못했습니다'}
          </small>
        </span>
        {status === 'error' && (
          <button className="sync-mini" onClick={() => void syncNow()}>
            다시 시도
          </button>
        )}
      </div>

      {/* 받기·올리기 — 건수 배지와 내용을 버튼 안으로 옮겨 눌러 보기 전에 알게 한다 (개선 2) */}
      <div className="sync-actions">
        <button className={'sync-big g-recv' + (counts.recv ? ' hot' : '')} onClick={() => void doPull()} disabled={status === 'syncing' || status === 'offline' || gcBusy}>
          <span className="sync-big-ic" aria-hidden="true">
            <Icon name="download" size={18} />
          </span>
          <span className="sync-big-txt">
            <b>받기</b>
            <small>{counts.recv ? `새 버전 ${counts.recv}개` : '받을 것 없음'}</small>
          </span>
          {counts.recv > 0 && <span className="cnt">{counts.recv}</span>}
        </button>
        <button className={'sync-big g-push' + (counts.bulkPush ? ' hot' : '')} onClick={() => void doPush()} disabled={status === 'syncing' || status === 'offline' || gcBusy}>
          <span className="sync-big-ic" aria-hidden="true">
            <Icon name="upload" size={18} />
          </span>
          <span className="sync-big-txt">
            <b>올리기</b>
            <small>{pushSub}</small>
          </span>
          {counts.bulkPush > 0 && <span className="cnt">{counts.bulkPush}</span>}
        </button>
      </div>
      <p className="hint">앱과 기타 파일은 각 메뉴에서 관리합니다.</p>

      {/* 원본(PDF·이미지) 받기 진행 바 (개선 8) */}
      {fetching && (
        <div className="sync-prog">
          <div className="sync-prog-top">
            <span>
              <Icon name="file" size={14} /> 원본 받는 중
            </span>
            <span>
              {Math.round(fetching.loaded / 1024).toLocaleString()}KB
              {fetching.total ? ` / ${Math.round(fetching.total / 1024).toLocaleString()}KB` : ''}
            </span>
          </div>
          <div className="bar">
            {fetching.total ? <i style={{ width: `${Math.min(100, (fetching.loaded / fetching.total) * 100)}%` }} /> : <i className="indet" />}
          </div>
        </div>
      )}

      {/* 목록 머리 — 새로 고침이 눌리는 동안 회전과 "확인 중…"으로 반응을 보여 준다 (개선 8) */}
      <div className="cloud-lhead">
        <span className="tt">
          클라우드 노트<span>{cloud?.length ?? 0}</span>
        </span>
        <small>{loading ? '확인 중…' : (checked ?? '')}</small>
        <button
          className={'cloud-icon-btn' + (loading ? ' spinning' : '')}
          onClick={() => void loadCloud()}
          disabled={loading || status === 'syncing' || gcBusy}
          aria-label="새로 고침"
        >
          <Icon name="replace" size={16} />
        </button>
      </div>

      <CloudList
        cloud={cloud}
        counts={counts}
        busy={loading || status === 'syncing'}
        busyId={busyId}
        onPrimary={onPrimary}
        onDelete={(c) => void deleteOne(c)}
        onExclude={(c) => void excludeOne(c)}
        onPullAll={() => void doPull()}
        onPushPreview={() => void doPush()}
      />

      {/* 이 기기 · 계정 — 입력칸이 받기·올리기와 목록 사이를 가르지 않게 맨 아래로 옮겼다 (개선 3) */}
      <DeviceFoot
        device={device}
        onSave={async (next) => {
          await setDeviceName(next)
          setDevice(next)
          // setDeviceName이 반영된 값을 바로 보여 준다 — 옛날 상태를 보여 주던 버그 (구현 메모 ①)
          toast(`기기 이름을 "${next}"(으)로 정했습니다. 다음 올리기부터 적용됩니다.`)
        }}
        onLogout={() => void logout().then(() => void syncNow())}
      />

      {/* 클라우드 에셋 정리 — 후보를 garbage로 격리만 하고 앱은 절대 삭제하지 않는다 (sync/gcRun.ts) */}
      <GcSection syncStatus={status} gcBusy={gcBusy} setGcBusy={setGcBusy} />

      {preview && <PushPreview plan={preview} busy={status === 'syncing'} onConfirm={() => void confirmPush()} onClose={() => setPreview(null)} />}
    </section>
  )
}

/** 이 기기 · 계정 정보 블록 — 「변경」을 눌러 이름을 고친다 (개선 3) */
function DeviceFoot({ device, onSave, onLogout }: { device: string; onSave: (next: string) => Promise<void>; onLogout: () => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const save = async () => {
    const next = name.trim()
    if (!next) return
    await onSave(next)
    setEditing(false)
    setName('')
  }
  return (
    <div className="sync-foot">
      <div className="sync-foot-row">
        <span className="k">이 기기</span>
        {editing ? (
          <>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={device || '기기 이름'}
              aria-label="기기 이름"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
                else if (e.key === 'Escape') setEditing(false)
              }}
            />
            <button className="sync-link" disabled={!name.trim()} onClick={() => void save()}>
              저장
            </button>
            <button className="sync-link muted" onClick={() => setEditing(false)}>
              취소
            </button>
          </>
        ) : (
          <>
            <span className="v">{device || '이름 없음'}</span>
            <button
              className="sync-link"
              onClick={() => {
                setName('')
                setEditing(true)
              }}
            >
              변경
            </button>
          </>
        )}
      </div>
      <div className="sync-foot-row">
        <span className="k">계정</span>
        <span className="v">Google Drive</span>
        <button className="sync-link muted" onClick={onLogout}>
          로그아웃
        </button>
      </div>
    </div>
  )
}

// ───────────────── 클라우드 에셋 정리 (에셋 GC) ─────────────────

/** 기기 보고서의 상대 시각 — "방금", "3시간 전", "94일 전" */
function relTime(ms: number): string {
  const s = Date.now() - ms
  if (s < 60_000) return '방금'
  const m = Math.floor(s / 60_000)
  if (m < 60) return `${m}분 전`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}시간 전`
  return `${Math.floor(h / 24)}일 전`
}

/** 바이트를 사람이 읽는 크기로 — "정리 대상: 원본 23개 · 148 MB" 문구에 쓴다 */
function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024)).toLocaleString()} MB`
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()}KB`
}

/** GC 보고서가 오래됐다고 본 기준 — 오래된 기기는 분석 정확도가 떨어진다 (sync/gcRun.ts) */
const GC_STALE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * "클라우드 에셋 정리" 섹션 — 분석 → 확인 → garbage로 옮기기 (구현.md 8장).
 * 앱은 절대 삭제하지 않는다: 후보는 Drive의 Inkpad/garbage 폴더로 격리만 하고,
 * 참조가 살아나면 앱이 garbage에서 즉시 되돌린다. 최종 삭제는 사용자가 Drive에서 직접 한다.
 */
function GcSection({ syncStatus, gcBusy, setGcBusy }: { syncStatus: SyncStatus; gcBusy: boolean; setGcBusy: (v: boolean) => void }) {
  const [analysis, setAnalysis] = useState<GcAnalysis | null>(null)
  const [excluded, setExcluded] = useState<string[]>([])
  const [progress, setProgress] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const off = onGcProgress((p) => {
      if (p.phase === 'sync') setProgress('이 기기 동기화 중')
      else if (p.phase === 'docs') setProgress(`클라우드 노트 확인 중 ${p.done}/${p.total}`)
      else if (p.phase === 'revisions') setProgress('버전 기록 확인 중')
      else if (p.phase === 'devices') setProgress('기기 보고 확인 중')
      else if (p.phase === 'run') setProgress(`원본 옮기는 중 ${p.done}/${p.total}`)
    })
    return () => {
      off()
      setProgress('')
    }
  }, [])

  const analyze = useCallback(
    async (ids: string[]) => {
      setGcBusy(true)
      setResult(null)
      setError(null)
      try {
        setAnalysis(await analyzeGc(ids))
      } catch (e) {
        setAnalysis(null)
        setError(e instanceof Error ? e.message : '분석에 실패했습니다.')
      } finally {
        setProgress('')
        setGcBusy(false)
      }
    },
    [setGcBusy]
  )

  /** 제외 토글 — 제외한 기기의 보고는 이번 분석의 보호 집합에서 뺀다 (구현.md 7.3). 다시 계산한다 — 캐시 덕에 저렴하다 */
  const toggleExcluded = (d: GcAnalysis['devices'][number]) => {
    if (d.isSelf) return // 이 기기 자신은 제외할 수 없다
    const next = excluded.includes(d.deviceId) ? excluded.filter((x) => x !== d.deviceId) : [...excluded, d.deviceId]
    setExcluded(next)
    if (analysis) void analyze(next)
  }

  const doRun = async () => {
    if (!analysis?.candidates.length) return
    if (
      !(await confirmDialog('클라우드 에셋 정리', {
        message: `정리 대상 원본 ${analysis.candidates.length}개(${fmtSize(analysis.candidateBytes)})를 Drive의 Inkpad/garbage 폴더로 옮깁니다. 앱이 직접 삭제하지는 않습니다.`,
        ok: '옮기기'
      }))
    )
      return
    setGcBusy(true)
    setError(null)
    try {
      const r = await runGc(analysis, excluded)
      setAnalysis(null)
      setResult(
        r.planned
          ? `원본 ${r.moved.length}개를 Inkpad/garbage로 옮겼습니다. Google Drive에서 garbage 폴더 내용을 확인한 뒤 직접 휴지통에 넣으면 저장 공간이 확보됩니다. 혹시 열리지 않는 노트가 생기면 앱이 garbage에서 자동으로 찾아 되돌립니다. garbage를 비운 뒤에는 되돌릴 수 없습니다.`
          : '정리할 원본이 없습니다. 분석 후에 다른 기기에서 변경이 있었는지 다시 확인해 주세요.'
      )
      if (r.failed.length) setError(`일부 원본(${r.failed.length}개)을 옮기지 못했습니다 — 다시 분석해 확인해 주세요.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '실행에 실패했습니다.')
    } finally {
      setProgress('')
      setGcBusy(false)
    }
  }

  const disabled = syncStatus === 'offline' || syncStatus === 'syncing' || gcBusy
  const stale = (reportedAt: number) => Date.now() - reportedAt > GC_STALE_MS

  return (
    <div className="sync-foot" role="group" aria-label="클라우드 에셋 정리">
      <p className="hint">
        사용하지 않는 PDF·이미지 원본을 Drive의 <b>Inkpad/garbage</b> 폴더로 옮겨 정리합니다. 앱이 직접 삭제하지는 않습니다.
        정확하게 정리하려면 <b>이 앱을 쓰는 모든 기기에서 먼저 동기화를 한 번씩 실행해 주세요.</b>
        동기화 기록이 없는 기기(이 기능 이전 버전의 앱 포함)에만 있는 노트는 보호되지 않습니다.
      </p>

      {progress ? (
        <p className="hint" role="status">
          <span className="spinner sm" /> {progress}
        </p>
      ) : (
        !analysis && (
          <div className="btn-row">
            <button className="text-btn" disabled={disabled} onClick={() => void analyze(excluded)}>
              <Icon name="search" size={16} /> 분석하기
            </button>
          </div>
        )
      )}

      {error && <p className="hint warn">{error}</p>}
      {result && <p className="hint">{result}</p>}

      {analysis && (
        <>
          {analysis.devices.map((d) => (
            <div className="sync-foot-row" key={d.deviceId}>
              <span className="k">
                {d.deviceName}
                {d.isSelf && ' (이 기기)'}
              </span>
              <span className="v">
                {relTime(d.reportedAt)}
                {stale(d.reportedAt) && (
                  <span className="note" title="이 기기에서 동기화하면 더 정확해집니다">
                    {' '}⚠
                  </span>
                )}
                {!d.isSelf && (
                  <button className="sync-link" disabled={disabled} onClick={() => toggleExcluded(d)}>
                    {excluded.includes(d.deviceId) ? '제외 해제' : '제외'}
                  </button>
                )}
              </span>
            </div>
          ))}
          {analysis.devices.some((d) => stale(d.reportedAt) && !d.isSelf) && (
            <p className="hint warn">7일이 넘은 기기가 있습니다 — 이 기기에서 동기화하면 더 정확해집니다.</p>
          )}
          {excluded.length > 0 && (
            <p className="hint warn">제외한 기기에만 있는 노트의 원본이 정리될 수 있습니다. garbage 폴더에서 복구는 가능합니다.</p>
          )}
          <div className="sync-foot-row">
            <span className="k">정리 대상</span>
            <span className="v">
              {analysis.candidates.length
                ? `원본 ${analysis.candidates.length}개 · ${fmtSize(analysis.candidateBytes)}`
                : '정리할 원본이 없습니다'}
            </span>
          </div>
          {analysis.toRescue.length > 0 && (
            <div className="sync-foot-row">
              <span className="k">되돌리기</span>
              <span className="v">사용 중인 원본 {analysis.toRescue.length}개를 garbage에서 되돌립니다</span>
            </div>
          )}
          <div className="btn-row">
            <button className="primary-btn" disabled={disabled || !analysis.candidates.length} onClick={() => void doRun()}>
              <Icon name="trash" size={16} /> garbage로 옮기기
            </button>
            <button className="text-btn" disabled={disabled} onClick={() => void analyze(excluded)}>
              다시 분석
            </button>
          </div>
          {analysis.warnings.map((w, i) => (
            <p key={i} className="hint warn">
              {w}
            </p>
          ))}
        </>
      )}
    </div>
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
