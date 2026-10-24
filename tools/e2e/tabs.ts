// 탭 (크롬처럼 위에 여러 화면) · 듀얼 (옆 칸)
//  - 노트·앱·파일을 열면 탭이 생기고(지금 탭 바로 뒤에), 홈 탭은 라이브러리. 탭 목록은 새로고침해도 남는다
//  - 앱 탭은 숨겨 둔 채 켜 두어 다른 탭에 다녀와도 앱 안의 상태가 남는다 (iframe을 다시 로드하지 않는다)
//  - 다시 켜면 앱은 볼 때 켠다 (탭만 남는다)
//  - 앱·파일을 옆 칸에 띄우고 가운데에서 노트를 본다. 막대로 폭을 바꾸고, 좁은 화면에서는 칸을 숨긴다
import { createDoc, device, logsOf, sleep, type Ctx } from './lib.ts'

export default async function tabs(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  const A = await createDoc(p, '노트 가')
  const B = await createDoc(p, '노트 나')
  const ids = await p.evaluate(async () => {
    const apps = await import('/src/sync/apps.ts')
    const files = await import('/src/sync/files.ts')
    const html = '<!doctype html><title>계산기</title><body><p id="n">0</p><button id="inc" onclick="n.textContent=++window.c||(window.c=1)">+</button></body>'
    const app = (await apps.addApp(new File([html], '계산기.html', { type: 'text/html' }), null)).app.id
    const file = (await files.addFile(new File(['참고 자료 내용'], '자료.txt', { type: 'text/plain' }), null, { upload: false })).file.id
    return { app, file }
  })
  const go = (r: object) => p.evaluate(async (r) => (await import('/src/app/store.ts')).useUI.getState().navigate(r as never), r)
  const tabKeys = () => p.locator('.tabbar .tab[data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab))
  const active = () => p.locator('.tabbar .tab.is-active').getAttribute('data-tab')
  const appFrame = async () => (await p.$('.pane:not(.pane-hidden) iframe.app-runner-frame'))?.contentFrame()

  // ── 탭 ──
  const noBar = (await p.locator('.tabbar').count()) === 0
  await go({ name: 'editor', docId: A })
  await p.waitForSelector('.pane-main .editor')
  await go({ name: 'library' })
  await go({ name: 'editor', docId: B })
  await p.waitForSelector('.pane-main .editor')
  await go({ name: 'editor', docId: A })
  await go({ name: 'app', appId: ids.app }) // A 바로 뒤에
  await p.waitForSelector('.pane-main iframe.app-runner-frame')
  await sleep(300)
  check('탭: 연 것이 없으면 탭 바를 그리지 않는다', noBar)
  check('탭: 연 노트·앱이 탭으로 — 새 탭은 지금 탭 바로 뒤에', JSON.stringify(await tabKeys()) === JSON.stringify([`doc:${A}`, `app:${ids.app}`, `doc:${B}`]), JSON.stringify(await tabKeys()))
  await p.waitForFunction(() => document.querySelector('.tabbar .tab.is-active .tab-title')?.textContent === '계산기')
  check('탭: 제목을 보여 주고 지금 탭을 표시', (await active()) === `app:${ids.app}`)

  // 앱·파일 화면 머리는 노트 머리와 같은 높이
  const barH = (sel: string) => p.locator(sel).evaluate((e) => e.getBoundingClientRect().height)
  const barLook = (sel: string) => p.locator(sel).evaluate((e) => { const cs = getComputedStyle(e); return `${cs.backgroundColor} / ${cs.borderBottomColor}` })
  const appBarH = await barH('.pane-main .app-runner-bar')
  const appLook = await barLook('.pane-main .app-runner-bar')

  // 앱 안의 상태가 남는다
  let fr = await appFrame()
  await fr!.click('#inc')
  await fr!.click('#inc')
  await fr!.evaluate(() => ((window as unknown as { mark: number }).mark = 7))
  await p.click(`.tabbar .tab[data-tab="doc:${B}"]`)
  await p.waitForSelector('.pane-main .editor')
  await sleep(400) // 노트 열림 애니메이션(살짝 축소)이 끝난 뒤에 잰다
  const docBarH = await barH('.pane-main .toolbar-doc')
  check('머리 높이: 앱 화면 머리 = 노트 머리', Math.abs(appBarH - docBarH) < 0.5, JSON.stringify({ appBarH, docBarH }))
  const docLook = await barLook('.pane-main .toolbar-doc')
  check('머리 색: 앱 화면 머리 바탕·선 = 노트 머리', appLook === docLook, JSON.stringify({ appLook, docLook }))
  const hiddenApp = (await p.locator('.pane-hidden iframe.app-runner-frame').count()) === 1
  await p.click(`.tabbar .tab[data-tab="app:${ids.app}"]`)
  await sleep(200)
  fr = await appFrame()
  const kept = await fr!.evaluate(() => ({ n: document.getElementById('n')!.textContent, mark: (window as unknown as { mark?: number }).mark }))
  check('탭: 다른 탭을 보는 동안 앱은 숨겨 둔 채 켜 둔다', hiddenApp)
  check('탭: 돌아오면 앱 안의 상태가 그대로 (다시 로드하지 않는다)', kept.n === '2' && kept.mark === 7, JSON.stringify(kept))

  // 홈 탭
  await p.click('.tabbar .tab-home')
  await p.waitForSelector('.pane-main .library')
  check('탭: 홈 탭은 라이브러리 (탭은 그대로)', (await tabKeys()).length === 3 && (await active()) === null)

  // 새로고침해도 남고, 앱은 볼 때 켠다
  await go({ name: 'editor', docId: A })
  await p.waitForSelector('.pane-main .editor')
  await p.reload()
  await p.waitForSelector('.pane-main .editor')
  await sleep(500)
  const restored = await tabKeys()
  const lazy = (await p.locator('iframe.app-runner-frame').count()) === 0
  check('탭: 새로고침해도 탭이 남는다', restored.length === 3 && (await active()) === `doc:${A}`, JSON.stringify(restored))
  check('탭: 다시 켜면 앱은 볼 때 켠다', lazy)

  // ── 듀얼: 옆 칸 ──
  await p.click(`.tabbar .tab[data-tab="app:${ids.app}"]`)
  await p.waitForSelector('.pane-main iframe.app-runner-frame')
  fr = await appFrame()
  await fr!.evaluate(() => ((window as unknown as { mark: number }).mark = 9))
  await p.click('.pane-main [aria-label="옆 칸에 띄우기"]')
  await p.waitForSelector('.panes.is-split .pane-side iframe.app-runner-frame')
  await p.waitForSelector('.pane-main .editor')
  await sleep(300)
  const sideFrame = await (await p.$('.pane-side iframe.app-runner-frame'))!.contentFrame()
  const sideMark = await sideFrame!.evaluate(() => (window as unknown as { mark?: number }).mark)
  const backTo = await active()
  check('듀얼: 앱을 옆 칸에 — 가운데에는 그 전에 보던 노트', backTo === `doc:${A}`, String(backTo))
  check('듀얼: 옆 칸으로 옮겨도 앱을 다시 로드하지 않는다', sideMark === 9, String(sideMark))
  check('듀얼: 옆 칸 탭에 표시', (await p.locator(`.tabbar .tab.is-side[data-tab="app:${ids.app}"]`).count()) === 1)

  // 막대로 폭 바꾸기 — 가운데 노트 화면도 따라 줄어든다
  const W = 1200
  const d = (await p.locator('.split-divider').boundingBox())!
  await p.mouse.move(d.x + d.width / 2, d.y + d.height / 2)
  await p.mouse.down()
  await p.mouse.move(W * 0.45, d.y + d.height / 2, { steps: 8 })
  await p.mouse.up()
  await sleep(400)
  const mainW = (await p.locator('.pane-main').boundingBox())!.width
  const canvasW = await p.locator('.pane-main .editor-area').evaluate((e) => e.getBoundingClientRect().width)
  const ratio = await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().splitRatio)
  check('듀얼: 막대를 끌어 폭을 바꾼다', Math.abs(ratio - 0.45) < 0.02 && Math.abs(mainW - W * 0.45) < 12, JSON.stringify({ ratio, mainW }))
  check('듀얼: 가운데 노트 화면이 칸 폭에 맞춘다', canvasW <= mainW + 1, JSON.stringify({ canvasW, mainW }))

  // 좌우 바꾸기 — 옆 칸이 왼쪽으로, 폭은 그대로, 앱은 다시 로드하지 않는다
  await p.click('.pane-side [aria-label="좌우 바꾸기"]')
  await sleep(300)
  const sw = { side: (await p.locator('.pane-side').boundingBox())!, main: (await p.locator('.pane-main').boundingBox())! }
  const swMark = await sideFrame!.evaluate(() => (window as unknown as { mark?: number }).mark)
  check('좌우 바꾸기: 옆 칸이 왼쪽으로 — 가운데 칸 폭은 그대로', sw.side.x < sw.main.x && Math.abs(sw.main.width - W * 0.45) < 12, JSON.stringify(sw))
  check('좌우 바꾸기: 앱을 다시 로드하지 않는다', swMark === 9, String(swMark))
  // 왼쪽에 있어도 막대는 끈 쪽으로 움직인다 (비율은 가운데 칸 몫)
  const d2 = (await p.locator('.split-divider').boundingBox())!
  await p.mouse.move(d2.x + d2.width / 2, d2.y + d2.height / 2)
  await p.mouse.down()
  await p.mouse.move(W * 0.35, d2.y + d2.height / 2, { steps: 8 })
  await p.mouse.up()
  await sleep(300)
  const sideW = (await p.locator('.pane-side').boundingBox())!.width
  check('좌우 바꾸기: 왼쪽 칸에서도 막대를 끈 곳이 칸 경계', Math.abs(sideW - W * 0.35) < 12, JSON.stringify({ sideW }))
  await p.reload()
  await p.waitForSelector('.panes.is-split.side-left .pane-side iframe')
  check('좌우 바꾸기: 새로고침해도 기억한다', true)
  await p.click('.pane-side [aria-label="좌우 바꾸기"]')
  await sleep(200)
  check('좌우 바꾸기: 다시 누르면 오른쪽으로', (await p.locator('.panes.is-split.side-left').count()) === 0 && (await p.locator('.panes.is-split').count()) === 1)

  // 가운데 탭을 바꿔도 옆 칸은 그대로
  await p.click(`.tabbar .tab[data-tab="doc:${B}"]`)
  await sleep(300)
  check('듀얼: 가운데 탭을 바꿔도 옆 칸은 그대로', (await active()) === `doc:${B}` && (await p.locator('.pane-side iframe.app-runner-frame').count()) === 1)

  // 파일도 옆 칸에 (탭 메뉴에서) — 앱 대신
  await go({ name: 'file', fileId: ids.file })
  await p.waitForSelector('.pane-main .file-runner')
  const fileBarH = await barH('.pane-main .file-runner .app-runner-bar')
  check('머리 높이: 파일 화면 머리 = 노트 머리', Math.abs(fileBarH - docBarH) < 0.5, JSON.stringify({ fileBarH, docBarH }))
  const fileLook = await barLook('.pane-main .file-runner .app-runner-bar')
  check('머리 색: 파일 화면 머리 바탕·선 = 노트 머리', fileLook === docLook, JSON.stringify({ fileLook, docLook }))
  await go({ name: 'editor', docId: B })
  await p.click(`.tabbar .tab[data-tab="file:${ids.file}"]`, { button: 'right' })
  await p.locator('.menu').getByRole('menuitem', { name: '옆 칸에 열기' }).click()
  await p.waitForSelector('.pane-side .file-runner')
  const fileSide = ((await p.locator('.pane-side .file-text').textContent()) ?? '').includes('참고 자료')
  const appHidden = (await p.locator('.pane-hidden iframe.app-runner-frame').count()) === 1
  check('듀얼: 탭 메뉴로 파일을 옆 칸에 — 앱은 숨겨 둔 채 켜 둔다', fileSide && appHidden && (await active()) === `doc:${B}`)

  // 옆 칸 → 가운데로
  await p.click('.pane-side [aria-label="가운데로"]')
  await p.waitForSelector('.pane-main .file-runner')
  check('듀얼: 가운데로 — 칸을 닫고 가운데에서 본다', (await p.locator('.panes.is-split').count()) === 0 && (await active()) === `file:${ids.file}`)

  // 좁은 화면에서는 칸을 숨기고 띄우기 버튼도 내지 않는다
  await p.click(`.tabbar .tab[data-tab="app:${ids.app}"]`)
  await p.click('.pane-main [aria-label="옆 칸에 띄우기"]')
  await p.waitForSelector('.panes.is-split')
  await p.setViewportSize({ width: 640, height: 900 })
  await sleep(300)
  const narrow = (await p.locator('.panes.is-split').count()) === 0 && (await p.locator('.pane-side').count()) === 0
  await p.setViewportSize({ width: 1200, height: 900 })
  await sleep(300)
  const wideAgain = (await p.locator('.panes.is-split .pane-side iframe').count()) === 1
  check('듀얼: 좁은 화면에서는 옆 칸을 숨기고, 넓어지면 다시', narrow && wideAgain, JSON.stringify({ narrow, wideAgain }))

  // 옆 칸 닫기 — 탭은 남는다
  await p.click('.pane-side [aria-label="옆 칸 닫기"]')
  await sleep(200)
  check('듀얼: 옆 칸을 닫아도 탭은 남는다', (await p.locator('.panes.is-split').count()) === 0 && (await tabKeys()).includes(`app:${ids.app}`))
  if (process.env.SHOT) {
    await p.click('.pane-main [aria-label="옆 칸에 띄우기"]').catch(() => {})
    await go({ name: 'editor', docId: A })
    await sleep(600)
    await p.screenshot({ path: process.env.SHOT })
  }

  // ── 탭 닫기 ──
  await go({ name: 'editor', docId: A })
  await p.waitForSelector('.pane-main .editor')
  const before = await tabKeys()
  const at = before.indexOf(`doc:${A}`)
  await p.click(`.tabbar .tab[data-tab="doc:${A}"] .tab-close`)
  await sleep(300)
  const after = await tabKeys()
  check('탭 닫기: 보던 탭을 닫으면 오른쪽 이웃으로', !after.includes(`doc:${A}`) && (await active()) === (before[at + 1] ?? before[at - 1] ?? null), JSON.stringify({ before, after, active: await active() }))
  for (const k of await tabKeys()) await p.click(`.tabbar .tab[data-tab="${k}"] .tab-close`)
  await sleep(300)
  check('탭 닫기: 다 닫으면 탭 바가 사라지고 라이브러리', (await p.locator('.tabbar').count()) === 0 && (await p.locator('.pane-main .library').count()) === 1)

  // ── 머리의 뒤로 = 지금 탭을 닫고 홈으로 (다른 탭으로 옮겨 가지 않는다) ──
  const T = await p.evaluate(async () => (await (await import('/src/storage/repo.ts')).createDocument({ title: '문서 다', mode: 'text', folderId: null, pages: [] })).id)
  await go({ name: 'editor', docId: A })
  await go({ name: 'app', appId: ids.app })
  await go({ name: 'file', fileId: ids.file })
  await go({ name: 'editor', docId: T })
  await go({ name: 'editor', docId: A })
  await p.waitForSelector('.pane-main .editor:not(.text-editor)')
  const backTabs = await tabKeys()
  await p.locator('.pane-main').getByRole('button', { name: '문서 목록' }).click()
  await p.waitForSelector('.pane-main .library')
  const k1 = await tabKeys()
  check('뒤로(노트): 그 탭을 닫고 홈(라이브러리)으로, 다른 탭은 그대로', backTabs.length === 4 && !k1.includes(`doc:${A}`) && k1.length === 3 && (await active()) === null, JSON.stringify({ backTabs, k1 }))
  await p.click(`.tabbar .tab[data-tab="app:${ids.app}"]`)
  await p.waitForSelector('.pane-main iframe.app-runner-frame')
  await p.click('.pane-main [aria-label="뒤로"]')
  await p.waitForSelector('.pane-main .library')
  check('뒤로(앱): 앱 탭을 닫고 홈으로', !(await tabKeys()).includes(`app:${ids.app}`) && (await active()) === null && (await p.locator('iframe.app-runner-frame').count()) === 0, JSON.stringify(await tabKeys()))
  await p.click(`.tabbar .tab[data-tab="doc:${T}"]`)
  await p.waitForSelector('.pane-main .text-editor .tdoc-blocks')
  await p.locator('.pane-main').getByRole('button', { name: '문서 목록' }).click()
  await p.waitForSelector('.pane-main .library')
  check('뒤로(문서): 문서 탭을 닫고 홈으로', !(await tabKeys()).includes(`doc:${T}`) && (await active()) === null, JSON.stringify(await tabKeys()))
  // 작업보드가 홈이면 작업보드로
  await go({ name: 'board' })
  await go({ name: 'editor', docId: A })
  await p.waitForSelector('.pane-main .editor:not(.text-editor)')
  await p.locator('.pane-main').getByRole('button', { name: '문서 목록' }).click()
  await p.waitForSelector('.pane-main .board', { timeout: 5000 }).catch(() => {})
  check('뒤로: 홈이 작업보드면 작업보드로', (await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().route.name)) === 'board' && !(await tabKeys()).includes(`doc:${A}`))
  await p.click(`.tabbar .tab[data-tab="file:${ids.file}"]`)
  await p.waitForSelector('.pane-main .file-runner')
  await p.click('.pane-main [aria-label="뒤로"]')
  await sleep(300)
  check('뒤로(파일): 마지막 탭을 닫으면 탭 바가 사라진다', (await p.locator('.tabbar').count()) === 0)
  await go({ name: 'library' })

  // 지워진 노트의 탭은 닫힌다
  await go({ name: 'editor', docId: B })
  await go({ name: 'library' })
  await p.evaluate(async (id) => {
    const repo = await import('/src/storage/repo.ts')
    await repo.trashDocument(id)
  }, B)
  await go({ name: 'board' })
  await sleep(400)
  check('탭: 휴지통으로 보낸 노트의 탭은 닫힌다', !(await tabKeys()).includes(`doc:${B}`), JSON.stringify(await tabKeys()))

  check('탭·듀얼: 콘솔 오류 없음', !logsOf(p).some((l) => /error|Error/.test(l) && !/favicon|Failed to load resource|클라우드 반영 실패/.test(l)), logsOf(p).join(' | ').slice(0, 300))
  void base
  await p.context().close()
}
