// 할 일로 보내기 — 올가미로 고른 영역을 작은 그림으로 만들어 그 노트·쪽에 이어진 할 일로 넣는다 (일정 화면, ui/plan).
// 그림은 할 일에 함께 담겨 기기 사이를 오간다(sync/tasks). 이 창은 이 기기 안에서만 만든다 — 올리기는 할 일 저장이 한다.
//  - 제목은 노트 이름·쪽으로 채워 두고(바로 고칠 수 있게 전체 선택), 마감은 오늘·내일·이번 주·없음·날짜
//  - 카테고리는 노트의 카테고리를 따른다
import { useEffect, useRef, useState } from 'react'
import { useUI } from '../../app/store'
import type { Engine } from '../../engine/engine'
import type { DocumentMeta } from '../../shared/model'
import { db } from '../../storage/db'
import { TASK_TITLE_MAX, createTask } from '../../storage/tasks'
import { SNIPPET_MAX } from '../../sync/taskMerge'
import { Icon } from '../Icon'
import { useEscClose } from '../sheetParts'
import { addDays, dueLabel, todayKey, weekStart } from '../plan/planUtil'

const blobToDataUrl = (b: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = () => rej(r.error)
    r.readAsDataURL(b)
  })

/** 할 일에 붙일 그림 — 긴 변 640px, 크면 줄여 다시. 그래도 크면 그림 없이 */
async function makeSnippet(engine: Engine, background: boolean): Promise<string | null> {
  for (const longSide of [640, 400]) {
    const b = await engine.exportImage('selection', { background, ink: true, longSide })
    if (!b) return null
    const url = await blobToDataUrl(b)
    if (url.length <= SNIPPET_MAX) return url
  }
  return null
}

export function TaskSendSheet({ engine, doc }: { engine: Engine; doc: DocumentMeta }) {
  const toast = useUI((s) => s.toast)
  const navigate = useUI((s) => s.navigate)
  const sel = useUI((s) => s.selection)
  const close = () => useUI.setState({ taskSend: false })
  useEscClose(close)

  const page = engine.selectionPage()
  const [title, setTitle] = useState(() => `${doc.title || '노트'}${page ? ` ${page.index + 1}쪽` : ''}`.slice(0, TASK_TITLE_MAX))
  const today = todayKey()
  const dueChips: { label: string; value: string | null }[] = [
    { label: '오늘', value: today },
    { label: '내일', value: addDays(today, 1) },
    { label: '이번 주', value: addDays(weekStart(today), 6) },
    { label: '없음', value: null }
  ]
  const [due, setDue] = useState<string | null>(today)
  const customDue = due && !dueChips.some((c) => c.value === due)
  const [category, setCategory] = useState<string | null>(doc.category ?? null)
  const [cats, setCats] = useState<string[]>([])
  const [snippet, setSnippet] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  // 획 없이 영역만 골랐으면(인쇄된 PDF 문제를 감쌌을 때) 밑의 PDF까지, 획을 골랐으면 글씨만
  const background = !!sel && !sel.count
  useEffect(() => {
    let alive = true
    void makeSnippet(engine, background).then(
      (s) => alive && setSnippet(s),
      () => alive && setSnippet(null)
    )
    return () => {
      alive = false
    }
  }, [engine, background])

  useEffect(() => {
    void Promise.all([db.documents.toArray(), db.tasks.toArray()]).then(([docs, tasks]) => {
      const s = new Set<string>()
      for (const d of docs) if (d.category && !d.deletedAt) s.add(d.category)
      for (const t of tasks) if (t.category && !t.deletedAt) s.add(t.category)
      if (doc.category) s.add(doc.category)
      setCats([...s].sort((a, b) => a.localeCompare(b, 'ko')))
    })
  }, [doc.category])

  useEffect(() => {
    titleRef.current?.focus()
    titleRef.current?.select()
  }, [])

  const create = async () => {
    if (!title.trim() || busy || snippet === undefined) return
    setBusy(true)
    try {
      const t = await createTask({ title, due, category, link: { docId: doc.id, ...(page ? { pageId: page.id } : {}) }, snippet })
      if (!t) return
      engine.clearSelection()
      close()
      toast(due === today ? '오늘 할 일에 넣었습니다' : '할 일에 넣었습니다', 'success', { label: '일정 보기', run: () => navigate({ name: 'plan' }) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal task-send" role="dialog" aria-label="할 일로 보내기">
        <h2 className="modal-title">할 일로 보내기</h2>
        <div className="task-send-preview">
          {snippet ? <img src={snippet} alt="보낼 부분" /> : snippet === null ? <p>그림 없이 넣습니다.</p> : <div className="spinner" />}
        </div>
        <form
          className="task-send-form"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <input ref={titleRef} className="task-send-title" value={title} maxLength={TASK_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} aria-label="할 일 이름" placeholder="할 일 이름" />
          <div className="task-send-row">
            <span>마감</span>
            <div className="task-due">
              {dueChips.map((c) => (
                <button type="button" key={c.label} className={'lib-chip' + (due === c.value ? ' is-on' : '')} aria-pressed={due === c.value} onClick={() => setDue(c.value)}>
                  {c.label}
                </button>
              ))}
              <label className={'lib-chip task-date' + (customDue ? ' is-on' : '')}>
                {customDue ? dueLabel(due!, today) : '날짜…'}
                <input type="date" value={due ?? ''} onChange={(e) => e.target.value && setDue(e.target.value)} aria-label="마감 날짜 고르기" />
              </label>
            </div>
          </div>
          <div className="task-send-row">
            <span>카테고리</span>
            <select value={category ?? ''} onChange={(e) => setCategory(e.target.value || null)} aria-label="카테고리">
              <option value="">미분류</option>
              {cats.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <p className="modal-note">
            {page ? `「${doc.title || '노트'}」 ${page.index + 1}쪽에 이어집니다` : `「${doc.title || '노트'}」에 이어집니다`} — 일정에서 누르면 이 자리로 옵니다.
          </p>
          <div className="modal-actions">
            <button type="button" className="text-btn" onClick={close}>
              취소
            </button>
            <button type="submit" className="primary-btn" disabled={!title.trim() || busy || snippet === undefined}>
              <Icon name="todo" size={18} /> 할 일 만들기
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
