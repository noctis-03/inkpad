// Esc로 닫기 — 모든 모달·시트가 같은 규칙(ui/sheetParts.tsx useEscClose)
// 설정·새로 만들기·동기화·스토어 시트가 Esc로 닫히고, 겹치면 맨 위(확인창 → 시트) 하나씩만 닫힌다. ⋯ 메뉴가 떠 있으면 메뉴만 닫힌다
import { createDoc, device, sleep, type Ctx } from './lib.ts'

export default async function esc(ctx: Ctx) {
  const { check } = ctx
  const p = await device(ctx)
  await createDoc(p, '노트')
  await p.reload()
  await p.waitForSelector('.doc-card')
  await sleep(400)
  const count = (sel: string) => p.locator(sel).count()
  const press = async () => {
    await p.keyboard.press('Escape')
    await sleep(250)
  }

  // ── 설정 (전에는 Esc로 닫히지 않았다) ──
  await p.click('[aria-label="설정"]')
  await p.waitForSelector('.sheet[aria-label="설정"]')
  await press()
  check('Esc: 설정 시트가 닫힌다', (await count('.sheet[aria-label="설정"]')) === 0)

  // ── 시트 위 확인창: Esc 한 번에 확인창만, 두 번째에 시트 ──
  await p.click('[aria-label="설정"]')
  await p.waitForSelector('.sheet[aria-label="설정"]')
  await p.evaluate(() => {
    void import('/src/app/dialogs.tsx').then((m) => m.confirmDialog('확인창'))
  })
  await p.waitForSelector('.dialog-host')
  await press()
  check('Esc: 시트 위 확인창만 닫히고 시트는 남는다', (await count('.dialog-host')) === 0 && (await count('.sheet[aria-label="설정"]')) === 1)
  await press()
  check('Esc: 이어서 한 번 더 누르면 시트가 닫힌다', (await count('.sheet[aria-label="설정"]')) === 0)

  // ── 새로 만들기 ──
  await p.click('#new-doc-btn')
  await p.waitForSelector('.sheet[aria-label="새로 만들기"]')
  await press()
  check('Esc: 새로 만들기 시트가 닫힌다', (await count('.sheet[aria-label="새로 만들기"]')) === 0)

  // ── ⋯ 메뉴는 메뉴만, 그다음 연 시트는 시트만 ──
  await p.click('.sync-btn')
  await p.waitForSelector('.menu')
  await press()
  check('Esc: ⋯ 메뉴가 닫힌다', (await count('.menu')) === 0)

  await p.click('.sync-btn')
  await p.getByRole('menuitem', { name: /동기화 관리/ }).click()
  await p.waitForSelector('.sheet[aria-label="동기화"]')
  await press()
  check('Esc: 동기화 시트가 닫힌다 (전에는 닫히지 않음)', (await count('.sheet[aria-label="동기화"]')) === 0)

  await p.click('.sync-btn')
  await p.getByRole('menuitem', { name: /에셋 원본/ }).click()
  await p.waitForSelector('.store-sheet')
  await press()
  check('Esc: 스토어 시트(에셋 원본)가 닫힌다 (전에는 닫히지 않음)', (await count('.store-sheet')) === 0)

  await p.context().close()
}
