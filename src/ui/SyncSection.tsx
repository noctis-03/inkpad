import { useCallback, useEffect, useMemo, useState } from 'react'
import { useUI } from '../app/store'
import { login, logout, getDeviceName, setDeviceName } from '../sync/token'
import {
  downloadCloudNote,
  deleteCloudNote,
  excludeFromPush,
  listCloudNotes,
  listMergeQueue,
  onSyncProgress,
  onSyncStatus,
  planPull,
  planPush,
  pullNow,
  pushNow,
  pushOneNote,
  syncNow,
  type CloudNoteInfo,
  type CloudNoteState,
  type MergeQueueEntry,
  type LocalChangedDoc,
  type PullChoices,
  type PullPlan,
  type PushPlan,
  type SyncProgress,
  type SyncStatus
} from '../sync/sync'
import { onAssetProgress } from '../sync/assets'
import { isSyncLockHeld } from '../sync/lock'
import { db } from '../storage/db'
import { formatDate, formatBytes } from '../shared/util'
import { confirmDialog } from '../app/dialogs'
import { Icon } from './Icon'
import { MERGE_DONE_EVENT, openMergeView } from './merge/MergeView'
import { mergeDraftKeys } from '../sync/mergeDraft'
import { openArchive } from './ArchiveSheet'
import { openChanges } from './ChangesView'
import { Segmented } from './Segmented'
import { useEscClose } from './sheetParts'

function toast(text: string, kind: 'info' | 'success' | 'error' = 'success') {
  void import('../app/store').then(({ useUI }) => useUI.getState().toast(text, kind))
}

/** 카테고리 필터의 예약 키 — 실제 카테고리 이름과 겹치지 않게 */
const CAT_ALL = '__all__'
const CAT_NONE = '__none__'

/**
 * 상태 표시의 단일 출처 — 문구·톤·아이콘을 한곳에 모았다.
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

type GroupKey = 'split' | 'recv' | 'push' | 'fresh' | 'gone'
type RowAction = 'download' | 'pushOne' | 'repush' | 'restore' | 'merge' | null

/**
 * 행 표시의 단일 출처 — 배지·아이콘·그룹과 행의 주 동작까지 데이터로 둔다.
 * action이 있는 행만 오른쪽에 주 동작 버튼을 렌더한다 — 숨은 "행 탭 = 즉시 실행"은 없다.
 * pending/new의 올리기는 onPush()(전체 미리보기)가 아니라 pushOneNote로 그 노트만 올린다.
 */
const STATE_META: Record<CloudNoteState, { group: GroupKey; badge: string; icon: string; action: RowAction }> = {
  'remote-new': { group: 'recv', badge: '새 버전', icon: 'cloudDown', action: 'download' },
  new: { group: 'push', badge: '새 파일', icon: 'plus', action: 'pushOne' },
  pending: { group: 'push', badge: '변경됨', icon: 'edit', action: 'pushOne' },
  // 갈라짐 — 이 기기 변경은 이 기기 브랜치에 올라가 있다. 받기로 덮지 않고, 머지 관리에서 합친다
  diverged: { group: 'split', badge: '갈라짐', icon: 'alert', action: 'merge' },
  'cloud-deleted': { group: 'push', badge: '클라우드에 없음', icon: 'alert', action: 'repush' },
  same: { group: 'fresh', badge: '최신', icon: 'check', action: null },
  'deleted-local': { group: 'gone', badge: '이 기기에서 삭제', icon: 'trash', action: 'restore' }
}

/** 행 주 동작 버튼의 문구·아이콘 */
const ACTION_UI: Record<Exclude<RowAction, null>, { label: string; icon: string }> = {
  download: { label: '받기', icon: 'download' },
  pushOne: { label: '올리기', icon: 'upload' },
  repush: { label: '다시 올리기', icon: 'upload' },
  restore: { label: '되살리기', icon: 'restore' },
  merge: { label: '머지', icon: 'swap' }
}

/** 목록 그룹 — 갈라짐 → 받을 것 → 올릴 것(새 파일·변경·클라우드 삭제 포함) → 최신(접힘) → 이 기기에서 삭제됨(접힘) */
const GROUPS: { key: GroupKey; title: string; chip: string; states: CloudNoteState[]; startCollapsed: boolean }[] = [
  { key: 'split', title: '갈라짐 — 머지 필요', chip: '갈라짐', states: ['diverged'], startCollapsed: false },
  { key: 'recv', title: '받을 것', chip: '받을 것', states: ['remote-new'], startCollapsed: false },
  { key: 'push', title: '올릴 것', chip: '올릴 것', states: ['new', 'pending', 'cloud-deleted'], startCollapsed: false },
  { key: 'fresh', title: '최신', chip: '최신', states: ['same'], startCollapsed: true },
  { key: 'gone', title: '이 기기에서 삭제됨', chip: '삭제됨', states: ['deleted-local'], startCollapsed: true }
]

