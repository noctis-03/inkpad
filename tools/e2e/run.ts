/**
 * 브라우저 시나리오 실행기 — 개발 서버를 띄우고 실제 앱 코드를 Chromium에서 돌린다.
 *
 * 실행:  npm run test:e2e              (처음 한 번: npx playwright install chromium)
 *        npm run test:e2e -- sync      (이름으로 골라 실행: editor · sync · merge · archive · comfort · study · delta · scratch · splash · toolbar · stores · bigfile · idle · board · catgroup · marks · menus · drop · tabs · sendimage · blockgesture · sheets · inputpos · sheetpdf)
 *        PW_CHROMIUM=/path/to/chrome npm run test:e2e   (이미 설치된 다른 Chromium을 쓸 때)
 *
 * 동기화 시나리오는 진짜 Google Drive 대신 가짜 Drive(fake-drive.ts)를 쓴다 — 네트워크·계정 없이 돈다.
 */
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { launch, type Ctx } from './lib.ts'
import editor from './editor.ts'
import sync from './sync.ts'
import merge from './merge.ts'
import archive from './archive.ts'
import comfort from './comfort.ts'
import study from './study.ts'
import delta from './delta.ts'
import scratch from './scratch.ts'
import splash from './splash.ts'
import toolbar from './toolbar.ts'
import bigfile from './bigfile.ts'
import idle from './idle.ts'
import stores from './stores.ts'
import board from './board.ts'
import catgroup from './catgroup.ts'
import marks from './marks.ts'
import noteassets from './noteassets.ts'
import syncwait from './syncwait.ts'
import openpanel from './openpanel.ts'
import menus from './menus.ts'
import drop from './drop.ts'
import tabs from './tabs.ts'
import sendimage from './sendimage.ts'
import blockgesture from './blockgesture.ts'
import inputpos from './inputpos.ts'
import sheetpdf from './sheetpdf.ts'
import sheets from './sheets.ts'

const SCENARIOS: Record<string, (ctx: Ctx) => Promise<void>> = { editor, sync, merge, archive, comfort, study, delta, scratch, splash, toolbar, stores, bigfile, idle, board, catgroup, marks, noteassets, syncwait, openpanel, menus, drop, tabs, sendimage, blockgesture, sheets, inputpos, sheetpdf }

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const picked = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const names = picked.length ? picked : Object.keys(SCENARIOS)
for (const n of names) if (!SCENARIOS[n]) throw new Error(`모르는 시나리오: ${n} (있는 것: ${Object.keys(SCENARIOS).join(', ')})`)

const server = await createServer({ root, logLevel: 'silent', server: { port: 0, host: '127.0.0.1' } })
await server.listen()
const addr = server.httpServer!.address()
const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 5173}`
const browser = await launch()

let pass = 0
const failures: string[] = []
try {
  for (const name of names) {
    console.log(`\n[${name}]`)
    const ctx: Ctx = {
      base,
      browser,
      check(n, cond, detail = '') {
        if (cond) pass++
        else failures.push(`${name} · ${n}${detail ? ' — ' + detail : ''}`)
        console.log(`  ${cond ? '✓' : '✗'} ${n}${!cond && detail ? ' — ' + detail : ''}`)
      }
    }
    try {
      await SCENARIOS[name](ctx)
    } catch (e) {
      failures.push(`${name} · 실행 중 오류 — ${(e as Error).message.split('\n')[0]}`)
      console.log(`  ✗ 실행 중 오류: ${(e as Error).stack}`)
    }
  }
} finally {
  await browser.close()
  await server.close()
}

console.log(`\n브라우저 시나리오: ${pass}개 통과, ${failures.length}개 실패`)
if (failures.length) {
  console.log('\n실패 항목:')
  failures.forEach((f) => console.log('  ✗ ' + f))
  process.exitCode = 1
}
