// 할 일 자세히 — 제목·마감(날짜·시각)·카테고리·연결한 노트·메모. 고치면 바로 저장한다(칸마다 고친 시각이 남는다).
import { useState } from 'react'
import { Icon } from '../Icon'
import type { ID, Task } from '../../shared/model'
import { confirmDialog } from '../../app/dialogs'
import { purgeTask, restoreTask, setTaskDone, trashTask, updateTask } from '../../storage/tasks'
import { formatDate } from '../../shared/util'
import { addDays, dueLabel, weekStart } from './planUtil'
import { DatePick } from './DatePick'

export function TaskDetail({
  task,
  today,
  categories,
  catColor,
  noteTitle,
  onOpenNote,
  onClose,
  onTrashed
}: {
  task: Task
  today: string
  categories: string[]
  catColor: (c: string | null) => string
  /** 연결한 노트의 제목 — 이 기기에 없으면 null */
  noteTitle: string | null
  onOpenNote: (docId: ID, pageId?: ID) => void
  onClose: () => void
  onTrashed: (id: ID, title: string) => void
}) {
  const [title, setTitle] = useState(task.title)
  const [memo, setMemo] = useState(task.memo)
  const trashed = !!task.deletedAt
  const set = (patch: Parameters<typeof updateTask>[1]) => void updateTask(task.id, patch)
  const dueChips: { label: string; value: string | null }[] = [
    { label: '오늘', value: today },
    { label: '내일', value: addDays(today, 1) },
    { label: '이번 주', value: addDays(weekStart(today), 6) },
    { label: '없음', value: null }
  ]
  const customDue = task.due && !dueChips.some((c) => c.value === task.due)

  return (
    <div className="task-detail">
      <div className="task-detail-head">
        <button className="task-check is-big" onClick={() => void setTaskDone(task.id, !task.doneAt)} aria-label={task.doneAt ? '끝냄 취소' : '끝냄'} aria-pressed={!!task.doneAt} disabled={trashed}>
          {task.doneAt && <Icon name="check" size={14} />}
        </button>
        <textarea
          className={'task-detail-title' + (task.doneAt ? ' is-done' : '')}
          value={title}
          rows={1}
          aria-label="제목"
          readOnly={trashed}
          onChange={(e) => setTitle(e.target.value.replace(/\n/g, ''))}
          onBlur={() => (title.trim() ? set({ title }) : setTitle(task.title))}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())}
        />
        <button className="tb-btn" onClick={onClose} aria-label="닫기">
          <Icon name="close" size={18} />
        </button>
      </div>

      <dl className="task-fields">
        <dt>마감</dt>
        <dd className="task-due">
          {dueChips.map((c) => (
            <button key={c.label} className={'lib-chip' + (task.due === c.value ? ' is-on' : '')} aria-pressed={task.due === c.value} disabled={trashed} onClick={() => set({ due: c.value, ...(c.value ? {} : { time: null }) })}>
              {c.label}
            </button>
          ))}
          <DatePick value={task.due} on={!!customDue} disabled={trashed} onPick={(due) => set({ due })}>
            {customDue ? dueLabel(task.due!, today) : '날짜…'}
          </DatePick>
        </dd>
        <dt>시각</dt>
        <dd className="task-time">
          <input type="time" value={task.time ?? ''} disabled={trashed || !task.due} onChange={(e) => set({ time: e.target.value || null })} aria-label="마감 시각" />
          {task.time && (
            <button className="text-btn small" onClick={() => set({ time: null })} disabled={trashed}>
              지우기
            </button>
          )}
          {!task.due && <small>마감 날짜를 먼저 정하세요</small>}
        </dd>
        <dt>카테고리</dt>
        <dd className="task-cat">
          <i className="cat-dot" style={{ background: catColor(task.category) }} aria-hidden="true" />
          <select value={task.category ?? ''} disabled={trashed} onChange={(e) => set({ category: e.target.value || null })} aria-label="카테고리">
            <option value="">미분류</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </dd>
      </dl>

      {task.link && (
        <section className="task-section">
          <h3>{task.snippet ? '노트에서 보낸 부분' : '연결한 노트'}</h3>
          {task.snippet && (
            <button className="task-snippet-big" onClick={() => noteTitle !== null && onOpenNote(task.link!.docId, task.link!.pageId)} disabled={noteTitle === null} aria-label="노트에서 보낸 부분 — 그 자리 열기">
              <img src={task.snippet} alt="" />
            </button>
          )}
          {noteTitle !== null ? (
            <button className="task-note-card" onClick={() => onOpenNote(task.link!.docId, task.link!.pageId)}>
              <Icon name="notebook" size={16} />
              <span>{noteTitle}</span>
              <em>열기 ›</em>
            </button>
          ) : (
            <p className="hint">이 기기에 그 노트가 없습니다 — 노트를 받으면 여기서 열 수 있습니다.</p>
          )}
        </section>
      )}

      <section className="task-section">
        <h3>메모</h3>
        <textarea className="task-memo" value={memo} readOnly={trashed} placeholder="메모 — 고치면 바로 저장됩니다" onChange={(e) => setMemo(e.target.value)} onBlur={() => set({ memo })} aria-label="메모" />
      </section>

      <div className="task-detail-foot">
        <small>{formatDate(task.createdAt)} 만듦{task.doneAt ? ` · ${formatDate(task.doneAt)} 끝냄` : ''}</small>
        {trashed ? (
          <span className="btn-row">
            <button className="text-btn small" onClick={() => void restoreTask(task.id)}>
              되살리기
            </button>
            <button
              className="text-btn small danger"
              onClick={async () => {
                if (await confirmDialog('영구 삭제', { message: `'${task.title}'을(를) 지금 지웁니다. 되돌릴 수 없습니다.`, ok: '삭제', danger: true })) {
                  await purgeTask(task.id)
                  onClose()
                }
              }}
            >
              영구 삭제
            </button>
          </span>
        ) : (
          <button
            className="text-btn small danger"
            onClick={async () => {
              await trashTask(task.id)
              onTrashed(task.id, task.title)
            }}
          >
            휴지통으로
          </button>
        )}
      </div>
    </div>
  )
}