/** 요약 칸과 그룹 헤더가 같은 숫자를 두 번 보여 주던 것을 정리 — 건수는 한 곳에서 계산해 버튼·칩·헤더가 나눠 쓴다 */
interface CloudCounts extends Record<GroupKey, number> {
  pending: number
  new: number
  cdel: number
  bulkPush: number
}

function countCloud(cloud: CloudNoteInfo[]): CloudCounts {
  const c: CloudCounts = { split: 0, recv: 0, push: 0, fresh: 0, gone: 0, pending: 0, new: 0, cdel: 0, bulkPush: 0 }
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
  onExclude,
  onAlign
}: {
  c: CloudNoteInfo
  busy: boolean
  busyId: string | null
  onPrimary: (info: CloudNoteInfo) => void
  onDelete: (info: CloudNoteInfo) => void
  onExclude: (info: CloudNoteInfo) => void
  onAlign: (info: CloudNoteInfo) => void
}) {
  const [openMenu, setOpenMenu] = useState(false)
  const m = STATE_META[c.state]
  const rowBusy = busyId === c.docId
  const act = m.action ? ACTION_UI[m.action] : null
  // 클라우드에 실제 파일이 있는 행(변경됨·새 버전·갈라짐)은 '클라우드에 맞추기'도 제공한다 —
  // 이 기기 노트를 클라우드 버전으로 덮는다 (받기와 달리 수정 대기가 있거나 갈라져도 진행). 이 기기 변경은 브랜치에 남는다
  const canAlign = c.state === 'pending' || c.state === 'remote-new' || c.state === 'diverged'
  // 모든 행에 ⋯ 메뉴를 두어 행 모양을 통일한다. 메뉴 항목은 클라우드에 실제 파일이 있는지로 정한다 —
  // new(한 번도 안 올림)는 일괄 올리기에서 뺄 수 있고, cloud-deleted는 클라우드에 지울 파일 자체가 없다
  const menuItem = (
    <>
      {canAlign && (
        <button
          onClick={() => {
            setOpenMenu(false)
            onAlign(c)
          }}
        >
          <Icon name="cloudDown" size={16} /> 클라우드에 맞추기
        </button>
      )}
      {c.state === 'new' ? (
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
      )}
    </>
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
          {c.state === 'diverged' && <span className="note">이 기기 변경은 브랜치에 보관됨</span>}
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
  onAlign,
  onPullAll,
  onPullCategory,
  onPushPreview
}: {
  cloud: CloudNoteInfo[] | null
  counts: CloudCounts
  busy: boolean
  busyId: string | null
  onPrimary: (info: CloudNoteInfo) => void
  onDelete: (info: CloudNoteInfo) => void
  onExclude: (info: CloudNoteInfo) => void
  onAlign: (info: CloudNoteInfo) => void
  onPullAll: () => void
  onPullCategory: (cat: string | null) => void
  onPushPreview: () => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<GroupKey | 'all'>('all')
  const [catFilter, setCatFilter] = useState<string>(CAT_ALL)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ fresh: true, gone: true })

  // 카테고리 목록 — 클라우드 노트의 category (없으면 미분류). 가나다순, 미분류는 맨 뒤
  const cats = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of cloud ?? []) {
      const k = n.category || CAT_NONE
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    const out: { key: string; name: string; cat: string | null; count: number }[] = [...m.keys()]
      .filter((k) => k !== CAT_NONE)
      .sort((a, b) => a.localeCompare(b, 'ko'))
      .map((k) => ({ key: k, name: k, cat: k, count: m.get(k) ?? 0 }))
    if (m.has(CAT_NONE)) out.push({ key: CAT_NONE, name: '미분류', cat: null, count: m.get(CAT_NONE) ?? 0 })
    return out
  }, [cloud])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (cloud ?? []).filter((n) => {
      if (filter !== 'all' && STATE_META[n.state].group !== filter) return false
      if (catFilter !== CAT_ALL && (n.category || CAT_NONE) !== catFilter) return false
      if (!q) return true
      return `${n.title} ${n.category ?? ''} ${n.device ?? ''}`.toLowerCase().includes(q)
    })
  }, [cloud, filter, catFilter, query])

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
  // 고른 카테고리 안의 "받을 것" — 카테고리 단위 받기 버튼이 쓴다
  const catValue = catFilter === CAT_NONE ? null : catFilter
  const catName = cats.find((c) => c.key === catFilter)?.name ?? '카테고리'
  const recvCatCount = (cloud ?? []).filter((n) => n.state === 'remote-new' && (n.category || CAT_NONE) === catFilter).length

  return (
    <div className="cloud-panel">
      {/* 가로 스크롤 칩 한 줄로 필터 — 요약 칸 + 접히는 헤더의 이중 체계를 정리했다 */}
      <div className="cloud-chips" role="group" aria-label="상태별 필터">
        <button className={'cloud-chip' + (filter === 'all' ? ' on' : '')} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          전체<span>{cloud.length}</span>
        </button>
        {GROUPS.map((g) => {
          const on = filter === g.key
          // 0개인 상태는 칩을 내지 않는다 — 흐린 '갈라짐 0 · 받을 것 0 · 삭제됨 0'이 줄을 채우지 않게
          if (counts[g.key] === 0 && !on) return null
          return (
            <button
              key={g.key}
              className={'cloud-chip g-' + g.key + (on ? ' on' : '')}
              aria-pressed={on}
              title={on ? '필터 해제' : `${g.title}만 보기`}
              onClick={() => setFilter(on ? 'all' : g.key)}
            >
              <i className="dot" />
              {g.chip}
              <span>{counts[g.key]}</span>
            </button>
          )
        })}
      </div>

      {/* 카테고리별 필터 — 고르면 목록이 그 카테고리로 좇혀 보이고, 받을 것 머리글의 받기도 카테고리 단위가 된다 */}
      {cats.length > 0 && (
        <div className="cloud-chips" role="group" aria-label="카테고리별 필터">
          {cats.map((c) => (
            <button
              key={c.key}
              className={'cloud-chip cat' + (catFilter === c.key ? ' on' : '')}
              aria-pressed={catFilter === c.key}
              title={catFilter === c.key ? '카테고리 필터 해제' : `${c.name} 카테고리만 보기`}
              onClick={() => setCatFilter(catFilter === c.key ? CAT_ALL : c.key)}
            >
              <i className="dot" />
              {c.name}
              <span>{c.count}</span>
            </button>
          ))}
        </div>
      )}

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
              setCatFilter(CAT_ALL)
              setQuery('')
            }}
          >
            필터·검색 지우기
          </button>
        </div>
      )}

      {groups.map((g) => {
        // 칩을 골랐거나 검색 중이면 접힌 그룹도 자동으로 펼친다
        const isOpen = filter !== 'all' || !!query.trim() || !collapsed[g.key]
        return (
          <section className={'cloud-group g-' + g.key} key={g.key}>
            <div className="cloud-ghead">
              <button className="cloud-gtoggle" onClick={() => setCollapsed((m) => ({ ...m, [g.key]: !m[g.key] }))} aria-expanded={isOpen}>
                <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} />
                <span>{g.title}</span>
                <b>{g.items.length}</b>
              </button>
              {/* 그룹 자리에서 바로 처리하는 일괄 동작 */}
              {g.key === 'recv' &&
                (catFilter === CAT_ALL ? (
                  <button className="cloud-bulk" disabled={busy} onClick={onPullAll}>
                    <Icon name="download" size={13} /> 모두 받기
                  </button>
                ) : (
                  <button
                    className="cloud-bulk"
                    disabled={busy || recvCatCount === 0}
                    onClick={() => onPullCategory(catValue)}
                    title={`${catName} 카테고리의 받을 것을 한 번에 내려받습니다`}
                  >
                    <Icon name="download" size={13} /> {catName} 받기 ({recvCatCount})
                  </button>
                ))}
              {g.key === 'push' && counts.bulkPush > 0 && (
                <button className="cloud-bulk" disabled={busy} onClick={onPushPreview}>
                  <Icon name="upload" size={13} /> 미리보기
                </button>
              )}
            </div>

            {isOpen && (
              <div className="cloud-items">
                {g.items.map((c) => (
                  <CloudRow key={c.docId} c={c} busy={busy} busyId={busyId} onPrimary={onPrimary} onDelete={onDelete} onExclude={onExclude} onAlign={onAlign} />
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
  const [queue, setQueue] = useState<MergeQueueEntry[]>([])
  const [drafts, setDrafts] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [fetching, setFetching] = useState<{ loaded: number; total: number | null } | null>(null)
  const [prog, setProg] = useState<SyncProgress | null>(null)
  const [checked, setChecked] = useState<string | null>(null)
  const [device, setDevice] = useState('')
  const [preview, setPreview] = useState<PushPlan | null>(null)
  const [pullPlan, setPullPlan] = useState<PullPlan | null>(null)
  const [pullPreview, setPullPreview] = useState<PullPlan | null>(null)
  const [pullCat, setPullCat] = useState<string | null>(null)
  const [selfBusy, setSelfBusy] = useState(false) // 이 창의 일괄 받기·올리기 — 잠금을 쥐기 전부터 표시
  const [outside, setOutside] = useState<boolean | null>(null) // 창 밖의 동기화가 잠금을 쥐고 있는가 (null = 확인 전)

  // 창 밖(편집 화면의 노트 칩, 다른 탭 등)에서 시작한 올리기·받기가 잠금을 쥐고 있으면 창 내용을 가리고 끝나기를 기다린다.
  // 그 사이 목록은 반쯤 바뀐 상태라 믿을 수 없고, 받기·올리기를 눌러도 잠금에 막힌다. 끝나면 목록을 새로 읽는다.
  // 이 창이 한 일이 쥔 잠금은 기다리지 않는다. 잠금 목록만 보므로 네트워크는 쓰지 않는다
  const ownBusy = selfBusy || status === 'syncing' || busyId !== null || pullCat !== null
  useEffect(() => {
    if (ownBusy) {
      setOutside(false)
      return
    }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      const held = await isSyncLockHeld()
      if (!alive) return
      setOutside(held)
      timer = setTimeout(() => void tick(), held ? 400 : 1500)
    }
    void tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [ownBusy])

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
      // 머지할 것(다른 기기 브랜치 포함) — 목록을 새로 고칠 때 함께 읽는다(메타만, 목록 요청 1번)
      setQueue(await listMergeQueue().catch((e) => (console.warn('[sync] 머지할 것 목록을 읽지 못했습니다:', e), [] as MergeQueueEntry[])))
      setDrafts(await mergeDraftKeys())
    } catch (e) {
      toast(e instanceof Error ? e.message : '클라우드 목록을 가져오지 못했습니다.', 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  // 최종 머지가 끝나면 목록을 다시 읽는다
  useEffect(() => {
    const onDone = () => void loadCloud()
    window.addEventListener(MERGE_DONE_EVENT, onDone)
    return () => window.removeEventListener(MERGE_DONE_EVENT, onDone)
  }, [loadCloud])

  useEffect(() => {
    void db.syncState.get('lastPushAt').then((v) => setLast((v?.value as number) ?? null))
    // 동기화 중에는 목록을 다시 읽지 않는다 — 끝나고 idle로 돌아올 때 한 번만 읽는다.
    // (예전에는 syncing 진입·이탈마다 읽어 올리기 1회에 목록 새로고침이 3~4번 나갔다)
    if (status === 'auth-required' || status === 'disabled' || status === 'syncing') return
    if (outside !== false) return // 창 밖의 동기화가 끝난 뒤에 읽는다
    void loadCloud()
  }, [status, outside, loadCloud])

  const counts = useMemo(() => countCloud(cloud ?? []), [cloud])

  /** 받기 미리보기 — 받을 목록을 먼저 보여 주고 확인 받아 실행한다 */
  const doPull = async () => {
    try {
      const plan = await planPull()
      if (!plan.docs.length && !plan.local.length) {
        toast('이미 최신 상태입니다.', 'info')
        return
      }
      setPullPreview(plan) // 이 기기 변경이 있는 노트가 있으면 덮을지·올릴지 고르게 한다
    } catch (e) {
      toast(e instanceof Error ? e.message : '상태를 확인하지 못했습니다.', 'error')
    }
  }

  const confirmPull = async (choices: PullChoices) => {
    setPullPreview(null)
    setSelfBusy(true)
    const r = await pullNow(choices).finally(() => setSelfBusy(false))
    if (r) {
      const parts = [
        r.docs ? `노트 ${r.docs}개를 받았습니다` : '',
        r.overwritten ? `${r.overwritten}개를 클라우드로 덮었습니다(이 기기 내용은 스냅샷에 남음)` : '',
        r.pushed ? `${r.pushed}개를 올렸습니다` : ''
      ].filter(Boolean)
      const busy = r.busy ? `다른 탭에서 편집 중인 노트 ${r.busy}개는 건너뛰었습니다. 그 탭을 닫은 뒤 다시 받아 주세요.` : ''
      if (parts.length) toast(parts.join(' · ') + '.' + (busy ? ' ' + busy : ''), 'success')
      else toast(busy || '이미 최신 상태입니다.', 'info')
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
      setPullPlan(null)
      // 받아올 변경의 예상 용량 — 클라우드 목록만 읽고 본문은 받지 않는다. 실패하면 줄을 생략한다
      planPull()
        .then(setPullPlan)
        .catch(() => setPullPlan(null))
    } catch (e) {
      toast(e instanceof Error ? e.message : '상태를 확인하지 못했습니다.', 'error')
    }
  }

  const confirmPush = async () => {
    setPreview(null)
    setSelfBusy(true)
    await pushNow().finally(() => setSelfBusy(false)) // 끝나면 status가 idle로 돌아가 위 effect가 목록을 한 번 새로 읽는다
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

  /** 행의 주 동작 — 상태가 정한 하나의 동작을 실행한다 */
  const onPrimary = (info: CloudNoteInfo) => {
    const a = STATE_META[info.state].action
    if (a === 'pushOne' || a === 'repush') void pushOneRow(info)
    else if (a === 'merge') openMergeFor(info)
    else void downloadOne(info)
  }

  /** 갈라진 노트의 '머지' — 이 기기 브랜치(없으면 그 노트의 다른 브랜치)를 머지 화면으로 연다 */
  const openMergeFor = (info: CloudNoteInfo) => {
    const mine = queue.filter((e) => e.docId === info.docId)
    const target = mine.find((e) => e.mine) ?? mine[0]
    if (target) openMergeView(target)
    else toast('머지할 것을 찾지 못했습니다. 목록을 새로 고친 뒤 다시 시도해 주세요.', 'info')
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

  /** 행 메뉴의 "클라우드에 맞추기" — 이 기기에서 바꾼 것을 비교 화면에서 보고 덮는다(이 기기 내용은 스냅샷으로 남는다) */
  const alignOne = (info: CloudNoteInfo) => openChanges({ docId: info.docId, title: info.title, actions: ['align', 'push'] })

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
   * 그 노트만 올린다 — 행 버튼은 이미 있는 pushOneNote(docId)를 쓴다.
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
      const r = await pushOneNote(info.docId)
      if (r === 'diverged') toast(`"${info.title}"은(는) 다른 기기에서도 바뀌어 이 기기 브랜치에만 올렸습니다(갈라짐).`, 'info')
      else toast(repush ? `"${info.title}"을(를) 다시 올렸습니다.` : `"${info.title}"을(를) 올렸습니다.`)
      await loadCloud()
    } catch (e) {
      toast(e instanceof Error ? e.message : '올리기 실패', 'error')
    } finally {
      setBusyId(null)
    }
  }

  /** 카테고리 단위 받기 — 그 카테고리의 "받을 것"(새 노트·새 버전)을 한 번에 내려받는다 */
  const pullCategory = async (cat: string | null) => {
    const targets = (cloud ?? []).filter((n) => n.state === 'remote-new' && n.fileId && (n.category ?? null) === cat)
    if (!targets.length) {
      toast('그 카테고리에서 받을 노트가 없습니다.', 'info')
      return
    }
    if (!(await confirmDialog('카테고리 받기', { message: `"${cat ?? '미분류'}" 노트 ${targets.length}장을 클라우드에서 받아옵니다.`, ok: '받기' }))) return
    setPullCat(cat ?? CAT_NONE)
    try {
      let n = 0
      for (const t of targets) {
        try {
          if ((await downloadCloudNote(t)) === 'applied') n++
        } catch (e) {
          console.warn('[sync] 카테고리 받기 실패', t.docId, e)
        }
      }
      toast(n ? `"${cat ?? '미분류'}" 노트 ${n}장을 받았습니다.` : '받은 노트가 없습니다.', n ? 'success' : 'info')
      await loadCloud()
    } finally {
      setPullCat(null)
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

  if (outside) {
    return (
      <section className="panel-section" id="sync-settings">
        <h3>동기화 · Google Drive</h3>
        <div className="sync-wait" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <b>다른 곳에서 동기화가 진행 중입니다</b>
          <small>편집 화면의 노트 칩이나 다른 탭에서 시작한 올리기·받기가 끝날 때까지 기다려 주세요. 끝나면 목록을 새로 읽어 보여 드립니다.</small>
        </div>
      </section>
    )
  }

  const m = STATUS_META[status]
  // 받기·올리기 중에는 "노트 2/5 올리는 중" 같은 진행 문구를 보여 준다
  const syncMsg = prog ? (prog.phase === 'push' ? `노트 ${prog.done}/${prog.total} 올리는 중` : `노트 ${prog.done}/${prog.total} 받는 중`) : ''
  const pushSub =
    [counts.pending ? `변경 ${counts.pending}` : '', counts.new ? `새 파일 ${counts.new}` : ''].filter(Boolean).join(' · ') || '올릴 것 없음'

  return (
    <section className="panel-section" id="sync-settings">
      {/* 제목은 감싼 시트·패널 머리('동기화')가 맡는다 — 같은 말을 두 번 쓰지 않는다. Google Drive는 맨 아래 계정 줄에 */}

      {/* 상태 카드 — 색만으로 전달하지 않게 톤·아이콘·설명을 갖춘다 */}
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

      {/* 받기·올리기 — 건수 배지와 내용을 버튼 안으로 옮겨 눌러 보기 전에 알게 한다 */}
      <div className="sync-actions">
        <button className={'sync-big g-recv' + (counts.recv ? ' hot' : '')} onClick={() => void doPull()} disabled={status === 'syncing' || status === 'offline'}>
          <span className="sync-big-ic" aria-hidden="true">
            <Icon name="download" size={18} />
          </span>
          <span className="sync-big-txt">
            <b>받기</b>
            <small>{counts.recv ? `새 버전 ${counts.recv}개` : '받을 것 없음'}</small>
          </span>
          {counts.recv > 0 && <span className="cnt">{counts.recv}</span>}
        </button>
        <button className={'sync-big g-push' + (counts.bulkPush ? ' hot' : '')} onClick={() => void doPush()} disabled={status === 'syncing' || status === 'offline'}>
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
      <p className="hint">받기·올리기는 노트만 주고받습니다. 앱·기타 파일·보드 프리셋은 추가하거나 고칠 때 그 항목만 바로 올라가고, 못 올린 것은 각 메뉴에서 다시 올립니다.</p>

      {/* 원본(PDF·이미지) 받기 진행 바 */}
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

      {/* 머지할 것 — 갈라진 브랜치(다른 기기 것 포함). 행을 누르면 머지 화면 */}
      <MergeQueueCard queue={queue} drafts={drafts} />

      {/* 목록 머리 — 새로 고침이 눌리는 동안 회전과 "확인 중…"으로 반응을 보여 준다 */}
      <div className="cloud-lhead">
        <span className="tt">
          클라우드 노트<span>{cloud?.length ?? 0}</span>
        </span>
        <small>{loading ? '확인 중…' : (checked ?? '')}</small>
        <button
          className={'cloud-icon-btn' + (loading ? ' spinning' : '')}
          onClick={() => void loadCloud()}
          disabled={loading || status === 'syncing'}
          aria-label="새로 고침"
        >
          <Icon name="replace" size={16} />
        </button>
      </div>

      <CloudList
        cloud={cloud}
        counts={counts}
        busy={loading || status === 'syncing' || !!pullCat}
        busyId={busyId}
        onPrimary={onPrimary}
        onDelete={(c) => void deleteOne(c)}
        onExclude={(c) => void excludeOne(c)}
        onAlign={(c) => void alignOne(c)}
        onPullAll={() => void doPull()}
        onPullCategory={(c) => void pullCategory(c)}
        onPushPreview={() => void doPush()}
      />

      {/* 보관함 관리 — 기기 브랜치·옛 백업·스냅샷·자동 고정 정리 */}
      <button className="cloud-archive-btn" onClick={openArchive}>
        <Icon name="files" size={16} /> 보관함 관리
        <small>브랜치·옛 백업·스냅샷·자동 고정 정리</small>
      </button>

      {/* 이 기기 · 계정 — 입력칸이 받기·올리기와 목록 사이를 가르지 않게 맨 아래로 옮겼다 */}
      <DeviceFoot
        device={device}
        onSave={async (next) => {
          await setDeviceName(next)
          setDevice(next)
          // setDeviceName이 반영된 값을 바로 보여 준다 — 저장 전 옛 이름을 보여 주던 버그를 막는다
          toast(`기기 이름을 "${next}"(으)로 정했습니다. 다음 올리기부터 적용됩니다.`)
        }}
        onLogout={() => void logout().then(() => void syncNow())}
      />

      {preview && <PushPreview plan={preview} pull={pullPlan} busy={status === 'syncing'} onConfirm={() => void confirmPush()} onClose={() => setPreview(null)} />}
      {pullPreview && <PullPreview plan={pullPreview} busy={status === 'syncing'} onConfirm={(c) => void confirmPull(c)} onClose={() => setPullPreview(null)} />}
    </section>
  )
}

/** 이 기기 · 계정 정보 블록 — 「변경」을 눌러 이름을 고친다 */
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
                else if (e.key === 'Escape') {
                  e.preventDefault() // 이름 고치기만 취소 — 시트는 닫지 않는다
                  setEditing(false)
                }
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

/** 올리기 미리보기 — 이번 올리기에 클라우드로 올라갈 변경과, 올린 뒤 받아올 다른 기기의 변경 */
function PushPreview({ plan, pull, busy, onConfirm, onClose }: { plan: PushPlan; pull: PullPlan | null; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  // 삭제한 노트는 Drive에 올라가는 게 없어 미리보기에 세지 않는다 (삭제는 이 기기의 일)
  const groups = [
    { key: 'add' as const, label: '새 노트', icon: 'plus', items: plan.docs.filter((d) => d.change === 'add') },
    { key: 'modify' as const, label: '수정한 노트', icon: 'edit', items: plan.docs.filter((d) => d.change === 'modify') }
  ].filter((g) => g.items.length > 0)
  const total = plan.docs.length + plan.assets.count
  // 이번 올리기 전체 예상 용량 — 노트(gzip 청크 기준) + 새로 올릴 원본
  const totalBytes = plan.docs.reduce((n, d) => n + d.bytes, 0) + plan.assets.bytes
  useEscClose(onClose, !busy)
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal push-modal" role="dialog" aria-label="올리기 미리보기">
        <header className="push-head">
          <span className="push-count">{total}</span>
          <div>
            <h2 className="modal-title">올리기 미리보기</h2>
            <p className="push-sub">
              클라우드에 이렇게 올라갑니다{totalBytes > 0 ? ` · 약 ${formatBytes(totalBytes)}` : ''} · 올린 뒤 다른 기기의 변경도 받아옵니다
            </p>
          </div>
        </header>

        <div className="push-list">
          {pull && pull.docs.length > 0 && (
            <section className="push-group">
              <h4 className="push-group-label">
                <Icon name="cloudDown" size={13} /> 받을 것 — 다른 기기의 변경 <b>{pull.docs.length}</b>
              </h4>
              {pull.docs.map((d) => (
                <div key={d.docId} className="push-row">
                  <span className={'push-stripe ' + (d.change === 'add' ? 'add' : 'recv')} />
                  <span className="push-name">{d.title}</span>
                  {d.device && <span className="push-device">{d.device}</span>}
                  <span className="push-size">{formatBytes(d.bytes)}</span>
                  <Icon name={d.change === 'add' ? 'plus' : 'cloudDown'} size={14} className="push-ico" />
                </div>
              ))}
            </section>
          )}
          {groups.map((g) => (
            <section key={g.key} className="push-group">
              <h4 className="push-group-label">
                <Icon name={g.icon} size={13} /> {g.label} <b>{g.items.length}</b>
              </h4>
              {g.items.map((d) => (
                <div key={d.docId} className="push-row">
                  <span className={'push-stripe ' + g.key} />
                  <span className="push-name">{d.title}</span>
                  <span className="push-size">{formatBytes(d.bytes)}</span>
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
                <span className="push-name">새로 올릴 원본 {plan.assets.count}개</span>
                <span className="push-size">{formatBytes(plan.assets.bytes)}</span>
                <Icon name="upload" size={14} className="push-ico" />
              </div>
            </section>
          )}
        </div>

        <div className="modal-actions">
          <span className="push-total">예상 용량 {totalBytes > 0 ? `약 ${formatBytes(totalBytes)}` : '0 B'}</span>
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

/** 머지 관리 — main에 아직 들어가지 않은 기기 브랜치 목록. 하나씩 머지 화면에서 합친다 */
function MergeQueueCard({ queue, drafts }: { queue: MergeQueueEntry[]; drafts: Set<string> }) {
  if (!queue.length) return null
  return (
    <section className="merge-queue" aria-label="머지 관리">
      <h4 className="merge-queue-head">
        <Icon name="swap" size={15} /> 머지 관리 <b>{queue.length}</b>
        <small>양쪽이 각각 고친 노트 — 직접 확인하고 합칩니다</small>
      </h4>
      {queue.map((e) => (
        <button key={e.branchFileId} className="merge-queue-row" onClick={() => openMergeView(e)}>
          <span className="merge-queue-name">
            {e.title}
            {drafts.has(`${e.docId}@${e.deviceId}`) && <span className="merge-queue-draft">작업 중</span>}
          </span>
          <span className="merge-queue-meta">
            {e.mine ? '이 기기' : e.device} 브랜치 → main({e.mainDevice ?? '클라우드'}) · {formatDate(e.branchAt)}
          </span>
          <span className="merge-queue-go">
            머지 <Icon name="chevronRight" size={14} />
          </span>
        </button>
      ))}
    </section>
  )
}

type LocalChoice = 'overwrite' | 'push' | 'skip'

/**
 * 받기 미리보기 — 받기는 클라우드로 완전 동기화다. 다른 기기가 올린 변경은 그대로 받고,
 * 이 기기 변경이 있는 노트는 행마다 덮기·올리기·건너뛰기(기본 — 이 기기 내용 그대로)를 고른다. '비교'로 지금 쓴 것을 확인한다.
 */
function PullPreview({ plan, busy, onConfirm, onClose }: { plan: PullPlan; busy: boolean; onConfirm: (c: PullChoices) => void; onClose: () => void }) {
  const [choice, setChoice] = useState<Record<string, LocalChoice>>(() => Object.fromEntries(plan.local.map((d) => [d.docId, 'skip' as LocalChoice])))
  const groups = [
    { key: 'add' as const, label: '새 노트', icon: 'plus', items: plan.docs.filter((d) => d.change === 'add') },
    { key: 'remote-new' as const, label: '새 버전', icon: 'cloudDown', items: plan.docs.filter((d) => d.change === 'remote-new') }
  ].filter((g) => g.items.length > 0)
  const overwrite = plan.local.filter((d) => choice[d.docId] === 'overwrite').map((d) => d.docId)
  const push = plan.local.filter((d) => choice[d.docId] === 'push').map((d) => d.docId)
  const count = plan.docs.length + overwrite.length + push.length
  const changeText = (d: LocalChangedDoc) =>
    !d.changes
      ? '비교 기록 없음'
      : d.changes.total === 0
        ? d.sync === 'diverged'
          ? '바꾼 것 없음 · 올려 둔 이 기기 브랜치가 머지 대기에서 빠짐'
          : '바꾼 것 없음'
        : `이 기기에서 쓴 것 획 +${d.changes.added}` + (d.changes.removed ? ` · 지운 것 −${d.changes.removed}` : '') + (d.changes.modified ? ` · 고친 것 ${d.changes.modified}` : '') + (d.changes.other ? ` · 그 밖 ${d.changes.other}` : '')
  useEscClose(onClose, !busy)
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal push-modal" role="dialog" aria-label="받기 미리보기">
        <header className="push-head">
          <span className="push-count">{count}</span>
          <div>
            <h2 className="modal-title">받기 미리보기</h2>
            <p className="push-sub">
              클라우드와 똑같이 맞춥니다{plan.bytes > 0 ? ` · 최대 ${formatBytes(plan.bytes)}` : ''}
            </p>
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
                  <span className={'push-stripe ' + (g.key === 'add' ? 'add' : 'recv')} />
                  <span className="push-name">{d.title}</span>
                  {d.device && <span className="push-device">{d.device}</span>}
                  <span className="push-size">{formatBytes(d.bytes)}</span>
                  <Icon name={g.key === 'add' ? 'plus' : 'cloudDown'} size={14} className="push-ico" />
                </div>
              ))}
            </section>
          ))}
          {plan.local.length > 0 && (
            <section className="push-group">
              <h4 className="push-group-label">
                <Icon name="alert" size={13} /> 이 기기에서 바꾼 노트 <b>{plan.local.length}</b>
              </h4>
              <p className="push-note">
                기본은 건너뛰기 — 이 기기 내용을 그대로 둡니다. 덮으면 클라우드와 같아지고 지금 내용은 이 기기 스냅샷으로만 남습니다(버전 기록에서 되돌릴 수 있음). 진짜 필기라면 '올리기'를 고르세요.
              </p>
              {plan.local.map((d) => (
                <div key={d.docId} className="pull-local-row">
                  <div className="pull-local-main">
                    <span className="push-name">{d.title}</span>
                    <span className="pull-local-meta">
                      {changeText(d)}
                      {d.remoteChanged ? ' · 클라우드도 바뀜' : ''}
                    </span>
                  </div>
                  <button className="text-btn small" onClick={() => openChanges({ docId: d.docId, title: d.title, actions: [] })}>
                    비교
                  </button>
                  <Segmented
                    className="pull-local-seg"
                    label={`${d.title} 처리`}
                    value={choice[d.docId]}
                    options={[
                      ['overwrite', '덮기'],
                      ['push', '올리기'],
                      ['skip', '건너뛰기']
                    ]}
                    onChange={(v) => setChoice((c) => ({ ...c, [d.docId]: v }))}
                  />
                </div>
              ))}
            </section>
          )}
        </div>

        <div className="modal-actions">
          <span className="push-total">
            {!count && plan.local.length ? '받을 것이 없습니다 — 덮거나 올릴 노트를 고르세요' : `예상 용량 ${plan.bytes > 0 ? `약 ${formatBytes(plan.bytes)}` : '0 B'}`}
          </span>
          <button className="text-btn" onClick={onClose}>
            취소
          </button>
          <button className="primary-btn" onClick={() => onConfirm({ overwrite, push })} disabled={busy || !count}>
            <Icon name="download" size={18} /> {count}건 맞추기
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
  useEscClose(onClose)
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
