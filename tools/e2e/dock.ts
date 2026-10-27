// 탭 바 오른쪽 상태 칸 — 화면을 막던 진행 창 대신, 올리기·받기·가져오기·내보내기를 칸에 보이고
// 누르면 그 자리에서 커져 자세히 본다. 좌우로 넘겨 다른 쪽(동기화·저장 공간)을 본다.
import { createDoc, device, logsOf, sleep, type Ctx } from './lib.ts'
import { createFakeDrive } from './fake-drive.ts'

export default async function dock(ctx: Ctx) {
  const { check } = ctx
  const drive = createFakeDrive()
  const p = await device(ctx, { drive })
  const shot = process.env.DOCK_SHOTS // 눈으로 볼 때만: 스크린샷을 남길 폴더
  const snap = async (name: string) => shot && (await p.screenshot({ path: `${shot}/${name}.png` }))

  await p.waitForSelector('.tabbar .dock')
  check('칸: 탭 바 오른쪽에 늘 있다 (탭이 없어도)', (await p.locator('.tabbar .dock').count()) === 1 && (await p.locator('.tabbar .tab[data-tab]').count()) === 0)
  check('칸: 처음엔 전송 없음', (await p.locator('.dock-page').first().innerText()).includes('전송 없음'))
  check('막는 진행 창이 없다 (store.busy·setBusy 제거)', await p.evaluate(async () => !('setBusy' in (await import('/src/app/store.ts')).useUI.getState())))

  // ── 일이 시작되면 칸에 보인다 ──
  await p.evaluate(async () => {
    const a = await import('/src/shared/activity.ts')
    ;(window as unknown as { act: unknown }).act = a.startActivity('download', '수업 자료.pdf', { detail: '받는 중', progress: 0.25 })
  })
  await sleep(150)
  const line = await p.locator('.dock-page').first().innerText()
  check('칸: 진행 중인 일의 제목과 진행률', line.includes('수업 자료.pdf') && line.includes('25%'), line)
  await snap('1-compact-running')

  // ── 넘기기: 휠·키보드 ──
  const dotOn = () => p.evaluate(() => [...document.querySelectorAll('.dock-dots i')].findIndex((i) => i.classList.contains('is-on')))
  await p.hover('.dock')
  await p.mouse.wheel(0, 60)
  await sleep(600)
  check('넘기기(휠): 다음 쪽(동기화)', (await dotOn()) === 1, String(await dotOn()))
  await snap('2-compact-sync')
  await p.focus('.dock')
  await p.keyboard.press('ArrowRight')
  await sleep(600)
  check('넘기기(→): 그다음 쪽(저장 공간)', (await dotOn()) === 2)
  const storage = await p.locator('.dock-page').nth(2).innerText()
  check('저장 공간 쪽: 사용량을 보인다', /사용/.test(storage), storage)
  await p.keyboard.press('ArrowRight')
  await sleep(600)
  check('넘기기: 끝에서 처음으로 돈다', (await dotOn()) === 0)

  // 마우스로 끌어 넘기기 — 끈 뒤에는 칸이 펼쳐지지 않는다
  const box = (await p.locator('.dock').boundingBox())!
  await p.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2)
  await p.mouse.down()
  await p.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2, { steps: 6 })
  await p.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 6 })
  await p.mouse.up()
  await sleep(700)
  check('넘기기(마우스 끌기): 다음 쪽으로', (await dotOn()) === 1, String(await dotOn()))
  check('…끈 뒤에는 펼치지 않는다', (await p.locator('.dock-panel').count()) === 0)

  // 새 일이 시작되면 전송 쪽으로 돌아온다
  await p.evaluate(async () => {
    const a = await import('/src/shared/activity.ts')
    ;(window as unknown as { act2: unknown }).act2 = a.startActivity('export', '전체 백업.inkpad')
  })
  await sleep(700)
  check('새 일이 시작되면 전송 쪽으로', (await dotOn()) === 0)

  // ── 펼치기: 칸 자리에서 커진다 ──
  const dockBox = (await p.locator('.dock').boundingBox())!
  await p.click('.dock')
  const sizes: { w: number; h: number; x: number; y: number }[] = []
  for (let i = 0; i < 8; i++) {
    const r = await p.evaluate(() => {
      const b = document.querySelector('.dock-panel')?.getBoundingClientRect()
      return b ? { w: b.width, h: b.height, x: b.right, y: b.top } : null
    })
    if (r) sizes.push(r)
    if (i === 2) await snap('3-expanding')
    await sleep(45)
  }
  await sleep(600)
  const final = await p.evaluate(() => {
    const b = document.querySelector('.dock-panel')!.getBoundingClientRect()
    return { w: b.width, h: b.height, x: b.right, y: b.top }
  })
  await snap('4-expanded')
  const first = sizes[0]
  check('펼치기: 칸 크기에서 시작해', !!first && first.w < final.w * 0.75 && first.h < final.h * 0.5, JSON.stringify({ first, dock: dockBox }))
  check('…점점 커져', sizes.some((s) => s.w > first.w + 20 && s.w < final.w - 5), JSON.stringify(sizes.map((s) => Math.round(s.w))))
  check('…창 크기가 된다 (칸 오른쪽 끝·아래)', final.w >= 380 && final.h >= 300 && Math.abs(final.x - (dockBox.x + dockBox.width)) < 2 && final.y > dockBox.y + dockBox.height, JSON.stringify(final))
  check('펼치는 동안 칸은 숨는다', await p.locator('.dock.is-open').count() === 1)
  const rows = await p.locator('.dock-panel .dock-panel-page').first().locator('.dock-row').count()
  check('전송 쪽: 진행 중인 일 2개', rows === 2, String(rows))

  // 끝나면 최근으로 옮겨 간다
  await p.evaluate(() => {
    const w = window as unknown as { act: { done: (d?: string) => void }; act2: { fail: (d?: string) => void } }
    w.act.done('2.4 MB')
    w.act2.fail('저장 공간이 부족합니다')
  })
  await sleep(300)
  const detail = await p.locator('.dock-panel .dock-panel-page').first().innerText()
  check('끝난 일은 최근으로 (결과·실패 문구)', detail.includes('최근') && detail.includes('2.4 MB') && detail.includes('저장 공간이 부족합니다') && !detail.includes('진행 중'), detail)
  await snap('5-expanded-finished')

  // 펼친 창에서 쪽 바꾸기 (위 세그먼트) — 칸도 같은 쪽
  await p.click('.dock-panel .seg [data-indicator-key="sync"]')
  await sleep(500)
  const syncText = await p.locator('.dock-panel .dock-panel-page').nth(1).innerText()
  check('펼친 창: 동기화 쪽', syncText.includes('마지막 올리기'), syncText)
  check('…칸도 같은 쪽', (await dotOn()) === 1)
  await snap('6-expanded-sync')

  // 닫기: Esc → 칸으로 줄어들고 사라진다
  await p.keyboard.press('Escape')
  await sleep(120)
  const mid = await p.evaluate(() => document.querySelector('.dock-panel')?.getBoundingClientRect().width ?? 0)
  await sleep(600)
  check('닫기(Esc): 줄어들며', mid > 0 && mid < final.w, String(mid))
  check('…사라지고 칸이 다시 보인다', (await p.locator('.dock-panel').count()) === 0 && (await p.locator('.dock.is-open').count()) === 0)

  // 실패를 아직 보지 않았으면 빨간 점 — 이미 열어 봤으므로 없다
  check('열어 본 실패에는 빨간 점이 없다', (await p.locator('.dock-alert').count()) === 0)
  await p.evaluate(async () => (await import('/src/shared/activity.ts')).startActivity('upload', '실패할 일').fail('네트워크 오류'))
  await sleep(200)
  check('새 실패는 칸에 빨간 점', (await p.locator('.dock-alert').count()) === 1)

  // 창 밖을 누르면 닫는다
  await p.click('.dock')
  await sleep(600)
  await p.mouse.click(300, 500)
  await sleep(600)
  check('창 밖을 누르면 닫는다', (await p.locator('.dock-panel').count()) === 0)

  // ── 실제 일: 노트 하나 올리기가 칸에 보인다 (화면은 막지 않는다) ──
  await p.evaluate(async () => (await import('/src/shared/activity.ts')).clearFinishedActivities())
  const docId = await createDoc(p, '물리 노트')
  await p.evaluate(async (id) => {
    const s = await import('/src/sync/sync.ts')
    await s.pushOneNote(id)
  }, docId)
  await sleep(200)
  const after = await p.evaluate(async () => (await import('/src/shared/activity.ts')).getActivities().map((a) => `${a.kind}:${a.title}:${a.state}:${a.detail ?? ''}`))
  check('노트 올리기: 제목으로 전송 기록에 남는다', after.some((s) => s.startsWith('upload:물리 노트:done')), JSON.stringify(after))

  // 좁은 화면 — 칸이 줄어도 탭 바를 넘치지 않는다
  await p.setViewportSize({ width: 390, height: 800 })
  await sleep(300)
  const narrow = await p.evaluate(() => {
    const bar = document.querySelector('.tabbar')!.getBoundingClientRect()
    const d = document.querySelector('.dock')!.getBoundingClientRect()
    return { right: d.right, barRight: bar.right, w: d.width }
  })
  check('좁은 화면: 칸이 탭 바 안에', narrow.right <= narrow.barRight && narrow.w <= 120, JSON.stringify(narrow))
  await p.click('.dock')
  await sleep(700)
  const nb = await p.evaluate(() => document.querySelector('.dock-panel')!.getBoundingClientRect().toJSON())
  check('좁은 화면: 펼친 창이 화면 안에', nb.left >= 0 && nb.right <= 390, JSON.stringify(nb))
  await snap('7-narrow-expanded')
  if (shot) {
    await p.emulateMedia({ colorScheme: 'dark' })
    await p.setViewportSize({ width: 1200, height: 900 })
    await sleep(700)
    await snap('8-dark')
  }

  check('칸: 콘솔 오류 없음', !logsOf(p).some((l) => /error|Error/.test(l) && !/favicon|401|Failed to load resource/.test(l)), logsOf(p).join('\n'))
  await p.context().close()
}
