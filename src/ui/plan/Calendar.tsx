// 일정 화면의 주·월 보기와 고른 날 칸 — 마감이 있는 할 일과 그날 고친 노트를 날짜에 놓는다.
import { useLayoutEffect, useMemo, useRef } from 'react'
import { Icon } from '../Icon'
import type { DocumentMeta, ID, Task } from '../../shared/model'
import { addDays, dayKey, fromKey, isLate, longDay, monthCells, timeLabel, weekdayOf } from './planUtil'

type Common = {
  today: string
  tasks: Task[]
  docs: DocumentMeta[]
  catColor: (c: string | null) => string
}

/** 날짜 → 그날 마감인 할 일 (시각 순, 끝낸 것은 아래로) */
function tasksByDay(tasks: Task[]) {
  const m = new Map<string, Task[]>()
  for (const t of tasks) {
    if (!t.due) continue
    if (!m.has(t.due)) m.set(t.due, [])
    m.get(t.due)!.push(t)
  }
  for (const list of m.values())
    list.sort((a, b) => Number(!!a.doneAt) - Number(!!b.doneAt) || (a.time ?? '99').localeCompare(b.time ?? '99') || a.createdAt - b.createdAt)
  return m
}
/** 그날의 노트 — 만든 노트, 그날을 마지막으로 고친 노트(그날 만든 것은 빼고) */
interface DayNotes {
  made: DocumentMeta[]
  last: DocumentMeta[]
}
const noteCount = (n: DayNotes | undefined) => (n ? n.made.length + n.last.length : 0)

/**
 * 날짜 → 그날 만든 노트와 그날을 마지막으로 고친 노트 (지운 노트 제외, 최근 것 먼저).
 * 노트는 만든 날과 마지막으로 고친 날만 남는다 — 25일에 고친 노트를 26일에 또 고치면 25일에서는 빠지고 26일로 옮겨 간다.
 */
function notesByDay(docs: DocumentMeta[]) {
  const m = new Map<string, DayNotes>()
  const at = (k: string) => {
    if (!m.has(k)) m.set(k, { made: [], last: [] })
    return m.get(k)!
  }
  for (const d of docs) {
    if (d.deletedAt) continue
    const made = dayKey(new Date(d.createdAt))
    const last = dayKey(new Date(d.updatedAt))
    at(made).made.push(d)
    if (last !== made) at(last).last.push(d)
  }
  for (const n of m.values()) for (const list of [n.made, n.last]) list.sort((a, b) => b.updatedAt - a.updatedAt)
  return m
}

/** 작은 할 일 칩(주·월) */
function TaskChip({ t, today, color, on, onPick, onToggle }: { t: Task; today: string; color: string; on?: boolean; onPick: () => void; onToggle?: () => void }) {
  const late = isLate(t, today)
  return (
    <div className={'cal-task' + (t.doneAt ? ' is-done' : '') + (late ? ' is-late' : '') + (on ? ' is-on' : '')} style={{ '--cat': color } as React.CSSProperties}>
      {onToggle && (
        <button className="cal-check" onClick={onToggle} aria-label={t.doneAt ? `${t.title} — 끝냄 취소` : `${t.title} — 끝냄`} aria-pressed={!!t.doneAt} />
      )}
      <button className="cal-task-main" onClick={onPick}>
        {t.time && <b>{t.time}</b>}
        {t.title}
      </button>
    </div>
  )
}

export function WeekView({ start, today, tasks, docs, catColor, selected, onPick, onToggle, onOpenNote }: Common & { start: string; selected: ID | null; onPick: (id: ID) => void; onToggle: (t: Task) => void; onOpenNote: (id: ID) => void }) {
  const byDay = useMemo(() => tasksByDay(tasks), [tasks])
  const notes = useMemo(() => notesByDay(docs), [docs])
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i))
  // 좁은 화면은 주를 옆으로 밀어 본다 — 이번 주면 오늘 칸이 보이게 둔다
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = box.current
    const t = el?.querySelector<HTMLElement>('.is-today')
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = t ? t.offsetLeft - el.offsetLeft - 8 : 0
  }, [start])
  return (
    <div className="cal-week" ref={box}>
      {days.map((d) => (
        <section key={d} className={'cal-week-day' + (d === today ? ' is-today' : '') + (fromKey(d).getDay() % 6 === 0 ? ' is-weekend' : '')} aria-label={longDay(d)}>
          <h3 className="cal-week-head">
            <span>{weekdayOf(d)}</span>
            <b>{fromKey(d).getDate()}</b>
          </h3>
          <div className="cal-week-tasks">
            {(byDay.get(d) ?? []).map((t) => (
              <TaskChip key={t.id} t={t} today={today} color={catColor(t.category)} on={t.id === selected} onPick={() => onPick(t.id)} onToggle={() => onToggle(t)} />
            ))}
          </div>
          <WeekNotes notes={notes.get(d)} onOpenNote={onOpenNote} />
        </section>
      ))}
    </div>
  )
}

/** 주 칸 아래의 노트 — 만든 노트와 마지막으로 고친 노트, 합쳐서 넷까지 */
function WeekNotes({ notes, onOpenNote }: { notes: DayNotes | undefined; onOpenNote: (id: ID) => void }) {
  const made = notes?.made.slice(0, 4) ?? []
  const last = notes?.last.slice(0, 4 - made.length) ?? []
  const rest = noteCount(notes) - made.length - last.length
  const item = (n: DocumentMeta) => (
    <button key={n.id} className="cal-note" onClick={() => onOpenNote(n.id)}>
      <i aria-hidden="true" />
      {n.title}
    </button>
  )
  return (
    <div className="cal-week-notes">
      {made.length > 0 && (
        <div className="cal-note-group" data-kind="made">
          <small>만든 노트</small>
          {made.map(item)}
        </div>
      )}
      {last.length > 0 && (
        <div className="cal-note-group" data-kind="last">
          <small>마지막으로 고친 노트</small>
          {last.map(item)}
        </div>
      )}
      {rest > 0 && <small>+{rest}</small>}
    </div>
  )
}

