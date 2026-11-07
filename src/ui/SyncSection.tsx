import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
import { formatDate, formatBytes, assignCategoryColors, categoryColor } from '../shared/util'
import { confirmDialog } from '../app/dialogs'
import { Icon } from './Icon'
import { MERGE_DONE_EVENT, openMergeView } from './merge/MergeView'
import { mergeDraftKeys } from '../sync/mergeDraft'
import { openArchive } from './ArchiveSheet'
import { openChanges } from './ChangesView'
import { Segmented } from './Segmented'
import { Popover, SheetEmpty, useEscClose, useSheetHeightMotion } from './sheetParts'

function toast(text: string, kind: 'info' | 'success' | 'error' = 'success') {
  void import('../app/store').then(({ useUI }) => useUI.getState().toast(text, kind))
}

/** 카테고리 필터의 예약 키 — 실제 카테고리 이름과 겹치지 않게 */
const CAT_ALL = '__all__'
const CAT_NONE = '__none__'

/** 좁은 화면(휴대폰) — 최신 그룹을 접어 두고, 카테고리 고르기를 아래 시트로 연다 */
const isNarrow = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 600px)').matches

// ───────────────── 클라우드 노트 목록 ─────────────────

type GroupKey = 'split' | 'recv' | 'push' | 'fresh' | 'gone'
type RowAction = 'download' | 'pushOne' | 'repush' | 'restore' | 'merge' | null
/** 상태별 보기 — 전체 · 처리 필요(갈라짐·받을 것·올릴 것) · 최신 */
type ViewFilter = 'all' | 'todo' | 'fresh'

/**
 * 행 표시의 단일 출처 — 배지·그룹과 행의 주 동작까지 데이터로 둔다.
 * action이 있는 행만 오른쪽에 주 동작 버튼을 렌더한다 — 숨은 "행 탭 = 즉시 실행"은 없다.
 * pending/new의 올리기는 onPush()(전체 미리보기)가 아니라 pushOneNote로 그 노트만 올린다.
 */
const STATE_META: Record<CloudNoteState, { group: GroupKey; badge: string; action: RowAction }> = {
  'remote-new': { group: 'recv', badge: '새 버전', action: 'download' },
  new: { group: 'push', badge: '새 파일', action: 'pushOne' },
  pending: { group: 'push', badge: '변경됨', action: 'pushOne' },
  // 갈라짐 — 이 기기 변경은 이 기기 브랜치에 올라가 있다. 받기로 덮지 않고, 머지 화면에서 합친다
  diverged: { group: 'split', badge: '갈라짐', action: 'merge' },
  'cloud-deleted': { group: 'push', badge: '클라우드에 없음', action: 'repush' },
  same: { group: 'fresh', badge: '최신', action: null },
  'deleted-local': { group: 'gone', badge: '이 기기에서 삭제', action: 'restore' }
}

/** 행 주 동작 버튼의 문구 */
const ACTION_LABEL: Record<Exclude<RowAction, null>, string> = {
  download: '받기',
  pushOne: '올리기',
  repush: '다시 올리기',
  restore: '되살리기',
  merge: '머지'
}

/** 행 주 동작 버튼의 아이콘 — 받기는 아래, 올리기는 위. 글자를 읽기 전에 방향이 보이게 */
const ACTION_ICON: Record<Exclude<RowAction, null>, string> = {
  download: 'download',
  pushOne: 'upload',
  repush: 'upload',
  restore: 'restore',
  merge: 'swap'
}

/**
 * 목록 그룹 — 처리할 것(머지 필요 → 받을 것 → 올릴 것)이 먼저, 최신·이 기기에서 삭제됨은 뒤에.
 * 같은 노트를 두 번 보이지 않는다 — 머지할 것(다른 기기 브랜치 포함)은 「머지 필요」 그룹 하나에 모은다.
 */
const GROUPS: { key: GroupKey; title: string; desc?: string; todo: boolean; collapsible: boolean }[] = [
  { key: 'split', title: '머지 필요', desc: '두 기기가 각각 고친 노트', todo: true, collapsible: false },
  { key: 'recv', title: '받을 것', todo: true, collapsible: false },
  { key: 'push', title: '올릴 것', todo: true, collapsible: false },
  { key: 'fresh', title: '최신', todo: false, collapsible: true },
  { key: 'gone', title: '이 기기에서 삭제됨', todo: false, collapsible: true }
]

