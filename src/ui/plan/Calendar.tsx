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
/** 날짜 → 그날 만들었거나 고친 노트 (지운 노트 제외, 최근 것 먼저) */
function notesByDay(docs: DocumentMeta[]) {
  const m = new Map<string, DocumentMeta[]>()
  const put = (k: string, d: DocumentMeta) => {
    if (!m.has(k)) m.set(k, [])
    if (!m.get(k)!.includes(d)) m.get(k)!.push(d)
  }
  for (const d of docs) {
    if (d.deletedAt) continue
    put(dayKey(new Date(d.updatedAt)), d)
    put(dayKey(new Date(d.createdAt)), d)
  }
  for (const list of m.values()) list.sort((a, b) => b.updatedAt - a.updatedAt)
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
          <div className="cal-week-notes">
            <small>고친 노트</small>
            {(notes.get(d) ?? []).slice(0, 4).map((n) => (
              <button key={n.id} className="cal-note" onClick={() => onOpenNote(n.id)}>
                <i aria-hidden="true" />
                {n.title}
              </button>
            ))}
            {(notes.get(d)?.length ?? 0) > 4 && <small>+{notes.get(d)!.length - 4}</small>}
          </div>
        </section>
      ))}
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
          const n = notes.get(d)?.length ?? 0
          const out = d.slice(0, 7) !== month.slice(0, 7)
          return (
            <button
              key={d}
              className={'cal-day' + (d === today ? ' is-today' : '') + (d === day ? ' is-picked' : '') + (out ? ' is-out' : '')}
              onClick={() => onPickDay(d)}
              aria-label={`${longDay(d)} — 할 일 ${list.length}개, 고친 노트 ${n}개`}
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

/** 달력에서 고른 날 — 그날 마감인 할 일과 그날 고친 노트 */
export function DayPanel({ day, today, tasks, docs, catColor, onPick, onToggle, onOpenNote, onClose }: Common & { day: string; onPick: (id: ID) => void; onToggle: (t: Task) => void; onOpenNote: (id: ID) => void; onClose?: () => void }) {
  const list = useMemo(() => tasksByDay(tasks).get(day) ?? [], [tasks, day])
  const notes = useMemo(() => notesByDay(docs).get(day) ?? [], [docs, day])
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
      </section>
      <section className="task-section">
        <h3>이날 고친 노트 {notes.length}</h3>
        {!notes.length && <p className="hint">이날 만들거나 고친 노트가 없습니다.</p>}
        {notes.map((n) => (
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
        ))}
      </section>
    </div>
  )
}