export function MonthView({ month, day, today, tasks, docs, catColor, onPickDay }: Common & { month: string; day: string; onPickDay: (d: string) => void }) {
  const byDay = useMemo(() => tasksByDay(tasks), [tasks])
  const notes = useMemo(() => notesByDay(docs), [docs])
  const cells = monthCells(month)
  return (
    <div className="cal-month">
      <div className="cal-month-head" aria-hidden="true">
        {['월', '화', '수', '목', '금', '토', '일'].map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="cal-month-grid" style={{ gridTemplateRows: `repeat(${cells.length / 7}, minmax(0, 1fr))` }}>
        {cells.map((d) => {
          const list = byDay.get(d) ?? []
          const dn = notes.get(d)
          const n = noteCount(dn)
          const out = d.slice(0, 7) !== month.slice(0, 7)
          return (
            <button
              key={d}
              className={'cal-day' + (d === today ? ' is-today' : '') + (d === day ? ' is-picked' : '') + (out ? ' is-out' : '')}
              onClick={() => onPickDay(d)}
              aria-label={`${longDay(d)} — 할 일 ${list.length}개, 만든 노트 ${dn?.made.length ?? 0}개, 마지막으로 고친 노트 ${dn?.last.length ?? 0}개`}
              aria-pressed={d === day}
            >
              <span className="cal-day-top">
                <b>{fromKey(d).getDate()}</b>
                {n > 0 && (
                  <span className="cal-day-notes">
                    <i aria-hidden="true" />
                    {n}
                  </span>
                )}
              </span>
              {list.slice(0, 2).map((t) => (
                <span key={t.id} className={'cal-day-task' + (t.doneAt ? ' is-done' : '') + (isLate(t, today) ? ' is-late' : '')}>
                  <i className="cat-dot" style={{ background: catColor(t.category) }} aria-hidden="true" />
                  {t.title}
                </span>
              ))}
              {list.length > 2 && <span className="cal-day-more">+{list.length - 2}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 달력에서 고른 날 — 그날 마감인 할 일, 그날 만든 노트, 그날을 마지막으로 고친 노트 */
export function DayPanel({ day, today, tasks, docs, catColor, onPick, onToggle, onOpenNote, onClose }: Common & { day: string; onPick: (id: ID) => void; onToggle: (t: Task) => void; onOpenNote: (id: ID) => void; onClose?: () => void }) {
  const list = useMemo(() => tasksByDay(tasks).get(day) ?? [], [tasks, day])
  const notes = useMemo(() => notesByDay(docs).get(day) ?? { made: [], last: [] }, [docs, day])
  const note = (n: DocumentMeta) => (
    <button key={n.id} className="day-note" onClick={() => onOpenNote(n.id)}>
      <Icon name={n.mode === 'text' ? 'textDoc' : n.mode === 'infinite' ? 'infinite' : 'notebook'} size={18} />
      <span>
        <b>{n.title}</b>
        <small>
          <i className="cat-dot" style={{ background: catColor(n.category) }} aria-hidden="true" />
          {n.category ?? '미분류'}
        </small>
      </span>
    </button>
  )
  return (
    <div className="day-panel">
      <div className="day-panel-head">
        <div>
          <small>{day === today ? '오늘' : day === addDays(today, 1) ? '내일' : day === addDays(today, -1) ? '어제' : ''}</small>
          <h2>{longDay(day)}</h2>
        </div>
        {onClose && (
          <button className="tb-btn" onClick={onClose} aria-label="닫기">
            <Icon name="close" size={18} />
          </button>
        )}
      </div>
      <section className="task-section">
        <h3>할 일 {list.length}</h3>
        {/* 비어 있어도 자리를 차지하는 상자 — 할 일이 생기면 이 안에 들어온다 */}
        <div className={'day-task-box' + (list.length ? '' : ' is-empty')}>
          {!list.length && <p className="hint">이날 마감인 할 일이 없습니다.</p>}
          {list.map((t) => (
            <div key={t.id} className={'day-task' + (t.doneAt ? ' is-done' : '')}>
              <button className="task-check" onClick={() => onToggle(t)} aria-label={t.doneAt ? `${t.title} — 끝냄 취소` : `${t.title} — 끝냄`} aria-pressed={!!t.doneAt}>
                {t.doneAt && <Icon name="check" size={13} />}
              </button>
              <button className="day-task-main" onClick={() => onPick(t.id)}>
                {t.title}
                {t.time && <small>{timeLabel(t.time)}</small>}
              </button>
              <i className="cat-dot" style={{ background: catColor(t.category) }} aria-hidden="true" />
            </div>
          ))}
        </div>
      </section>
      <section className="task-section" data-kind="made">
        <h3>이날 만든 노트 {notes.made.length}</h3>
        {!notes.made.length && <p className="hint">이날 만든 노트가 없습니다.</p>}
        {notes.made.map(note)}
      </section>
      <section className="task-section" data-kind="last">
        <h3>이날 마지막으로 고친 노트 {notes.last.length}</h3>
        {!notes.last.length && <p className="hint">이날을 마지막으로 고친 노트가 없습니다 — 이날 고쳤어도 다른 날 또 고쳤으면 그날로 옮겨 갑니다.</p>}
        {notes.last.map(note)}
      </section>
    </div>
  )
}
