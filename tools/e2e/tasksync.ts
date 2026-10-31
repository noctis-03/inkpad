// 할 일 동기화 (src/sync/tasks.ts) — 기기 두 대와 가짜 Drive.
// 동기화를 설정하기 전에는 올리지 않는다 · 일정 화면의 동기화 버튼 · 고치면 바로 올리기 · 칸마다 나중에 고친 쪽 ·
// 휴지통·되살리기·영구 삭제가 퍼진다 · 30일 지난 휴지통은 Drive 휴지통으로 · 오프라인 대기와 배지 ·
// 열 때 확인(켰을 때만) · 폴더가 통째로 사라지면 다시 올린다
import type { Page } from 'playwright'
import { createFakeDrive } from './fake-drive.ts'
import { device, logsOf, sleep, type Ctx } from './lib.ts'

type Row = { id: string; title: string; due: string | null; done: boolean; deleted: boolean; memo: string; pending: boolean; purged: boolean }

/** 화면에 보일 할 일 (영구 삭제 표식은 빠진다) */
const tasks = (p: Page): Promise<Row[]> =>
  p.evaluate(async () =>
    (await (await import('/src/storage/tasks.ts')).listTasks()).map((t) => ({
      id: t.id,
      title: t.title,
      due: t.due,
      done: !!t.doneAt,
      deleted: !!t.deletedAt,
      memo: t.memo,
      pending: !!t.pending,
      purged: !!t.purgedAt
    }))
  )
const byTitle = async (p: Page, title: string) => (await tasks(p)).find((t) => t.title === title)
/** DB 행 그대로 (영구 삭제 표식 포함) */
const rawRow = (p: Page, id: string) => p.evaluate(async (id) => (await (await import('/src/storage/db.ts')).db.tasks.get(id)) ?? null, id)
const sync = (p: Page) => p.evaluate(async () => (await import('/src/sync/tasks.ts')).syncTasks())
const add = (p: Page, title: string, due: string | null = null) =>
  p.evaluate(async ({ title, due }) => (await (await import('/src/storage/tasks.ts')).createTask({ title, due }))!.id, { title, due })
const update = (p: Page, id: string, patch: Record<string, unknown>) =>
  p.evaluate(async ({ id, patch }) => (await import('/src/storage/tasks.ts')).updateTask(id, patch), { id, patch })
const call = (p: Page, fn: 'setTaskDone' | 'trashTask' | 'restoreTask' | 'purgeTask', id: string, arg?: boolean) =>
  p.evaluate(
    async ({ fn, id, arg }) => {
      const t = await import('/src/storage/tasks.ts')
      if (fn === 'setTaskDone') return void (await t.setTaskDone(id, !!arg))
      await t[fn](id)
    },
    { fn, id, arg }
  )
