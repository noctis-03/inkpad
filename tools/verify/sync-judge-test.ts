/**
 * "이 노트를 받아야 하나" 판정(sync/judge.ts) 회귀 테스트 (의존성 없음)
 *
 * 실행:  node --experimental-strip-types --no-warnings tools/verify/sync-judge-test.ts
 *
 * 배경:
 *  - 받기(pull)·받기 미리보기(planPull)·클라우드 목록(listCloudNotes)이 같은 판정을 따로 들고 있어
 *    미리보기 목록과 실제로 받는 목록이 달랐다 → 판정을 judge.ts 하나로 모았다
 *  - 머지 결과의 updatedAt을 max(양쪽)로 두어, 먼저 올린 기기가 머지 결과를 '이미 맞춰짐'으로 보고 받지 못했다
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isUpToDate, knownBaseMid, mergedUpdatedAt, newestPerDoc, noteSync, pullSkipReason, verNum } from '../../src/sync/judge.ts'
import type { RemoteFile } from '../../src/sync/drive.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SYNC_SRC = readFileSync(join(ROOT, 'src/sync/sync.ts'), 'utf8')

let pass = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) pass++
  else failures.push(`${name}${detail ? ' — ' + detail : ''}`)
}

const remote = (id: string, docId: string | undefined, version: string, updatedAt?: number, modifiedTime = '2026-10-13T00:00:00.000Z'): RemoteFile => ({
  id,
  name: `docs/${docId}.json`,
  modifiedTime,
  version,
  appProperties: { ...(docId ? { docId } : {}), ...(updatedAt ? { updatedAt: String(updatedAt) } : {}) }
})

/* ── J1 · verNum: int64 문자열을 정밀도 손실 없이 ─────────────────── */
check('J1 큰 version 비교', verNum('9007199254740993') > verNum('9007199254740992'))
check('J1 깨진 값은 0', verNum('x') === 0n && verNum(undefined) === 0n)

/* ── J2 · newestPerDoc: 같은 노트 중복 파일은 최신 하나 ───────────── */
{
  const list = newestPerDoc([
    remote('f1', 'D', '5'),
    remote('f2', 'D', '9'),
    remote('f3', 'E', '3', undefined, '2026-10-13T00:00:00.000Z'),
    remote('f4', 'E', '3', undefined, '2026-10-13T01:00:00.000Z'),
    remote('f5', undefined, '99')
  ])
  check('J2 노트당 하나', list.length === 2, list.map((r) => r.id).join())
  check('J2 version이 큰 파일', list.find((r) => r.appProperties?.docId === 'D')?.id === 'f2')
  check('J2 version이 같으면 나중 수정', list.find((r) => r.appProperties?.docId === 'E')?.id === 'f4')
}

/* ── J3 · isUpToDate ─────────────────────────────────────────────── */
{
  const r = remote('f', 'D', '10', 500)
  check('J3 기록 version이 같으면 최신', isUpToDate({ fileId: 'f', version: '10' }, { updatedAt: 1 }, r))
  check('J3 기록이 더 새로우면(인덱스 지연) 최신', isUpToDate({ fileId: 'f', version: '12' }, { updatedAt: 1 }, r))
  check('J3 기록이 낡아도 내용 표식이 같으면 최신', isUpToDate({ fileId: 'f', version: '3' }, { updatedAt: 500 }, r))
  check('J3 둘 다 다르면 받을 것', !isUpToDate({ fileId: 'f', version: '3' }, { updatedAt: 400 }, r))
  check('J3 이 기기에 없는 노트는 받을 것', !isUpToDate(undefined, undefined, r))
  check('J3 원격에 표식이 없으면 내용 비교 안 함', !isUpToDate(undefined, { updatedAt: 0 }, remote('f', 'D', '1')))
  // 폴더 재생성으로 같은 노트의 파일이 새로 만들어지면 version이 다시 시작한다 — 다른 파일의 version은 비교하지 않는다
  check('J3 기록한 파일과 다른 파일이면 version 비교 안 함', !isUpToDate({ fileId: 'old', version: '50' }, { updatedAt: 1 }, r))
}

/* ── J4 · pullSkipReason: 건너뛰는 이유와 순서 ───────────────────── */
{
  const r = remote('f', 'D', '10', 500)
  void r
  const base = { gone: false, hidden: false, local: { updatedAt: 1 }, sync: 'pull' as const }
  check('J4 받는다', pullSkipReason(base) === null)
  check('J4 지운 노트', pullSkipReason({ ...base, gone: true }) === 'gone')
  check('J4 숨긴 카테고리', pullSkipReason({ ...base, hidden: true }) === 'hidden')
  check('J4 휴지통', pullSkipReason({ ...base, local: { updatedAt: 1, deletedAt: 5 } }) === 'trashed')
  check('J4 올리기 대기', pullSkipReason({ ...base, sync: 'push' }) === 'pending')
  check('J4 갈라짐은 덮지 않는다', pullSkipReason({ ...base, sync: 'diverged' }) === 'diverged')
  check('J4 이미 맞춤', pullSkipReason({ ...base, sync: 'same' }) === 'same')
  check('J4 지운 노트가 갈라짐보다 먼저', pullSkipReason({ ...base, gone: true, sync: 'diverged' }) === 'gone')
}

