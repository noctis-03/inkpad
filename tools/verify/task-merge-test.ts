// 할 일 합치기 — 칸마다 나중에 고친 쪽 (src/sync/taskMerge.ts). 두 기기가 같은 할 일을 따로 고친 경우
import { fromTaskFile, isExpired, mergeTask, sameContent, toTaskFile, type TaskContent } from '../../src/sync/taskMerge.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else fail++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${!cond && detail ? ' — ' + detail : ''}`)
}

const T0 = 1_000_000
const base: TaskContent = {
  id: 't1',
  title: '회로 보고서',
  memo: '',
  due: '2026-10-30',
  time: null,
  category: '전자',
  doneAt: null,
  deletedAt: null,
  link: null,
  createdAt: T0,
  updatedAt: T0,
  ts: { title: T0, memo: T0, due: T0, time: T0, category: T0, doneAt: T0, deletedAt: T0, link: T0 }
}
const edit = (t: TaskContent, at: number, patch: Partial<TaskContent>): TaskContent => {
  const ts = { ...t.ts }
  for (const k of Object.keys(patch)) (ts as Record<string, number>)[k] = at
  return { ...t, ...patch, ts, updatedAt: at }
}

// 1) 서로 다른 칸 — 둘 다 산다
const ipad = edit(base, T0 + 10, { doneAt: T0 + 10 })
const phone = edit(base, T0 + 20, { due: '2026-11-06' })
const m1 = mergeTask(ipad, phone)
check('다른 칸을 고쳤으면 둘 다 남는다 (끝냄 + 새 마감)', m1.doneAt === T0 + 10 && m1.due === '2026-11-06', JSON.stringify(m1))
check('어느 쪽에서 합쳐도 같다', sameContent(m1, mergeTask(phone, ipad)))
check('고친 시각은 칸마다 큰 쪽, updatedAt도 큰 쪽', m1.ts.doneAt === T0 + 10 && m1.ts.due === T0 + 20 && m1.updatedAt === T0 + 20)

// 2) 같은 칸 — 나중에 고친 쪽
const a = edit(base, T0 + 30, { title: '보고서 (초안)' })
const b = edit(base, T0 + 40, { title: '보고서 (최종)' })
check('같은 칸은 나중에 고친 쪽', mergeTask(a, b).title === '보고서 (최종)' && mergeTask(b, a).title === '보고서 (최종)')

// 3) 같은 시각 — 값으로 정해 양쪽 결과가 같다
const c = edit(base, T0 + 50, { category: '수학' })
const d = edit(base, T0 + 50, { category: '물리' })
check('같은 시각이면 어느 기기에서 합쳐도 같은 값', mergeTask(c, d).category === mergeTask(d, c).category)

// 4) 휴지통 · 되살리기 · 영구 삭제
const trashed = edit(base, T0 + 60, { deletedAt: T0 + 60 })
const restored = edit(trashed, T0 + 70, { deletedAt: null })
check('휴지통으로 보낸 뒤 다른 기기가 되살렸으면 산다', mergeTask(trashed, restored).deletedAt === null)
check('다른 칸을 고친 사이에 지웠으면 지운 것이 남는다', mergeTask(trashed, edit(base, T0 + 55, { memo: '메모' })).deletedAt === T0 + 60)
const purged = { ...trashed, purgedAt: T0 + 80 }
check('영구 삭제는 되살리기보다 강하다', !!mergeTask(purged, restored).purgedAt && !!mergeTask(restored, purged).purgedAt)

// 5) 합쳐도 같은 것은 같다
check('같은 것끼리 합치면 그대로', sameContent(mergeTask(base, base), base))
check('칸 순서가 달라도 같은 내용', sameContent({ ...base, ts: { link: T0, ...base.ts } }, base))

// 6) 파일 읽기 — 어긋난 칸은 비운다
const f = fromTaskFile({ ...toTaskFile(base), due: '내일', time: 9, link: { docId: 'd1', pageId: 'p1' }, ts: { title: 'x', due: T0 } })
check('파일 읽기 — 날짜·시각 모양이 어긋나면 비운다', !!f && f.due === null && f.time === null && f.link?.pageId === 'p1')
check('파일 읽기 — 숫자가 아닌 고친 시각은 버린다', !!f && f.ts.title === undefined && f.ts.due === T0)
check('파일 읽기 — 다른 할 일이거나 할 일이 아니면 null', fromTaskFile(toTaskFile(base), 'other') === null && fromTaskFile({ id: 'x' }) === null && fromTaskFile(null) === null)
check('파일로 갔다 와도 같다', sameContent(fromTaskFile(JSON.parse(JSON.stringify(toTaskFile(purged))))!, purged))

// 7) 올가미로 보낸 그림
const pic = 'data:image/png;base64,AAAA'
const withPic: TaskContent = { ...base, snippet: pic, ts: { ...base.ts, snippet: T0 } }
const oldApp = fromTaskFile({ ...toTaskFile(withPic), snippet: undefined, ts: { ...base.ts }, title: '예전 앱이 고침', updatedAt: T0 + 90 })!
check('그림 칸을 모르는 예전 앱이 다시 올려도 그림이 남는다', mergeTask(withPic, oldApp).snippet === pic && mergeTask(oldApp, withPic).snippet === pic)
check('그림 칸이 없는 할 일은 파일에도 없다', !('snippet' in toTaskFile(base)) && toTaskFile(withPic).snippet === pic)
check('그림이 아니거나 너무 크면 버린다', !fromTaskFile({ ...toTaskFile(base), snippet: 'javascript:x' })?.snippet && !fromTaskFile({ ...toTaskFile(base), snippet: 'data:image/png;base64,' + 'A'.repeat(400_001) })?.snippet)

// 8) 휴지통 기한
const now = Date.now()
check('휴지통 30일', isExpired(now - 31 * 86400_000, now) && !isExpired(now - 29 * 86400_000, now) && !isExpired(null, now))

console.log(`\n할 일 합치기: ${pass}개 통과, ${fail}개 실패`)
if (fail) process.exitCode = 1
else console.log('모든 할 일 합치기 검사 통과 ✓')
