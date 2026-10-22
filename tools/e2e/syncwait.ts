// 창 밖의 동기화를 기다리기: 편집 화면의 노트 칩(이 노트만 올리기·받기)이나 다른 탭이 동기화 잠금을 쥐고 있는 동안
// 동기화 창은 내용을 가리고 끝나기를 기다린다 — 반쯤 바뀐 목록을 보이지 않고, 잠금에 막혀 아무 일도 안 하는 버튼도 없다.
// 이 창이 시작한 올리기는 기다리지 않는다(평소의 '동기화 중' 표시). 잠금에 막힌 일괄 올리기는 아무 일 없이 끝나지 않고 알린다
import type { Page } from 'playwright'
import { createFakeDrive } from './fake-drive.ts'
import { addStroke, createDoc, device, sleep, type Ctx } from './lib.ts'

/** Drive 요청을 붙잡는 관문 — route는 한 번만 걸고(붙잡힌 요청이 끝나기 전에 풀면 Playwright가 오류) 관문만 바꾼다 */
async function driveGate(p: Page) {
  let gate: Promise<void> = Promise.resolve()
  await p.route('**/*googleapis.com/**', async (r) => {
    await gate
    await r.fallback()
  })
  /** 붙잡는다 — 돌려준 함수를 부르면 풀린다 */
  return () => {
    let release!: () => void
    gate = new Promise<void>((r) => (release = r))
    return release
  }
}

const openSync = async (p: Page) => {
  await p.locator('.sync-btn').click()
  await p.getByRole('menuitem', { name: '동기화 관리' }).click()
}
const closeSync = (p: Page) => p.locator('.sheet[aria-label="동기화"]').getByRole('button', { name: '닫기' }).click()

export default async function syncwait(ctx: Ctx) {
  const { check } = ctx
  const drive = createFakeDrive()
  const p = await device(ctx, { drive, name: 'A' })
  const docId = await createDoc(p, '기다리기')
  await addStroke(p, docId, 's1')
  await p.evaluate(async () => (await import('/src/sync/sync.ts')).pushNow()) // 처음 올리기 — 동기화 설정
  await addStroke(p, docId, 's2') // 올릴 변경
  await p.reload()
  await p.waitForSelector('.doc-card')

  // 창 밖(노트 칩과 같은 경로)에서 이 노트만 올리는 중에 창을 연다
  const hold = await driveGate(p)
  let release = hold()
  await p.evaluate((id) => {
    void import('/src/sync/sync.ts').then((s) => s.pushOneNote(id))
  }, docId)
  await sleep(300)
  await openSync(p)
  const waiting = await p.locator('.sync-wait').waitFor({ timeout: 5000 }).then(() => true, () => false)
  const hidden = (await p.locator('.sync-big').count()) === 0
  check('기다리기: 창 밖에서 올리는 중이면 창 내용을 가리고 기다리게 한다', waiting && hidden, JSON.stringify({ waiting, hidden }))

  // 그 사이 일괄 올리기가 불리면(다른 경로) 아무 일 없이 끝나지 않고 알린다
  await p.evaluate(async () => (await import('/src/sync/sync.ts')).pushNow())
  const told = await p.locator('.toast', { hasText: '다른 곳에서 동기화가 진행 중입니다' }).waitFor({ timeout: 3000 }).then(() => true, () => false)
  check('기다리기: 잠금에 막힌 일괄 올리기는 알린다', told)

  release()
  const back = await p.locator('.sync-big').first().waitFor({ timeout: 10000 }).then(() => true, () => false)
  const gone = (await p.locator('.sync-wait').count()) === 0
  await p.waitForFunction(() => document.querySelector('.sync-big.g-push small')?.textContent === '올릴 것 없음', null, { timeout: 10000 }).catch(() => {})
  const pushSub = await p.locator('.sync-big.g-push small').innerText()
  check('기다리기: 끝나면 창 내용이 돌아오고 목록을 새로 읽는다', back && gone && pushSub === '올릴 것 없음', JSON.stringify({ back, gone, pushSub }))

  // 이 창이 시작한 올리기는 기다리지 않는다 — 평소의 '동기화 중' 상태 카드
  await closeSync(p)
  await addStroke(p, docId, 's3')
  await openSync(p)
  await p.locator('.sync-big.g-push:not([disabled])').waitFor({ timeout: 10000 })
  await p.waitForFunction(() => document.querySelector('.sync-big.g-push small')?.textContent !== '올릴 것 없음', null, { timeout: 10000 }).catch(() => {})
  await p.locator('.sync-big.g-push').click()
  const confirm = p.locator('.modal-backdrop .primary-btn', { hasText: '올리기' }).last()
  const previewShown = await confirm.waitFor({ timeout: 5000 }).then(() => true, () => false)
  release = hold() // 미리보기를 본 뒤 붙잡는다 — 올리는 동안을 본다
  if (previewShown) await confirm.click()
  await sleep(1500)
  const ownWait = await p.locator('.sync-wait').count()
  const ownBusy = await p.locator('.sync-status.tone-syncing').count()
  release()
  check('기다리기: 이 창의 올리기는 가리지 않고 평소처럼 진행 표시', previewShown && ownWait === 0 && ownBusy === 1, JSON.stringify({ previewShown, ownWait, ownBusy }))

  await p.context().close()
}