/** 건수는 한 곳에서 계산해 머리 카드·버튼·그룹 머리가 나눠 쓴다 */
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

/** 머지할 것 중 클라우드 목록의 갈라짐 행에 묶이지 않는 것 — 다른 기기 브랜치 등. 「머지 필요」 그룹에 따로 행을 낸다 */
function extraMerges(cloud: CloudNoteInfo[] | null, queue: MergeQueueEntry[]): MergeQueueEntry[] {
  const split = new Set((cloud ?? []).filter((n) => n.state === 'diverged').map((n) => n.docId))
  return queue.filter((e) => !split.has(e.docId))
}

/** 목록 로딩 중 — 같은 골격의 스켈레톤 */
function CloudSkeleton() {
  return (
    <div className="cloud-items">
      {[0, 1, 2].map((i) => (
        <div key={i} className="cloud-skel">
          <span className="bar t" />
          <span className="bar m" />
          <span className="bar s" />
        </div>
      ))}
    </div>
  )
}

function CloudRow({
  c,
  busy,
  busyId,
  draft,
  onPrimary,
  onDelete,
  onExclude,
  onAlign
}: {
  c: CloudNoteInfo
  busy: boolean
  busyId: string | null
  draft: boolean
  onPrimary: (info: CloudNoteInfo) => void
  onDelete: (info: CloudNoteInfo) => void
  onExclude: (info: CloudNoteInfo) => void
  onAlign: (info: CloudNoteInfo) => void
}) {
  const [openMenu, setOpenMenu] = useState(false)
  const m = STATE_META[c.state]
  const rowBusy = busyId === c.docId
  const act = m.action
  const compact = m.group === 'fresh'
  const split = m.group === 'split'
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
    <div className={'cloud-row g-' + m.group + (compact ? ' compact' : '') + (split ? ' merge-queue-row' : '')}>
      {!compact && (
        <span className="cloud-ico" aria-hidden="true">
          <Icon name="file" size={16} />
        </span>
      )}
      {compact && <Icon name="check" size={16} className="cloud-ok" />}
      <div className="cloud-body">
        <div className="cloud-name">
          {c.title}
          {draft && <span className="cloud-draft">작업 중</span>}
        </div>
        <div className="cloud-meta">
          {!compact && (
            <span className="bdg" title={split ? '이 기기 변경은 브랜치에 안전하게 보관됨' : undefined}>
              {m.badge}
            </span>
          )}
          {split && (
            <span>
              <span className="wide-only">이 기기 </span>↔ {c.device || '클라우드'}
            </span>
          )}
          {!split && c.category && <span>{c.category}</span>}
          {!split && c.device && <span className="dev">{c.device}</span>}
          <span>{formatDate(c.updatedAt)}</span>
          {c.state === 'cloud-deleted' && <span className="note">일괄 올리기에서 제외</span>}
        </div>
      </div>

      {act && (
        <button className={'cloud-act-main' + (split ? ' strong' : '')} disabled={busy || rowBusy} onClick={() => onPrimary(c)}>
          {rowBusy ? <span className="spinner sm" /> : <Icon name={ACTION_ICON[act]} size={15} />}
          <span>{rowBusy ? '처리 중' : ACTION_LABEL[act]}</span>
        </button>
      )}

      <button className="cloud-more" aria-label="더보기" aria-expanded={openMenu} disabled={busy} onClick={() => setOpenMenu((v) => !v)}>
        <Icon name="more" size={18} />
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

/** 클라우드 목록의 갈라짐 행에 묶이지 않는 머지할 것(다른 기기 브랜치 등) — 「머지 필요」 그룹의 행 */
function MergeExtraRow({ e, draft }: { e: MergeQueueEntry; draft: boolean }) {
  return (
    <div className="cloud-row g-split merge-queue-row">
      <span className="cloud-ico" aria-hidden="true">
        <Icon name="file" size={16} />
      </span>
      <div className="cloud-body">
        <div className="cloud-name">
          {e.title}
          {draft && <span className="cloud-draft">작업 중</span>}
        </div>
        <div className="cloud-meta">
          <span className="bdg">갈라짐</span>
          <span>
            {e.mine ? '이 기기' : e.device} 브랜치 → main({e.mainDevice ?? '클라우드'})
          </span>
          <span>{formatDate(e.branchAt)}</span>
        </div>
      </div>
      <button className="cloud-act-main strong" onClick={() => openMergeView(e)}>
        <Icon name={ACTION_ICON.merge} size={15} />
        <span>{ACTION_LABEL.merge}</span>
      </button>
    </div>
  )
}

/**
 * 카테고리 고르기 — 카테고리가 2개 이상일 때만 목록 도구 줄에 붙는다.
 * 항목마다 처리할 건수를 보여 어느 카테고리부터 볼지 알게 한다.
 * 목록은 공용 Popover로 body에 띄운다 — 시트(overflow: hidden)·스크롤 칸 안에서 잘리지 않게. 좁은 화면에서는 아래 시트(CSS)
 */
function CategorySelect({
  cats,
  value,
  total,
  onChange
}: {
  cats: { key: string; name: string; count: number; todo: number; color: string }[]
  value: string
  total: number
  onChange: (key: string) => void
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const cur = cats.find((c) => c.key === value)
  const close = useCallback(() => setAnchor(null), [])
  const pick = (k: string) => {
    onChange(k)
    close()
  }
  return (
    <>
      <button
        className={'cloud-cat-btn' + (cur ? ' on' : '')}
        data-pop-anchor
        aria-haspopup="listbox"
        aria-expanded={!!anchor}
        aria-label={cur ? `카테고리: ${cur.name}` : '카테고리 고르기'}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
      >
        {cur && <i className="dot" style={{ background: cur.color }} />}
        <span>{cur ? cur.name : '카테고리'}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      <Popover anchor={anchor} onClose={close} className="cloud-cat-pop">
        <div className="cloud-cat-menu" role="listbox" aria-label="카테고리">
          <b className="cloud-cat-title">카테고리</b>
          <button role="option" aria-selected={!cur} className={!cur ? 'on' : ''} onClick={() => pick(CAT_ALL)}>
            <span className="nm">모든 카테고리</span>
            <span className="n">{total}</span>
          </button>
          <div className="sep" aria-hidden="true" />
          {cats.map((c) => (
            <button key={c.key} role="option" aria-selected={c.key === value} className={c.key === value ? 'on' : ''} onClick={() => pick(c.key)}>
              <i className="dot" style={{ background: c.color }} />
              <span className="nm">{c.name}</span>
              {c.todo > 0 && <span className="todo">처리 {c.todo}</span>}
              <span className="n">{c.count}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}

function CloudList({
  cloud,
  queue,
  drafts,
  counts,
  busy,
  busyId,
  focus,
  onFocus,
  onPrimary,
  onDelete,
  onExclude,
  onAlign,
  onPullAll,
  onPullCategory,
  onPushPreview
}: {
  cloud: CloudNoteInfo[] | null
  queue: MergeQueueEntry[]
  drafts: Set<string>
  counts: CloudCounts
  busy: boolean
  busyId: string | null
  /** 머리 띠의 숫자 타일로 고른 그룹 — 그 그룹만 보인다 (null = 고르지 않음) */
  focus: GroupKey | null
  onFocus: (g: GroupKey | null) => void
  onPrimary: (info: CloudNoteInfo) => void
  onDelete: (info: CloudNoteInfo) => void
  onExclude: (info: CloudNoteInfo) => void
  onAlign: (info: CloudNoteInfo) => void
  onPullAll: () => void
  onPullCategory: (cat: string | null) => void
  onPushPreview: () => void
}) {
  const [query, setQuery] = useState('')
  const [view, setView] = useState<ViewFilter>('all')
  const [catFilter, setCatFilter] = useState<string>(CAT_ALL)
  // 최신은 많으면(또는 휴대폰에서는) 접어 둔다 — 처리할 것이 먼저 보이게
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => ({ fresh: isNarrow(), gone: true }))
  const [freshAuto, setFreshAuto] = useState(false)
  useEffect(() => {
    if (freshAuto || !cloud) return
    setFreshAuto(true)
    if (counts.fresh > 5) setCollapsed((m) => ({ ...m, fresh: true }))
  }, [cloud, counts.fresh, freshAuto])

  const extra = useMemo(() => extraMerges(cloud, queue), [cloud, queue])
  const mineDraft = (docId: string) => [...drafts].some((k) => k.startsWith(docId + '@'))

  // 카테고리 목록 — 클라우드 노트의 category (없으면 미분류). 가나다순, 미분류는 맨 뒤. 처리할 건수도 함께
  const cats = useMemo(() => {
    const m = new Map<string, { count: number; todo: number }>()
    for (const n of cloud ?? []) {
      const k = n.category || CAT_NONE
      const v = m.get(k) ?? { count: 0, todo: 0 }
      v.count++
      if (GROUPS.find((g) => g.key === STATE_META[n.state].group)?.todo) v.todo++
      m.set(k, v)
    }
    // 색은 라이브러리·일정과 같은 배정 규칙(assignCategoryColors) — 목록 전체를 보고 겹치지 않게 고른다
    const names = [...m.keys()].filter((k) => k !== CAT_NONE)
    const colors = assignCategoryColors(names)
    const out = names
      .sort((a, b) => a.localeCompare(b, 'ko'))
      .map((k) => ({ key: k, name: k, color: categoryColor(k, colors), ...m.get(k)! }))
    if (m.has(CAT_NONE)) out.push({ key: CAT_NONE, name: '미분류', color: categoryColor(null), ...m.get(CAT_NONE)! })
    return out
  }, [cloud])
  // 고른 카테고리가 목록에서 사라지면(마지막 노트를 지웠다 등) 필터를 푼다
  const catValue = cats.some((c) => c.key === catFilter) ? catFilter : CAT_ALL

  const q = query.trim().toLowerCase()
  const inCat = (n: CloudNoteInfo) => catValue === CAT_ALL || (n.category || CAT_NONE) === catValue
  const inQuery = (text: string) => !q || text.toLowerCase().includes(q)
  const inView = (g: GroupKey) => (focus ? g === focus : view === 'all' || (view === 'todo' ? g === 'split' || g === 'recv' || g === 'push' : g === 'fresh'))
  const visible = (cloud ?? []).filter((n) => inView(STATE_META[n.state].group) && inCat(n) && inQuery(`${n.title} ${n.category ?? ''} ${n.device ?? ''}`))
  // 머지할 것(다른 기기 브랜치)은 카테고리를 모른다 — 카테고리를 고르지 않았을 때만 보인다
  const visibleExtra = extra.filter(() => catValue === CAT_ALL && inView('split')).filter((e) => inQuery(`${e.title} ${e.device ?? ''}`))

  // 아직 못 받아 온 상태 — 빈 공간 대신 같은 골격의 스켈레톤
  if (cloud === null) {
    return (
      <section className="cloud-panel" aria-label="클라우드 노트">
        <CloudSkeleton />
      </section>
    )
  }

  if (!cloud.length && !extra.length) {
    return (
      <section className="cloud-panel" aria-label="클라우드 노트">
        {/* 빈 상태는 앱 전체 공용 모양(SheetEmpty) */}
        <div className="cloud-empty">
          <SheetEmpty icon="cloud" title="클라우드에 노트가 없습니다" desc="노트를 만든 뒤 위의 「지금 동기화」를 눌러 주세요." />
        </div>
      </section>
    )
  }

  // 보기 칸의 건수는 고른 카테고리 안에서 센다 — 머리의 「수학 3 / 전체 8」과 맞게
  const catCounts = catValue === CAT_ALL ? counts : countCloud(cloud.filter(inCat))
  const catExtra = catValue === CAT_ALL ? extra.length : 0
  const groups = GROUPS.map((g) => ({ ...g, items: visible.filter((n) => STATE_META[n.state].group === g.key), extra: g.key === 'split' ? visibleExtra : [] })).filter(
    (g) => g.items.length + g.extra.length > 0
  )
  const catName = cats.find((c) => c.key === catValue)?.name ?? ''
  const recvCatCount = cloud.filter((n) => n.state === 'remote-new' && inCat(n)).length
  const reset = () => {
    setView('all')
    setCatFilter(CAT_ALL)
    setQuery('')
    onFocus(null)
  }

  return (
    <section className="cloud-panel" aria-label="클라우드 노트">
      <div className="cloud-toolbar">
        <label className="cloud-search">
          <Icon name="search" size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="노트 검색" aria-label="클라우드 노트 검색" />
          {query && (
            <button className="cloud-clear" aria-label="검색어 지우기" onClick={() => setQuery('')}>
              <Icon name="close" size={12} />
            </button>
          )}
        </label>
        <Segmented
          className="cloud-view"
          label="상태별 보기"
          value={focus ? 'todo' : view}
          options={[
            ['all', `전체 ${catCounts.split + catCounts.recv + catCounts.push + catCounts.fresh + catCounts.gone + catExtra}`],
            ['todo', `처리 필요 ${catCounts.split + catCounts.recv + catCounts.push + catExtra}`],
            ['fresh', `최신 ${catCounts.fresh}`]
          ]}
          onChange={(v) => {
            setView(v)
            onFocus(null) // 보기를 직접 고르면 숫자 타일 필터는 푼다
          }}
        />
        {/* 카테고리가 2개 이상일 때만 — 하나뿐이면 고를 것이 없다 */}
        {cats.length >= 2 && <CategorySelect cats={cats} value={catValue} total={cloud.length} onChange={setCatFilter} />}
      </div>

      {groups.length === 0 && (
        <div className="cloud-empty">
          <SheetEmpty
            icon="search"
            title={(view === 'todo' || focus) && !q && catValue === CAT_ALL ? '처리할 노트가 없습니다' : '조건에 맞는 노트가 없습니다'}
            action={
              <button className="text-btn small" onClick={reset}>
                필터·검색 지우기
              </button>
            }
          />
        </div>
      )}

      {groups.map((g) => {
        // 보기를 골랐거나 검색 중이면 접힌 그룹도 자동으로 펼친다
        const isOpen = !g.collapsible || view !== 'all' || !!focus || !!q || !collapsed[g.key]
        const n = g.items.length + g.extra.length
        return (
          <section className={'cloud-group g-' + g.key + (g.collapsible ? ' is-fold' : '') + (isOpen ? ' is-open' : '')} key={g.key} aria-label={g.title}>
            <div className="cloud-ghead">
              {g.collapsible ? (
                <button className="cloud-gtoggle" onClick={() => setCollapsed((m) => ({ ...m, [g.key]: !m[g.key] }))} aria-expanded={isOpen}>
                  <span>{g.title}</span>
                  <b>{n}</b>
                  <small>{isOpen ? '접기' : '펼치기'}</small>
                  <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} />
                </button>
              ) : (
                <h4 className="cloud-gtitle" title={g.desc}>
                  <span>{g.title}</span>
                  <b>{n}</b>
                </h4>
              )}
              {!g.collapsible && <span className="cloud-gline" aria-hidden="true" />}
              {/* 그룹 자리에서 바로 처리하는 일괄 동작 */}
              {g.key === 'recv' &&
                (catValue === CAT_ALL ? (
                  <button className="cloud-bulk" disabled={busy} onClick={onPullAll}>
                    모두 받기
                  </button>
                ) : (
                  <button
                    className="cloud-bulk"
                    disabled={busy || recvCatCount === 0}
                    onClick={() => onPullCategory(catValue === CAT_NONE ? null : catValue)}
                    title={`${catName} 카테고리의 받을 것을 한 번에 내려받습니다`}
                  >
                    {catName} {recvCatCount}개 받기
                  </button>
                ))}
              {g.key === 'push' && counts.bulkPush > 0 && (
                <button className="cloud-link" disabled={busy} onClick={onPushPreview}>
                  미리보기
                </button>
              )}
            </div>

            {isOpen && (
              <div className="cloud-items">
                {g.items.map((c) => (
                  <CloudRow
                    key={c.docId}
                    c={c}
                    busy={busy}
                    busyId={busyId}
                    draft={g.key === 'split' && mineDraft(c.docId)}
                    onPrimary={onPrimary}
                    onDelete={onDelete}
                    onExclude={onExclude}
                    onAlign={onAlign}
                  />
                ))}
                {g.extra.map((e) => (
                  <MergeExtraRow key={e.branchFileId} e={e} draft={drafts.has(`${e.docId}@${e.deviceId}`)} />
                ))}
              </div>
            )}
          </section>
        )
      })}
    </section>
  )
}

// ───────────────── 섹션 ─────────────────

/**
 * 머리 카드 — 상태의 단일 출처. 제목은 「지금 무엇을 해야 하나」, 버튼은 그 상태에서 할 수 있는 단 하나의 일.
 * 색은 아이콘 칸에만 쓴다 — 오프라인은 회색, 오류만 빨강.
 */
type HeroTone = 'idle' | 'todo' | 'syncing' | 'offline' | 'error' | 'wait'

function SyncHero({
  tone,
  icon,
  title,
  sub,
  progress,
  aside,
  stats,
  children
}: {
  tone: HeroTone
  icon: string | null
  title: string
  sub: string
  progress?: number | null // 0–1, null = 끝을 모름, undefined = 막대 없음
  aside?: ReactNode // 머리 줄 오른쪽 — 다시 확인 아이콘 버튼
  stats?: ReactNode // 처리할 것이 있을 때 — 숫자 타일 줄. 있으면 머리는 작은 알약 + 마지막 동기화 한 줄로 줄인다
  children?: ReactNode
}) {
  return (
    <div className={'sync-hero sync-status tone-' + tone + (tone === 'wait' ? ' sync-wait' : '') + (stats ? ' has-stats' : '')}>
      <div className="sync-hero-head" role="status" aria-live="polite">
        {stats ? (
          <span className="sync-status-txt">
            <span className="sync-pill">{title}</span>
            <small>{sub}</small>
          </span>
        ) : (
          <>
            <span className="sync-status-ic" aria-hidden="true">
              {icon ? <Icon name={icon} size={17} /> : <span className="spinner" />}
            </span>
            <span className="sync-status-txt">
              <b>{title}</b>
              <small>{sub}</small>
            </span>
          </>
        )}
        {aside}
      </div>
      {stats}
      {progress !== undefined && (
        <div className="bar sync-hero-bar" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress == null ? undefined : Math.round(progress * 100)}>
          {progress == null ? <i className="indet" /> : <i style={{ width: `${Math.min(100, progress * 100)}%` }} />}
        </div>
      )}
      {children && <div className="sync-cta">{children}</div>}
    </div>
  )
}

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
  const [focus, setFocus] = useState<GroupKey | null>(null) // 숫자 타일로 고른 그룹 — 목록을 그 그룹만 보이게 거른다

  // 창 밖(편집 화면의 노트 칩, 다른 탭 등)에서 시작한 올리기·받기가 잠금을 쥐고 있으면 끝나기를 기다린다.
  // 그 사이 목록은 반쯤 바뀐 상태라 믿을 수 없고, 받기·올리기를 눌러도 잠금에 막힌다 — 목록은 흐리게 두고 누를 수 없게 한다.
  // 끝나면 목록을 새로 읽는다. 이 창이 한 일이 쥔 잠금은 기다리지 않는다. 잠금 목록만 보므로 네트워크는 쓰지 않는다
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

  /** 갈라진 노트의 '머지하기' — 이 기기 브랜치(없으면 그 노트의 다른 브랜치)를 머지 화면으로 연다 */
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
      <section className="panel-section sync-sec" id="sync-settings">
        {status === 'auth-required' ? (
          <SyncHero tone="offline" icon="lock" title="Google로 로그인하세요" sub="기기 사이에서 노트를 주고받습니다">
            <button className="sync-go" data-act="login" onClick={() => login()}>
              Google로 로그인
            </button>
          </SyncHero>
        ) : (
          <SyncHero tone="offline" icon="cloud" title="서버 미설정" sub="서버에 OAuth 설정이 없습니다. 로컬 저장은 계속 동작합니다." />
        )}
      </section>
    )
  }

  const extraN = extraMerges(cloud, queue).length
  const mergeN = counts.split + extraN
  const todoN = counts.push + counts.recv + mergeN
  const lastText = last ? `마지막 동기화 ${formatDate(last)}${device ? ` · ${device}` : ''}` : '아직 동기화 전'
  const busyAll = status === 'syncing' || status === 'offline' || !!pullCat || selfBusy
  // 고른 그룹이 다 처리돼 비면 필터를 저절로 푼다
  const focusOn = focus && (focus === 'split' ? mergeN : counts[focus]) > 0 ? focus : null

  // 머리 카드 — 상태마다 제목·설명·버튼을 하나로 정한다
  let hero: ReactNode
  if (outside) {
    hero = <SyncHero tone="wait" icon={null} title="다른 곳에서 동기화 중" sub="노트 칩이나 다른 탭에서 시작한 올리기·받기가 끝나면 목록을 새로 읽습니다" />
  } else if (status === 'syncing') {
    const t = prog ? `${prog.phase === 'push' ? '올리는' : '받는'} 중 · ${prog.done}/${prog.total}` : '동기화 중…'
    hero = <SyncHero tone="syncing" icon={null} title={t} sub="Drive와 맞추는 중 · 창을 닫아도 계속됩니다" progress={prog && prog.total ? prog.done / prog.total : null} />
  } else if (status === 'offline') {
    hero = (
      <SyncHero
        tone="offline"
        icon="wifiOff"
        title="오프라인"
        sub={'필기는 이 기기에 계속 저장됩니다' + (counts.bulkPush ? ` · 올릴 것 ${counts.bulkPush} — 연결되면 올릴 수 있습니다` : '')}
      />
    )
  } else if (status === 'error') {
    hero = (
      <SyncHero tone="error" icon="alert" title="동기화하지 못했습니다" sub="Drive 응답을 받지 못했습니다">
        <button className="sync-go" data-act="retry" onClick={() => void syncNow()}>
          다시 시도
        </button>
      </SyncHero>
    )
  } else {
    // 주 버튼 하나 — 올릴 것이 있으면 올리고 받기(미리보기), 받을 것만 있으면 받기, 없으면 다시 확인(머리 줄 아이콘)
    const act = counts.bulkPush > 0 ? 'push' : counts.recv > 0 ? 'pull' : 'check'
    const refresh = (extra: { [k: string]: string | number }, cls: string) => (
      <button
        className={cls + (loading ? ' spinning' : '')}
        {...extra}
        disabled={busyAll || loading}
        onClick={() => void loadCloud()}
        aria-label="다시 확인"
        title={checked ? `다시 확인 · ${checked}` : '다시 확인'}
      >
        <Icon name="replace" size={18} />
      </button>
    )
    // 숫자 타일 — 누르면 목록이 그 그룹만 보인다. 한 번 더 누르면 푼다
    const tiles: { key: GroupKey; label: string; n: number }[] = [
      { key: 'split', label: '머지 필요', n: mergeN },
      { key: 'recv', label: '받을 것', n: counts.recv },
      { key: 'push', label: '올릴 것', n: counts.push }
    ]
    hero = (
      <SyncHero
        tone={todoN ? 'todo' : 'idle'}
        icon={todoN ? 'swap' : 'checkCircle'}
        title={cloud === null ? '클라우드 확인 중…' : todoN ? `${todoN}개 확인` : '모두 최신입니다'}
        sub={lastText}
        aside={
          act === 'check' ? (
            // 처리할 것이 없을 때의 유일한 동작 — 버튼 줄(.sync-cta) 자리를 머리 줄 오른쪽 아이콘으로 옮긴다
            <div className="sync-cta inline">{refresh({ 'data-act': 'check', 'data-push': 0 }, 'cloud-icon-btn sync-refresh')}</div>
          ) : (
            refresh({}, 'cloud-icon-btn sync-refresh')
          )
        }
        stats={
          todoN > 0 ? (
            <div className="sync-tiles" role="group" aria-label="처리할 것만 보기">
              {tiles.map((t) => (
                <button
                  key={t.key}
                  className={'sync-tile' + (focusOn === t.key ? ' on' : '')}
                  aria-pressed={focusOn === t.key}
                  disabled={!t.n}
                  onClick={() => setFocus(focusOn === t.key ? null : t.key)}
                >
                  <b>{t.n}</b>
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          ) : undefined
        }
      >
        {act === 'push' && (
          <>
            <button className="sync-go" data-act="push" data-push={counts.bulkPush} disabled={busyAll} onClick={() => void doPush()}>
              <Icon name="swap" size={16} />
              <span>
                지금 동기화 · {counts.bulkPush}건<span className="wide-only"> 올리고 받기</span>
              </span>
            </button>
            <button className="sync-sub" disabled={busyAll} onClick={() => void doPull()}>
              <Icon name="download" size={16} /> 받기만
            </button>
          </>
        )}
        {act === 'pull' && (
          <button className="sync-go" data-act="pull" data-push={0} disabled={busyAll} onClick={() => void doPull()}>
            <Icon name="download" size={16} /> {counts.recv}건 받기
          </button>
        )}
      </SyncHero>
    )
  }

  return (
    <section className="panel-section sync-sec" id="sync-settings">
      {/* 제목은 감싼 시트·패널 머리('동기화')가 맡는다 — 같은 말을 두 번 쓰지 않는다 */}
      {hero}

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

      {/* 창 밖의 동기화를 기다리는 동안 — 목록은 흐리게 두고 누를 수 없게 한다 */}
      <div className={'sync-body' + (outside ? ' dim' : '')} inert={outside ? true : undefined}>
        <CloudList
          cloud={cloud}
          queue={queue}
          drafts={drafts}
          counts={counts}
          busy={loading || status === 'syncing' || !!pullCat}
          busyId={busyId}
          focus={focusOn}
          onFocus={setFocus}
          onPrimary={onPrimary}
          onDelete={(c) => void deleteOne(c)}
          onExclude={(c) => void excludeOne(c)}
          onAlign={(c) => void alignOne(c)}
          onPullAll={() => void doPull()}
          onPullCategory={(c) => void pullCategory(c)}
          onPushPreview={() => void doPush()}
        />

        {/* 이 기기 · 계정 · 데이터 설정 — 창 바닥 한 줄 */}
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
      </div>

      {preview && <PushPreview plan={preview} pull={pullPlan} busy={status === 'syncing'} onConfirm={() => void confirmPush()} onClose={() => setPreview(null)} />}
      {pullPreview && <PullPreview plan={pullPreview} busy={status === 'syncing'} onConfirm={(c) => void confirmPull(c)} onClose={() => setPullPreview(null)} />}
    </section>
  )
}

/** 이 기기 · 계정 · 데이터 설정 줄 — 「이름 변경」을 눌러 기기 이름을 고친다 */
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
    // 이 기기 · 계정 · 데이터 설정 — 창 바닥에 붙는 한 줄 (휴대폰에서는 목록 끝)
    <div className="sync-foot">
      {editing ? (
        <div className="sync-foot-edit">
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
        </div>
      ) : (
        <>
          <span className="sync-foot-item" title="이 기기">
            <span className="v">{device || '이름 없음'}</span>
            <button
              className="sync-link"
              onClick={() => {
                setName('')
                setEditing(true)
              }}
            >
              이름 변경
            </button>
          </span>
          <span className="sync-foot-item" title="동기화 계정">
            <Icon name="cloud" size={15} />
            <span className="v">Google Drive</span>
            <button className="sync-link muted" onClick={onLogout}>
              로그아웃
            </button>
          </span>
          {/* 데이터 설정 — 기기 브랜치·옛 백업·스냅샷·자동 고정 정리(보관함) */}
          <button className="sync-foot-item cloud-archive-btn" onClick={openArchive} title="브랜치 · 옛 백업 · 스냅샷">
            <Icon name="files" size={15} />
            <span className="v">데이터 설정</span>
          </button>
        </>
      )}
    </div>
  )
}

/**
 * 도움말 — 시트 머리의 제목 바로 옆. 동기화 창 전체에 대한 설명이라 머리 카드(지금 상태)가 아니라 창 제목에 붙인다.
 * 누르면 말풍선(공용 Popover)으로 연다
 */
function SyncHelp() {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const close = useCallback(() => setAnchor(null), [])
  return (
    <>
      <button
        className="sync-help-btn"
        data-pop-anchor
        aria-label="동기화 도움말"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
      >
        <Icon name="help" size={16} />
      </button>
      <Popover anchor={anchor} onClose={close} className="sync-help-pop" align="start">
        <div className="sync-help-body">
          <b>무엇이 주고받아지나요?</b>
          <p>「지금 동기화」는 이 기기에서 바꾼 노트를 올리고, 다른 기기가 올린 노트를 받습니다. 「받기만」은 받기만 합니다.</p>
          <p>앱·기타 파일·보드 프리셋은 노트와 따로 — 추가하거나 고칠 때 그 항목만 바로 올라가고, 못 올린 것은 각 메뉴에서 다시 올립니다.</p>
          <p>두 기기가 같은 노트를 각각 고치면 덮지 않고 「머지 필요」에 둡니다. 「머지」로 직접 합칩니다.</p>
        </div>
      </Popover>
    </>
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
      <header className="panel-header sync-head">
        <h2>동기화</h2>
        <SyncHelp />
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
  const sheetRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  useSheetHeightMotion(sheetRef, bodyRef)
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet sync-sheet" role="dialog" aria-label="동기화" ref={sheetRef}>
        <header className="sheet-header sync-head">
          <h2>동기화</h2>
          <SyncHelp />
            <button className="tb-btn" onClick={onClose} aria-label="닫기">
            <Icon name="close" />
          </button>
        </header>
        <div className="sheet-scroll">
          <div ref={bodyRef}>
            <SyncSection />
          </div>
        </div>
      </div>
    </div>
  )
}
