// 일정 — 할 일과 캘린더 (홈 화면, #/plan). 라이브러리·작업보드와 같은 홈 탭에서 연다.
// 왼쪽은 보기(오늘·예정·전체·완료·휴지통)와 카테고리, 가운데는 목록·주·월, 오른쪽은 고른 할 일(또는 달력에서 고른 날).
// 할 일은 이 기기 DB(storage/tasks)에 있다. 노트는 읽기만 한다 — 연결한 노트 이름, 그날 만든 노트·그날을 마지막으로 고친 노트.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUI } from '../../app/store'
import { Icon } from '../Icon'
import { Segmented } from '../Segmented'
import { useIndicator } from '../motion/useIndicator'
import type { DocumentMeta, ID, Task } from '../../shared/model'
import { assignCategoryColors, categoryColor } from '../../shared/util'
import { db } from '../../storage/db'
import { TASKS_EVENT, createTask, listTasks, setTaskDone } from '../../storage/tasks'
import { REMOTE_EVENT, onSyncStatus } from '../../sync/sync'
import { shouldCheckTasksOnOpen, syncTasks, type TaskSyncResult } from '../../sync/tasks'
import { getSync } from '../../sync/folders'
import { AuthRequiredError, SyncNotConfiguredError, login } from '../../sync/token'
import { errorText, trackActivity } from '../../shared/activity'
import { TaskDetail } from './TaskDetail'
import { MonthView, WeekView, DayPanel } from './Calendar'
import { addDays, addMonths, dueLabel, fromKey, groupTasks, inFilter, isLate, longDay, monthStart, timeLabel, todayKey, weekStart, type PlanFilter } from './planUtil'

type View = 'list' | 'week' | 'month'
const VIEW_KEY = 'inkpad.plan.view'
const FILTER_KEY = 'inkpad.plan.filter'
/** 사이드바가 서랍이 아니라 옆에 붙는 폭 — 라이브러리와 같다(06-editor.css 900px) */
const WIDE_QUERY = '(min-width: 901px)'

