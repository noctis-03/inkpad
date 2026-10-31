// 할 일 합치기 — 화면·DB와 떨어진 순수 함수 (sync/tasks.ts가 쓰고 tools/verify/task-merge-test.ts가 검사한다).
// 두 기기가 같은 할 일을 따로 고쳤으면 칸(제목·마감·끝냄…)마다 나중에 고친 쪽을 남긴다 — 한쪽이 끝냄을 누르고
// 다른 쪽이 마감을 바꿨으면 둘 다 산다. 같은 칸을 같은 시각에 고쳤으면 값으로 정해 어느 기기에서 합쳐도 같다.
// 영구 삭제(purgedAt)는 한 번 붙으면 떨어지지 않는다. 올가미로 보낸 그림(snippet)도 칸 하나로 함께 오간다.
import { TRASH_RETENTION_DAYS, type ID, type Task, type TaskField } from '../shared/model.ts'

export const TASK_FIELDS: TaskField[] = ['title', 'memo', 'due', 'time', 'category', 'doneAt', 'deletedAt', 'link', 'snippet']

/** 올가미로 보낸 그림의 최대 크기 (data URL 글자 수) — 작은 미리보기라 이보다 크면 버린다 */
export const SNIPPET_MAX = 400_000

/** 할 일 내용 — 이 기기의 동기화 기록(fileId·rev·pending)을 뺀 것 */
export type TaskContent = Omit<Task, 'fileId' | 'rev' | 'pending'>

/** Drive에 올리는 할 일 파일 (Inkpad/tasks/<id>.json) */
export interface TaskFileV1 extends TaskContent {
  kind: 'inkpad-task'
  v: 1
}

/** 칸 순서를 늘 같게 만든다 — sameContent가 JSON으로 비교한다 */
export function toTaskFile(t: TaskContent): TaskFileV1 {
  const { id, title, memo, due, time, category, doneAt, deletedAt, createdAt, updatedAt, purgedAt, snippet } = t
  const ts: TaskContent['ts'] = {}
  for (const f of TASK_FIELDS) if (t.ts[f] !== undefined) ts[f] = t.ts[f]
  const link = t.link ? { docId: t.link.docId, ...(t.link.pageId ? { pageId: t.link.pageId } : {}) } : null
  return { kind: 'inkpad-task', v: 1, id, title, memo, due, time, category, doneAt, deletedAt, link, ...(snippet ? { snippet } : {}), createdAt, updatedAt, ts, ...(purgedAt ? { purgedAt } : {}) }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null)
const DAY = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^\d{2}:\d{2}$/

/** 받은 파일을 할 일 내용으로 — 모양이 어긋난 칸은 비운다. 할 일이 아니면 null */
export function fromTaskFile(raw: unknown, id?: ID): TaskContent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const tid = typeof r.id === 'string' && r.id ? r.id : null
  if (!tid || (id && tid !== id) || typeof r.title !== 'string') return null
  const createdAt = num(r.createdAt) ?? 0
  const ts: TaskContent['ts'] = {}
  const rts = r.ts && typeof r.ts === 'object' ? (r.ts as Record<string, unknown>) : {}
  for (const f of TASK_FIELDS) {
    const v = num(rts[f])
    if (v !== null) ts[f] = v
  }
  const link = r.link && typeof r.link === 'object' ? (r.link as Record<string, unknown>) : null
  const due = str(r.due, 10)
  const time = str(r.time, 5)
  const purgedAt = num(r.purgedAt)
  const snippet = typeof r.snippet === 'string' && r.snippet.startsWith('data:image/') && r.snippet.length <= SNIPPET_MAX ? r.snippet : null
  return {
    id: tid,
    title: r.title.slice(0, 200),
    memo: str(r.memo, 20_000) ?? '',
    due: due && DAY.test(due) ? due : null,
    time: time && TIME.test(time) ? time : null,
    category: str(r.category, 40),
    doneAt: num(r.doneAt),
    deletedAt: num(r.deletedAt),
    link: link && typeof link.docId === 'string' ? { docId: link.docId, ...(typeof link.pageId === 'string' ? { pageId: link.pageId } : {}) } : null,
    ...(snippet ? { snippet } : {}),
    createdAt,
    updatedAt: num(r.updatedAt) ?? createdAt,
    ts,
    ...(purgedAt ? { purgedAt } : {})
  }
}

const json = (v: unknown) => JSON.stringify(v) ?? 'null'
/** 칸을 고친 시각 — 기록이 없으면 만든 시각 */
const at = (t: TaskContent, f: TaskField) => t.ts[f] ?? t.createdAt

/** 칸마다 나중에 고친 쪽을 남긴다. 어느 쪽을 a로 두어도 결과가 같다 */
export function mergeTask(a: TaskContent, b: TaskContent): TaskContent {
  const out: TaskContent = { ...a, ts: {} }
  const rec = out as unknown as Record<TaskField, unknown>
  for (const f of TASK_FIELDS) {
    const ta = at(a, f)
    const tb = at(b, f)
    const va = json(a[f] ?? null)
    const vb = json(b[f] ?? null)
    // 같은 시각이면 비어 있지 않은 쪽, 그다음 값이 큰 쪽 — 두 기기가 서로 반대로 합쳐도 같은 답이 나오게.
    // (그림 칸을 모르는 예전 앱이 그림 없이 다시 올려도 그림이 남는다)
    const takeB = tb > ta || (tb === ta && (va === 'null' ? vb !== 'null' : vb !== 'null' && vb > va))
    rec[f] = takeB ? b[f] : a[f]
    if (a.ts[f] !== undefined || b.ts[f] !== undefined) out.ts[f] = Math.max(ta, tb)
  }
  out.createdAt = Math.min(a.createdAt, b.createdAt)
  out.updatedAt = Math.max(a.updatedAt, b.updatedAt)
  const purgedAt = a.purgedAt && b.purgedAt ? Math.min(a.purgedAt, b.purgedAt) : a.purgedAt || b.purgedAt
  if (purgedAt) out.purgedAt = purgedAt
  else delete out.purgedAt
  if (!out.snippet) delete out.snippet
  return out
}

/** 내용이 같은가 (동기화 기록은 보지 않는다) */
export const sameContent = (a: TaskContent, b: TaskContent) => json(toTaskFile(a)) === json(toTaskFile(b))

/** 휴지통 기한(30일)이 지난 할 일인가 — 받기가 Drive 파일을 휴지통으로 보내고 이 기기의 행도 지운다 */
export const isExpired = (deletedAt: number | null | undefined, now = Date.now()) => !!deletedAt && deletedAt < now - TRASH_RETENTION_DAYS * 86400_000