/* ── J7 · noteSync: 브랜치 방식의 상태 판정 (docs/branch-merge.md §3.1) ── */
{
  const s = (pending: boolean, unmerged: boolean, baseMid: string | null, mainMid = 'M1') => noteSync({ pending, unmerged, baseMid, mainMid })
  check('J7 변경 없음 · main 그대로 → 최신', s(false, false, 'M1') === 'same')
  check('J7 변경 없음 · main 바뀜 → 받을 것', s(false, false, 'M0') === 'pull')
  check('J7 변경 있음 · main 그대로 → 올릴 것(ff)', s(true, false, 'M1') === 'push')
  check('J7 변경 있음 · main 바뀜 → 갈라짐', s(true, false, 'M0') === 'diverged')
  check('J7 출발점을 모름 · 변경 있음 → 갈라짐(덮지 않는다)', s(true, false, null) === 'diverged')
  check('J7 출발점을 모름 · 변경 없음 → 받을 것', s(false, false, null) === 'pull')
  // main을 따라가다 다른 기기에게 덮였다: 대기는 내렸지만 내 브랜치가 main에 없다
  check('J7 머지 안 된 내 브랜치 · main 바뀜 → 갈라짐(받기로 덮지 않음)', s(false, true, 'M0') === 'diverged')
  check('J7 머지 안 된 내 브랜치 · main 그대로 → 올릴 것', s(false, true, 'M1') === 'push')
}

/* ── J8 · knownBaseMid: 브랜치 이전에 맞춘 노트의 출발점 ─────────── */
check('J8 브랜치 상태가 있으면 그것', knownBaseMid('B1', false, 'M1') === 'B1')
check('J8 없고 예전 판정으로 맞춰져 있으면 지금 main', knownBaseMid(undefined, true, 'M1') === 'M1')
check('J8 없고 맞춰져 있지 않으면 모름', knownBaseMid(null, false, 'M1') === null)

/* ── J5 · 머지 결과 updatedAt (보고된 버그 재현) ─────────────────── */
{
  // 기기 B가 노트를 고쳐 먼저 올렸다(updatedAt 2000). 기기 A는 그보다 앞서(1000) 고쳐 두었다가 올리며 머지한다.
  const bLocal = { updatedAt: 2000 }
  const aLocal = 1000
  const bRecord = { fileId: 'f', version: '7' } // B가 올린 뒤의 기록
  const oldRule = Math.max(aLocal, bLocal.updatedAt) // 예전: max(양쪽)
  const newRule = mergedUpdatedAt(aLocal, bLocal.updatedAt, 1500) // 기기 A 시계가 B보다 늦어도
  const mergedRemote = (u: number) => remote('f', 'D', '9', u)
  check('J5 예전 규칙이면 B는 머지 결과를 받지 못했다(재현)', isUpToDate(bRecord, bLocal, mergedRemote(oldRule)))
  check('J5 새 규칙이면 B가 머지 결과를 받는다', !isUpToDate(bRecord, bLocal, mergedRemote(newRule)))
  check('J5 새 값은 양쪽보다 크다(시계가 어긋나도)', newRule > aLocal && newRule > bLocal.updatedAt)
  check('J5 시계가 앞서면 지금 시각', mergedUpdatedAt(1000, 2000, 9000) === 9000)
}

/* ── J6 · sync.ts가 판정을 judge.ts 하나로만 한다 ─────────────────── */
check('J6 sync.ts에 판정 복사본(sameByContent) 없음', !/sameByContent/.test(SYNC_SRC))
check('J6 받기와 받기 미리보기가 같은 대상 함수(pullCandidates)를 쓴다', (SYNC_SRC.match(/await pullCandidates\(/g) ?? []).length === 2)
check('J6 받기·클라우드 목록·노트 하나 받기가 같은 판정(judgeNote·newestPerDoc)을 쓴다', (SYNC_SRC.match(/await judgeNote\(/g) ?? []).length === 3 && /newestPerDoc\(remotes\)/.test(SYNC_SRC))
check('J6 자동 머지 없음(브랜치 방식)', !/mergeDocs\(/.test(SYNC_SRC) && !/mergeConfirmHook/.test(SYNC_SRC))

/* ── 리포트 ─────────────────────────────────────────────────────── */
console.log(`\n동기화 판정: ${pass}개 통과, ${failures.length}개 실패`)
if (failures.length) {
  console.log('\n실패 항목:')
  failures.forEach((f) => console.log('  ✗ ' + f))
  process.exitCode = 1
} else {
  console.log('모든 판정 시나리오 통과 ✓')
}