const load = <T,>(store: Storage, key: string, fallback: T): T => {
  try {
    const v = store.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
const save = (store: Storage, key: string, v: unknown) => {
  try {
    store.setItem(key, JSON.stringify(v))
  } catch {
    /* 저장 못 해도 화면은 그대로 */
  }
}

/** 할 일 목록 — 바뀔 때마다 다시 읽는다 */
function useTasks() {
  const [list, setList] = useState<Task[] | null>(null)
  useEffect(() => {
    let alive = true
    const read = () => void listTasks().then((l) => alive && setList(l))
    read()
    window.addEventListener(TASKS_EVENT, read)
    return () => {
      alive = false
      window.removeEventListener(TASKS_EVENT, read)
    }
  }, [])
  return list
}

/** 노트·앱·파일·폴더의 카테고리(색을 라이브러리와 같게 배정하려고)와 노트 목록 */
function useHomeData() {
  const [data, setData] = useState<{ docs: DocumentMeta[]; cats: string[] }>({ docs: [], cats: [] })
  useEffect(() => {
    let alive = true
    const read = async () => {
      const [docs, apps, files, folders] = await Promise.all([db.documents.toArray(), db.apps.toArray(), db.files.toArray(), db.folders.toArray()])
      const cats = new Set<string>()
      for (const d of docs) if (d.category) cats.add(d.category)
      for (const a of apps) if (a.category) cats.add(a.category)
      for (const f of files) if (f.category) cats.add(f.category)
      for (const f of folders) for (const c of f.categories ?? []) cats.add(c)
      if (alive) setData({ docs, cats: [...cats] })
    }
    void read()
    window.addEventListener(REMOTE_EVENT, read)
    return () => {
      alive = false
      window.removeEventListener(REMOTE_EVENT, read)
    }
  }, [])
  return data
}

/** 오늘 — 자정을 넘기면(또는 앱으로 돌아오면) 다시 센다 */
function useToday() {
  const [today, setToday] = useState(todayKey)
  useEffect(() => {
    const check = () => setToday(todayKey())
    const t = window.setInterval(check, 60_000)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])
  return today
}

/** 할 일 동기화 — 버튼과 (켰다면) 화면을 열 때 확인. 클라우드를 쓰지 않는 서버면 버튼을 숨긴다 */
function useTaskSync() {
  const toast = useUI((s) => s.toast)
  const checkOnOpen = useUI((s) => s.settings.cloudCheckOnOpen)
  const [busy, setBusy] = useState(false)
  const [cloudOff, setCloudOff] = useState(false)
  useEffect(() => onSyncStatus((s) => setCloudOff(s === 'disabled')), [])
  /** 동기화를 한 번이라도 설정했나 — 아니면 올릴 것 배지를 띄우지 않는다(올라가지 않는 게 정상이므로) */
  const [configured, setConfigured] = useState(false)
  useEffect(() => {
    void getSync('rootFolderId').then((v) => setConfigured(!!v))
  }, [busy])
  const running = useRef(false)
  const run = useCallback(
    async (quiet: boolean) => {
      if (running.current) return
      running.current = true
      setBusy(true)
      try {
        const r = await trackActivity('download', '할 일', () => syncTasks(), resultText)
        if (!quiet || r.down) toast(resultText(r))
      } catch (e) {
        if (e instanceof SyncNotConfiguredError) setCloudOff(true)
        if (quiet) return
        if (e instanceof AuthRequiredError) toast('할 일을 동기화하려면 로그인이 필요합니다.', 'error', { label: '로그인', run: login })
        else toast(errorText(e, '할 일을 동기화하지 못했습니다.'), 'error')
      } finally {
        running.current = false
        setBusy(false)
      }
    },
    [toast]
  )
  // 일정 화면을 열 때 — '앱을 열 때 클라우드 확인'을 켰을 때만, 30분에 한 번
  useEffect(() => {
    void shouldCheckTasksOnOpen(checkOnOpen).then((yes) => {
      if (yes) void run(true)
    })
  }, [checkOnOpen, run])
  return { busy, cloudOff, configured, sync: () => void run(false) }
}

const resultText = (r: TaskSyncResult) => {
  const parts = [r.down && `${r.down}개 받음`, r.up && `${r.up}개 올림`].filter(Boolean)
  return parts.length ? `할 일 ${parts.join(' · ')}` : '할 일이 최신입니다'
}

const FILTER_LABEL: Record<Exclude<PlanFilter['kind'], 'category'>, string> = { today: '오늘', upcoming: '예정', all: '전체', done: '완료', trash: '휴지통' }
const filterKey = (f: PlanFilter) => (f.kind === 'category' ? `cat:${f.name ?? ''}` : f.kind)
const filterLabel = (f: PlanFilter) => (f.kind === 'category' ? f.name ?? '미분류' : FILTER_LABEL[f.kind])

type DueChoice = 'today' | 'tomorrow' | 'none'

export function Plan() {
  const navigate = useUI((s) => s.navigate)
  const toast = useUI((s) => s.toast)
  const tasks = useTasks()
  const { docs, cats } = useHomeData()
  const today = useToday()
  const taskSync = useTaskSync()
  const pendingCount = useMemo(() => (taskSync.configured ? (tasks ?? []).filter((t) => t.pending).length : 0), [tasks, taskSync.configured])

  const [view, setViewState] = useState<View>(() => load(localStorage, VIEW_KEY, 'list'))
  const setView = (v: View) => {
    setViewState(v)
    save(localStorage, VIEW_KEY, v)
  }
  const [filter, setFilterState] = useState<PlanFilter>(() => load(sessionStorage, FILTER_KEY, { kind: 'today' }))
  const [selected, setSelected] = useState<ID | null>(null)
  /** 주·월 보기의 기준 날(월에서는 고른 날) */
  const [cursor, setCursor] = useState(today)
  /** 좁은 화면에서 달력의 고른 날 칸을 열었나 — 넓은 화면은 늘 옆에 보인다 */
  const [dayOpen, setDayOpen] = useState(false)

  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY)
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const [sideOpen, setSideOpen] = useState(() => window.matchMedia(WIDE_QUERY).matches)
  // 좁아지면(화면 나누기 등) 사이드바는 서랍이 되므로 접는다 — 펼친 채 남으면 화면을 덮는다
  useEffect(() => {
    if (!wide) setSideOpen(false)
  }, [wide])

  const pickFilter = (f: PlanFilter) => {
    setFilterState(f)
    save(sessionStorage, FILTER_KEY, f)
    setSelected(null)
    if (view !== 'list') setView('list')
    if (!wide) setSideOpen(false) // 서랍은 고르면 닫는다 — 결과를 가리지 않게
  }

  // ── 카테고리와 색 (라이브러리와 같은 배정) ──
  const live = useMemo(() => (tasks ?? []).filter((t) => !t.deletedAt), [tasks])
  const allCats = useMemo(() => {
    const s = new Set(cats)
    for (const t of tasks ?? []) if (t.category) s.add(t.category)
    return [...s].sort((a, b) => a.localeCompare(b, 'ko'))
  }, [cats, tasks])
  const colors = useMemo(() => assignCategoryColors([...allCats, ...docs.map((d) => d.category)]), [allCats, docs])
  const catColor = useCallback((c: string | null) => categoryColor(c, colors), [colors])
  /** 사이드바의 카테고리 — 안 끝낸 할 일이 있는 것만(노트에만 쓰는 카테고리로 목록이 길어지지 않게) */
  const sideCats = useMemo(() => {
    const s = new Map<string | null, number>()
    for (const t of live) if (!t.doneAt) s.set(t.category, (s.get(t.category) ?? 0) + 1)
    return [...s.entries()].sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b, 'ko')))
  }, [live])

  const count = (f: PlanFilter) => (tasks ?? []).filter((t) => inFilter(t, f, today) && (f.kind === 'today' ? !t.doneAt : true)).length
  const shown = useMemo(() => (tasks ?? []).filter((t) => inFilter(t, filter, today)), [tasks, filter, today])
  const groups = useMemo(() => groupTasks(shown, filter, today), [shown, filter, today])
  const docTitle = useMemo(() => new Map(docs.filter((d) => !d.deletedAt).map((d) => [d.id, d.title])), [docs])
  const selectedTask = (tasks ?? []).find((t) => t.id === selected) ?? null

  // ── 빠른 추가 ──
  const addRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState('')
  const defaultDue: DueChoice = filter.kind === 'today' ? 'today' : filter.kind === 'upcoming' ? 'tomorrow' : 'none'
  const [dueChoice, setDueChoice] = useState<DueChoice>(defaultDue)
  useEffect(() => setDueChoice(defaultDue), [defaultDue])
  const dueOf = (c: DueChoice) => (c === 'today' ? today : c === 'tomorrow' ? addDays(today, 1) : null)
  const add = async () => {
    const title = draft.trim()
    if (!title) return
    const t = await createTask({ title, due: dueOf(dueChoice), category: filter.kind === 'category' ? filter.name : null })
    if (t) setDraft('')
  }
  /** 새 할 일 — 목록 보기의 추가 칸으로. 칸은 목록으로 바꾼 뒤에야 생기므로 그려진 다음에 포커스한다 */
  const [focusAdd, setFocusAdd] = useState(0)
  useEffect(() => {
    if (focusAdd) addRef.current?.focus()
  }, [focusAdd])
  const startNew = () => {
    if (view !== 'list') setView('list')
    if (filter.kind === 'done' || filter.kind === 'trash') pickFilter({ kind: 'today' })
    if (!wide) setSideOpen(false)
    setFocusAdd((n) => n + 1)
  }

  // ── 사이드바 선택 인디케이터 ──
  const treeRef = useRef<HTMLElement>(null)
  useIndicator(treeRef, sideOpen && view === 'list' ? filterKey(filter) : null, 'y', `${sideCats.length}`)

  /** 노트를 연다 — 노트에서 보낸 할 일이면 그 페이지로 (편집 화면이 openAt을 쓴다) */
  const openNote = (docId: ID, pageId?: ID) => {
    useUI.setState({ openAt: pageId ? { docId, pageId } : null })
    navigate({ name: 'editor', docId })
  }
  const toggle = (t: Task) => void setTaskDone(t.id, !t.doneAt)

  const sideItems: { f: PlanFilter; icon: string }[] = [
    { f: { kind: 'today' }, icon: 'sun' },
    { f: { kind: 'upcoming' }, icon: 'calendar' },
    { f: { kind: 'all' }, icon: 'list' },
    { f: { kind: 'done' }, icon: 'checkCircle' }
  ]

  const listTitle =
    view === 'list' ? filterLabel(filter) : view === 'week' ? weekTitle(cursor) : `${fromKey(cursor).getFullYear()}년 ${fromKey(cursor).getMonth() + 1}월`
  const step = (n: number) => setCursor((c) => (view === 'week' ? addDays(c, n * 7) : addMonths(c, n)))
  const showPane = !!selectedTask || (view === 'month' && (wide || dayOpen))

  return (
    <div className={'plan' + (sideOpen ? ' has-side' : '') + (showPane ? ' has-pane' : '')}>
      <div className="plan-body">
        {sideOpen && !wide && <div className="tree-backdrop" role="presentation" onClick={() => setSideOpen(false)} />}
        {sideOpen && (
          <aside className="lib-side plan-side">
            <div className="lib-side-head">
              <span className="lib-brand">inkpad</span>
              <button className="tb-btn side-toggle" onClick={() => setSideOpen(false)} aria-label="사이드바" aria-expanded>
                <Icon name="sidebar" />
              </button>
            </div>
            <button className="primary-btn side-new" onClick={startNew}>
              새 할 일
            </button>
            <button className="side-link" onClick={() => navigate({ name: 'library' })}>
              <Icon name="back" size={16} />
              <span>라이브러리</span>
            </button>
            <nav className="folder-tree" aria-label="일정 보기" ref={treeRef}>
              {sideItems.map(({ f, icon }) => (
                <button key={f.kind} data-indicator-key={filterKey(f)} className={'tree-item' + (view === 'list' && filterKey(filter) === filterKey(f) ? ' is-active' : '')} onClick={() => pickFilter(f)}>
                  <Icon name={icon} size={18} /> {filterLabel(f)}
                  <span className="count">{tasks ? count(f) : ''}</span>
                </button>
              ))}
              {sideCats.length > 0 && <div className="tree-label">카테고리</div>}
              {sideCats.map(([c, n]) => {
                const f: PlanFilter = { kind: 'category', name: c }
                return (
                  <button key={filterKey(f)} data-indicator-key={filterKey(f)} className={'tree-item' + (view === 'list' && filterKey(filter) === filterKey(f) ? ' is-active' : '')} onClick={() => pickFilter(f)}>
                    <span className="tree-cat-dot" style={{ background: catColor(c) }} aria-hidden="true" />
                    <span className="tree-name">{c ?? '미분류'}</span>
                    <span className="count">{n}</span>
                  </button>
                )
              })}
              <button data-indicator-key="trash" className={'tree-item trash' + (view === 'list' && filter.kind === 'trash' ? ' is-active' : '')} onClick={() => pickFilter({ kind: 'trash' })}>
                <Icon name="trash" size={18} /> 휴지통 <span className="count">{tasks ? count({ kind: 'trash' }) : ''}</span>
              </button>
            </nav>
          </aside>
        )}

        <div className="plan-col">
          <header className="plan-bar">
            {(!sideOpen || !wide) && (
              <button className="tb-btn" onClick={() => setSideOpen((v) => !v)} aria-label="사이드바" aria-expanded={sideOpen}>
                <Icon name="sidebar" />
              </button>
            )}
            <span className="plan-bar-name">일정</span>
            <span className="bar-spacer" />
            {!taskSync.cloudOff && (
              <button
                className={'tb-btn sync-btn plan-sync' + (taskSync.busy ? ' is-syncing' : '')}
                onClick={taskSync.sync}
                disabled={taskSync.busy}
                aria-label={pendingCount ? `할 일 동기화 — 올릴 것 ${pendingCount}개` : '할 일 동기화'}
                title="할 일 동기화"
              >
                <Icon name="cloud" />
                {pendingCount > 0 && <span className="sync-badge">{pendingCount}</span>}
              </button>
            )}
            <Segmented
              className="plan-view-seg"
              value={view}
              options={[
                ['list', '목록'],
                ['week', '주'],
                ['month', '월']
              ]}
              onChange={(v) => {
                setView(v)
                setSelected(null)
              }}
              label="보기"
            />
            {(!sideOpen || !wide) && (
              <button className="primary-btn plan-new" onClick={startNew} aria-label="새 할 일">
                <Icon name="plus" size={16} /> <span className="plan-new-label">새 할 일</span>
              </button>
            )}
          </header>

          <div className="plan-titlebar">
            <div className="plan-title-main">
              {view === 'list' && <span className="plan-sub">{longDay(today)}</span>}
              <h1 className="plan-title">
                {listTitle}
                {view === 'list' && <span className="title-count">{filter.kind === 'today' ? count(filter) : shown.length}</span>}
              </h1>
            </div>
            {view !== 'list' && (
              <div className="plan-nav">
                <button className="plan-nav-btn" onClick={() => step(-1)} aria-label={view === 'week' ? '지난주' : '지난달'}>
                  <Icon name="back" size={16} />
                </button>
                <button className="plan-nav-btn is-text" onClick={() => setCursor(today)}>
                  오늘
                </button>
                <button className="plan-nav-btn" onClick={() => step(1)} aria-label={view === 'week' ? '다음 주' : '다음 달'}>
                  <Icon name="chevronRight" size={16} />
                </button>
              </div>
            )}
          </div>

          {view === 'list' && (
            <div className="plan-chips" role="group" aria-label="일정 보기">
              {[...sideItems.map((s) => s.f), ...sideCats.map(([c]) => ({ kind: 'category', name: c }) as PlanFilter)].map((f) => (
                <button key={filterKey(f)} className={'lib-chip' + (filterKey(filter) === filterKey(f) ? ' is-on' : '')} aria-pressed={filterKey(filter) === filterKey(f)} onClick={() => pickFilter(f)}>
                  {f.kind === 'category' && <i className="cat-dot" style={{ background: catColor(f.name) }} aria-hidden="true" />}
                  {filterLabel(f)}
                </button>
              ))}
            </div>
          )}

          <main className={'plan-main is-' + view}>
            {view === 'list' && (
              <>
                {filter.kind !== 'done' && filter.kind !== 'trash' && (
                  <form
                    className="plan-add"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void add()
                    }}
                  >
                    <Icon name="plus" size={18} />
                    <input ref={addRef} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="할 일 추가 — Enter로 넣기" aria-label="할 일 추가" enterKeyHint="done" />
                    <select value={dueChoice} onChange={(e) => setDueChoice(e.target.value as DueChoice)} aria-label="마감">
                      <option value="today">마감: 오늘</option>
                      <option value="tomorrow">마감: 내일</option>
                      <option value="none">마감 없음</option>
                    </select>
                  </form>
                )}
                {tasks && !shown.length && (
                  <div className="plan-empty">
                    <Icon name={filter.kind === 'trash' ? 'trash' : filter.kind === 'done' ? 'checkCircle' : 'todo'} size={28} />
                    <p>{filter.kind === 'trash' ? '휴지통이 비었습니다' : filter.kind === 'done' ? '끝낸 할 일이 없습니다' : filter.kind === 'today' ? '오늘 할 일이 없습니다' : '할 일이 없습니다'}</p>
                    {filter.kind === 'trash' && <small>지운 할 일은 30일 동안 여기에 있다가 사라집니다.</small>}
                  </div>
                )}
                {groups.map((g) => (
                  <section key={g.key} className="plan-group">
                    <h2 className={'plan-group-head' + (g.late ? ' is-late' : '')}>
                      {g.label} <span>{g.items.length}</span>
                    </h2>
                    {g.items.map((t) => (
                      <TaskRow key={t.id} t={t} today={today} on={t.id === selected} color={catColor(t.category)} note={t.link ? docTitle.get(t.link.docId) : undefined} onToggle={() => toggle(t)} onPick={() => setSelected(t.id === selected ? null : t.id)} />
                    ))}
                  </section>
                ))}
              </>
            )}
            {view === 'week' && <WeekView start={weekStart(cursor)} today={today} tasks={live} docs={docs} selected={selected} catColor={catColor} onPick={(id) => setSelected(id === selected ? null : id)} onToggle={toggle} onOpenNote={openNote} />}
            {view === 'month' && (
              <MonthView
                month={monthStart(cursor)}
                day={cursor}
                today={today}
                tasks={live}
                docs={docs}
                catColor={catColor}
                onPickDay={(d) => {
                  setCursor(d)
                  setSelected(null)
                  setDayOpen(true)
                }}
              />
            )}
          </main>
        </div>

        {showPane && (
          <>
            {!wide && <div className="plan-pane-backdrop" role="presentation" onClick={() => (selectedTask ? setSelected(null) : setDayOpen(false))} />}
            <aside className="plan-pane" aria-label={selectedTask ? '할 일 자세히' : longDay(cursor)}>
              {selectedTask ? (
                <TaskDetail
                  key={selectedTask.id}
                  task={selectedTask}
                  today={today}
                  categories={allCats}
                  catColor={catColor}
                  noteTitle={selectedTask.link ? docTitle.get(selectedTask.link.docId) ?? null : null}
                  onOpenNote={openNote}
                  onClose={() => setSelected(null)}
                  onTrashed={(id, title) => {
                    setSelected(null)
                    toast(`'${title}'을(를) 휴지통으로 옮겼습니다.`, 'info', { label: '되돌리기', run: () => void import('../../storage/tasks').then((m) => m.restoreTask(id)) })
                  }}
                />
              ) : (
                <DayPanel day={cursor} today={today} tasks={live} docs={docs} catColor={catColor} onPick={setSelected} onToggle={toggle} onOpenNote={openNote} onClose={wide ? undefined : () => setDayOpen(false)} />
              )}
            </aside>
          </>
        )}
      </div>

      {/* 휴대폰: 새 할 일은 화면 아래 폭 전체 (라이브러리의 새로 만들기와 같다) */}
      <button className="primary-btn plan-new-bottom" onClick={startNew}>
        <Icon name="plus" size={16} /> 새 할 일
      </button>
    </div>
  )
}

