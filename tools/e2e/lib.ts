// 브라우저 시나리오 공용 도구. 시나리오는 개발 서버(vite)가 내주는 /src/... 모듈을 페이지 안에서
// 직접 불러 실제 앱 코드를 돌린다 — 그래서 run.ts가 개발 서버를 띄운 뒤 실행한다.
import { chromium, type Browser, type Page } from 'playwright'
import type { FakeDrive } from './fake-drive.ts'

export interface Ctx {
  base: string
  browser: Browser
  check: (name: string, cond: boolean, detail?: string) => void
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const sameSet = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

/** PW_CHROMIUM에 실행 파일 경로를 주면 그 브라우저를 쓴다 (설치된 Playwright 브라우저와 버전이 다를 때) */
export function launch(): Promise<Browser> {
  return chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {})
}

/** 저장소가 따로인 기기 하나 (브라우저 컨텍스트). drive를 주면 가짜 Drive에 붙는다 */
export async function device(ctx: Ctx, opts: { drive?: FakeDrive; name?: string; touch?: boolean } = {}): Promise<Page> {
  const context = await ctx.browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1, hasTouch: opts.touch })
  if (opts.drive) await opts.drive.attach(context)
  const p = await context.newPage()
  const logs: string[] = []
  p.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text())
  })
  ;(p as Page & { logs: string[] }).logs = logs
  await p.goto(ctx.base + '/')
  await p.waitForSelector('#root *')
  await p.evaluate(async (n) => {
    localStorage.setItem('inkpad.installHint', '1')
    if (n) await (await import('/src/sync/token.ts')).setDeviceName(n)
  }, opts.name ?? '')
  return p
}

export const logsOf = (p: Page) => (p as Page & { logs?: string[] }).logs ?? []

export const createDoc = (p: Page, title: string, pages = 1, bg = 'blank') =>
  p.evaluate(
    async ([title, pages, bg]) => {
      const r = await import('/src/storage/repo.ts')
      const m = await import('/src/shared/model.ts')
      const specs = Array.from({ length: pages as number }, () => ({ size: { w: 595.28, h: 841.89 }, background: m.makeBackground(bg as 'blank') }))
      return (await r.createDocument({ title: title as string, mode: 'paged', folderId: null, pages: specs })).id
    },
    [title, pages, bg] as const
  )

/** 첫 페이지에 획 하나를 더해 저장한다 (편집 화면 없이 DB로) */
export async function addStroke(p: Page, docId: string, sid: string) {
  await sleep(15) // updatedAt이 겹치지 않게
  await p.evaluate(
    async ([docId, sid]) => {
      const r = await import('/src/storage/repo.ts')
      const d = await r.loadDocument(docId)
      const pageId = d.pages[0].id
      const els = d.chunks.find((c) => c.pageId === pageId)?.elements ?? []
      const z = els.length + 1
      els.push({ id: sid, type: 'stroke', layer: 'main', z, createdAt: Date.now(), tool: 'pen', color: '#000000ff', width: 2, points: [z * 10, 10, 0.5, 0, z * 10 + 5, 20, 0.5, 16], bbox: [z * 10 - 1, 9, z * 10 + 6, 21], opts: { thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false } })
      await r.saveBatch({ documentId: docId, chunks: [{ pageId, key: '0_0', elements: els }] })
    },
    [docId, sid] as const
  )
}

export const strokes = (p: Page, docId: string) =>
  p.evaluate(async (docId) => {
    const r = await import('/src/storage/repo.ts')
    return (await r.loadDocument(docId)).chunks.flatMap((c) => c.elements.map((e) => e.id)).sort()
  }, docId)

/** 편집 화면을 열고 엔진이 뜰 때까지 기다린다 (window.inkpad는 개발 서버에서만 있다) */
export async function openEditor(p: Page, base: string, docId: string) {
  await p.goto(`${base}/#/doc/${docId}`)
  await p.waitForFunction(() => !!(window as unknown as { inkpad?: unknown }).inkpad && !document.querySelector('.doc-skeleton'), null, { timeout: 15000 })
}

/** 캔버스에 마우스로 획 하나를 긋는다 */
export async function drawStroke(p: Page, dx = 0) {
  const box = (await p.locator('#canvas-root').boundingBox())!
  const x = box.x + box.width / 2 - 100 + dx
  const y = box.y + 250
  await p.mouse.move(x, y)
  await p.mouse.down()
  for (let i = 1; i <= 12; i++) await p.mouse.move(x + i * 8, y + Math.sin(i / 2) * 20)
  await p.mouse.up()
}