/** 대기가 다 올라갈 때까지 (고치면 0.7초 뒤 올린다) */
async function settled(p: Page): Promise<boolean> {
  await sleep(100)
  for (let i = 0; i < 80; i++) {
    const n = await p.evaluate(async () => (await (await import('/src/storage/tasks.ts')).pendingTaskCount()))
    if (n === 0) return true
    await sleep(100)
  }
  return false
}
const dayKey = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default async function tasksync(ctx: Ctx) {
  const { base, check } = ctx
  const drive = createFakeDrive()
  const remoteTasks = () => [...drive.files.values()].filter((f) => f.appProperties.taskId && !f.trashed)
  const remoteOf = (id: string) => remoteTasks().find((f) => f.appProperties.taskId === id)
  const bodyOf = (id: string) => {
    const f = remoteOf(id)
    return f ? JSON.parse(f.revisions.at(-1)!.content.toString('utf8')) : null
  }

  const A = await device(ctx, { drive, name: 'iPad' })
  const B = await device(ctx, { drive, name: '휴대폰' })
  let aRequests = 0
  A.on('request', (r) => {
    if (r.url().includes('googleapis.com')) aRequests++
  })

  // ── 동기화를 설정하기 전: 할 일을 넣어도 Drive 요청 0 ──
  await A.goto(`${base}/#/plan`)
  await A.waitForSelector('.plan')
  const input = A.getByRole('textbox', { name: '할 일 추가' })
  await input.fill('회로 보고서')
  await input.press('Enter')
  await A.locator('.task-title', { hasText: '회로 보고서' }).waitFor()
  await sleep(1500)
  check('동기화를 설정하기 전에는 할 일을 넣어도 Drive 요청 0 (대기로 남는다)', aRequests === 0 && (await byTitle(A, '회로 보고서'))?.pending === true, String(aRequests))
  const syncBtn = A.locator('.plan-sync')
  check('동기화를 설정하기 전에는 올릴 것 배지가 없다 (올라가지 않는 게 정상)', (await syncBtn.getAttribute('aria-label')) === '할 일 동기화' && (await syncBtn.locator('.sync-badge').count()) === 0)

  // ── 동기화 버튼 ──
  await syncBtn.click()
  await A.locator('.toast', { hasText: '할 일 1개 올림' }).waitFor({ timeout: 8000 })
  const report = (await byTitle(A, '회로 보고서'))!
  check('동기화 버튼: 올리고 알린다 · 배지가 사라진다', !!remoteOf(report.id) && !report.pending && (await syncBtn.locator('.sync-badge').count()) === 0)
  check('Drive 파일: Inkpad/tasks/<id>.json, 표식에 할 일 id·제목', remoteOf(report.id)?.name === `${report.id}.json` && remoteOf(report.id)?.appProperties.title === '회로 보고서' && bodyOf(report.id)?.kind === 'inkpad-task')
  const tasksFolder = remoteOf(report.id)!.parents[0]
  check('tasks 폴더는 Inkpad 아래', [...drive.files.values()].find((f) => f.id === tasksFolder)?.name === 'tasks')

  // ── 설정한 뒤에는 고치면 바로 올라간다 (연달아 고쳐도 한 번에) ──
  const before = drive.stats.uploads
  const words = await add(A, '단어 외우기', dayKey(1))
  await update(A, words, { memo: '30개' })
  check('고치면 바로 올라간다', (await settled(A)) && bodyOf(words)?.memo === '30개')
  check('연달아 고치면 한 번에 올린다', drive.stats.uploads - before === 1, String(drive.stats.uploads - before))

  // ── 다른 기기가 받는다 ──
  const r1 = await sync(B)
  check('다른 기기: 동기화하면 할 일을 받는다', r1.down === 2 && sameTitles(await tasks(B), ['회로 보고서', '단어 외우기']), JSON.stringify(r1))
  check('받은 할 일은 올릴 것이 아니다', (await tasks(B)).every((t) => !t.pending))
  const r1b = await sync(B)
  check('바뀐 게 없으면 본문을 다시 받지 않는다', r1b.down === 0 && r1b.up === 0)

  // ── 두 기기가 같은 할 일의 다른 칸을 고쳤다 — 둘 다 산다 ──
  await A.context().setOffline(true)
  await call(A, 'setTaskDone', report.id, true)
  await sleep(1000)
  await A.context().setOffline(false)
  check('오프라인에서 고친 것은 대기로 남는다', (await byTitle(A, '회로 보고서'))?.pending === true)
  check('설정한 뒤 대기가 있으면 동기화 버튼에 개수 배지', (await syncBtn.getAttribute('aria-label')) === '할 일 동기화 — 올릴 것 1개' && (await syncBtn.locator('.sync-badge').innerText()) === '1')
  await sleep(5)
  await update(B, report.id, { due: dayKey(3) })
  await settled(B)
  check('휴대폰이 마감을 바꿔 올렸다', bodyOf(report.id)?.due === dayKey(3) && !bodyOf(report.id)?.doneAt)
  const r2 = await sync(A)
  const aReport = (await byTitle(A, '회로 보고서'))!
  check('iPad 동기화: 끝냄(이 기기) + 새 마감(휴대폰) 둘 다 남는다', aReport.done && aReport.due === dayKey(3) && !aReport.pending, JSON.stringify({ r2, aReport }))
  check('Drive에도 합친 것이 올라간다', !!bodyOf(report.id)?.doneAt && bodyOf(report.id)?.due === dayKey(3))
  await sync(B)
  const bReport = (await byTitle(B, '회로 보고서'))!
  check('휴대폰도 같아진다', bReport.done && bReport.due === dayKey(3))

  // ── 같은 칸 — 나중에 고친 쪽 ──
  await update(A, words, { title: '단어 외우기 (1과)' })
  await settled(A)
  await sleep(5)
  await B.context().setOffline(true)
  await update(B, words, { title: '단어 외우기 (2과)' })
  await B.context().setOffline(false)
  await sync(B)
  await sync(A)
  check('같은 칸은 나중에 고친 쪽 — 두 기기 모두', (await tasks(A)).some((t) => t.title === '단어 외우기 (2과)') && (await tasks(B)).some((t) => t.title === '단어 외우기 (2과)'))

  // ── 휴지통이 퍼지고, 되살리기도 퍼진다 ──
  await call(A, 'trashTask', words)
  await settled(A)
  check('휴지통: Drive 표식에 지운 시각', Number(remoteOf(words)?.appProperties.deletedAt) > 0)
  await sync(B)
  check('휴지통이 다른 기기로 퍼진다 (그 기기 휴지통에)', (await tasks(B)).find((t) => t.id === words)?.deleted === true)
  await call(B, 'restoreTask', words)
  await settled(B)
  check('되살리면 Drive 표식의 지운 시각도 지운다', !remoteOf(words)?.appProperties.deletedAt, JSON.stringify(remoteOf(words)?.appProperties))
  await sync(A)
  check('되살리기도 퍼진다', (await tasks(A)).find((t) => t.id === words)?.deleted === false)

  // ── 영구 삭제가 퍼진다 ──
  await call(A, 'trashTask', words)
  await call(A, 'purgeTask', words)
  await settled(A)
  check('영구 삭제: 목록에서 사라지고 표식으로 남아 올라간다', !(await tasks(A)).some((t) => t.id === words) && !!(await rawRow(A, words))?.purgedAt && remoteOf(words)?.appProperties.purged === '1')
  await sync(B)
  check('영구 삭제가 다른 기기로 퍼진다', !(await tasks(B)).some((t) => t.id === words))
  const C = await device(ctx, { drive, name: '새 기기' })
  await sync(C)
  check('새 기기는 영구 삭제한 할 일을 받지 않는다', (await tasks(C)).length === 1 && !(await rawRow(C, words)))

  // ── 30일 지난 휴지통: 받기 때 Drive 휴지통으로, 모든 기기에서 지운다 ──
  const old = await add(A, '지난달 할 일')
  await settled(A)
  await sync(B)
  await update(A, old, { deletedAt: Date.now() - 31 * 86400_000 })
  await settled(A)
  const r3 = await sync(B)
  const oldFile = [...drive.files.values()].find((f) => f.appProperties.taskId === old)
  check('30일 지난 휴지통: 받기가 Drive 휴지통으로 보내고 이 기기에서도 지운다', r3.cleaned === 1 && !!oldFile?.trashed && !(await rawRow(B, old)), JSON.stringify(r3))
  await sync(A)
  check('정리된 파일이 사라지면 다른 기기에서도 지운다', !(await rawRow(A, old)))

  // ── 열 때 확인: 켰을 때만, 30분 간격 ──
  const fresh = await add(A, '열 때 받을 할 일')
  await settled(A)
  let bRequests = 0
  B.on('request', (r) => {
    if (r.url().includes('googleapis.com')) bRequests++
  })
  await B.goto(`${base}/#/plan`)
  await B.waitForSelector('.plan')
  await sleep(1200)
  check('열 때 확인을 끈 기기: 일정 화면을 열어도 Drive 요청 0', bRequests === 0 && !(await rawRow(B, fresh)), String(bRequests))
  await B.evaluate(async () => {
    ;(await import('/src/app/store.ts')).useUI.getState().setSettings({ cloudCheckOnOpen: true })
    await (await import('/src/sync/folders.ts')).putSync('tasksSyncedAt', Date.now() - 31 * 60_000)
  })
  await B.goto(`${base}/#/`)
  await B.reload()
  await B.waitForSelector('#root *')
  await B.goto(`${base}/#/plan`)
  await B.locator('.task-title', { hasText: '열 때 받을 할 일' }).first().waitFor({ timeout: 8000 }).catch(() => {})
  check('열 때 확인을 켠 기기: 일정 화면을 열면 받는다', !!(await rawRow(B, fresh)))
  bRequests = 0
  await B.goto(`${base}/#/`)
  await B.goto(`${base}/#/plan`)
  await sleep(1200)
  check('30분 안에 다시 열면 확인하지 않는다', bRequests === 0, String(bRequests))

  // ── tasks 폴더가 통째로 사라졌다 — 지우지 않고 전부 다시 올린다 ──
  drive.files.get(tasksFolder)!.trashed = true
  await A.evaluate(async () => (await import('/src/sync/folders.ts')).invalidateFolders())
  await sync(A)
  // 가짜 Drive는 폴더만 휴지통에 넣는다(실제 Drive는 안의 파일도 함께) — 새 폴더에 올라간 것만 센다
  const live = await tasks(A)
  const reup = remoteTasks().filter((f) => f.parents[0] !== tasksFolder)
  check(
    '폴더가 사라지면 이 기기 할 일을 전부 새 폴더로 다시 올린다',
    live.length === 2 && live.every((t) => reup.some((f) => f.appProperties.taskId === t.id) && !t.pending) && [...drive.files.values()].find((f) => f.id === reup[0]?.parents[0])?.name === 'tasks',
    `${reup.length}`
  )

  check('콘솔 오류 없음', [A, B, C].every((p) => !logsOf(p).some((l) => /error|uncaught/i.test(l) && !/net::|Failed to load resource/.test(l))), [A, B, C].flatMap(logsOf).join('\n').slice(0, 400))
  await A.context().close()
  await B.context().close()
  await C.context().close()
}

const sameTitles = (rows: Row[], titles: string[]) => JSON.stringify(rows.map((r) => r.title).sort()) === JSON.stringify([...titles].sort())