const weekTitle = (k: string) => {
  const s = weekStart(k)
  const e = addDays(s, 6)
  const a = fromKey(s)
  const b = fromKey(e)
  return `${a.getMonth() + 1}월 ${a.getDate()}일 – ${a.getMonth() === b.getMonth() ? '' : `${b.getMonth() + 1}월 `}${b.getDate()}일`
}

/** 목록의 한 줄 — 왼쪽 동그라미로 끝내기, 나머지를 누르면 자세히 */
function TaskRow({ t, today, on, color, note, onToggle, onPick }: { t: Task; today: string; on: boolean; color: string; note?: string; onToggle: () => void; onPick: () => void }) {
  const late = isLate(t, today)
  return (
    <div className={'task-row' + (on ? ' is-on' : '') + (t.doneAt ? ' is-done' : '') + (late ? ' is-late' : '')}>
      <button className="task-check" onClick={onToggle} aria-label={t.doneAt ? `${t.title} — 끝냄 취소` : `${t.title} — 끝냄`} aria-pressed={!!t.doneAt} disabled={!!t.deletedAt}>
        {t.doneAt && <Icon name="check" size={13} />}
      </button>
      <button className="task-main" onClick={onPick} aria-expanded={on}>
        <span className="task-title">{t.title}</span>
        <span className="task-meta">
          <i className="cat-dot" style={{ background: color }} aria-hidden="true" />
          <span>{t.category ?? '미분류'}</span>
          {t.due && (
            <>
              <span className="sep">·</span>
              <span className={late ? 'is-late' : ''}>{dueLabel(t.due, today)}</span>
            </>
          )}
          {t.time && <span>{timeLabel(t.time)}</span>}
          {t.link && (
            <>
              <span className="sep">·</span>
              <Icon name="notebook" size={12} />
              <span className="task-note">{note ?? '노트 없음'}</span>
            </>
          )}
        </span>
      </button>
      {t.snippet && <img className="task-snippet" src={t.snippet} alt="" aria-hidden="true" />}
    </div>
  )
}
