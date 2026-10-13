// 작업보드 '다시 연결': 끊긴 카드에서 다시 연결을 누르고 서랍에서 항목을 고르면
// 새 카드를 놓지 않고 그 카드가 고른 항목을 가리킨다 (자리는 그대로).
import { createDoc, device, sleep, type Ctx } from './lib.ts'

type Shortcut = { id: string; kind: string; refId: string; gx: number; gy: number; label?: string }
const boardOf = async (p: import('playwright').Page) =>
  JSON.parse((await p.evaluate(() => localStorage.getItem('inkpad.board.v3'))) ?? '{}') as { shortcuts: Shortcut[] }

export default async function board(ctx: Ctx) {
  const { base, check } = ctx
  for (const width of [1200, 700]) {
    const where = width >= 900 ? '넓은 화면(오른쪽 패널)' : '좁은 화면(아래 서랍)'
    const p = await device(ctx)
    await p.setViewportSize({ width, height: 900 })
    const a = await createDoc(p, '가 노트')
    const b = await createDoc(p, '나 노트')
    await p.evaluate(
      ([a]) =>
        localStorage.setItem(
          'inkpad.board.v3',
          JSON.stringify({
            wallpaper: 'mist',
            snap: true,
            groups: [],
            shortcuts: [
              { id: 'here', kind: 'doc', refId: a, gx: 0, gy: 0, label: '가 노트' },
              { id: 'lost', kind: 'doc', refId: 'gone-doc', gx: 2, gy: 1, label: '사라진 노트' }
            ]
          })
        ),
      [a] as const
    )
    await p.goto(base + '/#/board')
    await p.waitForSelector('.board-item.is-missing')
    await p.locator('.board-item.is-missing .board-relink-btn', { hasText: '다시 연결' }).click()
    await sleep(300)
    const title = p.getByText('다시 연결 — 대신 연결할 항목')
    check(`${where}: 다시 연결을 누르면 서랍이 다시 연결 모드로 열린다`, (await title.count()) > 0)
    if (width < 900) check(`${where}: 서랍이 열려 있는 동안 미니맵·줌이 서랍을 덮지 않는다`, (await p.locator('.board-dock').count()) === 0)

    await p.getByRole('button', { name: '나 노트(으)로 다시 연결' }).click()
    await sleep(300)
    const s = (await boardOf(p)).shortcuts
    const lost = s.find((x) => x.id === 'lost')
    check(`${where}: 새 카드를 만들지 않는다`, s.length === 2, `카드 ${s.length}장`)
    check(`${where}: 끊긴 카드가 고른 노트를 가리키고 자리는 그대로`, lost?.refId === b && lost.gx === 2 && lost.gy === 1, JSON.stringify(lost))
    check(`${where}: 끊긴 카드 표시가 사라진다`, (await p.locator('.board-item.is-missing').count()) === 0)
    check(`${where}: 연결하면 다시 연결 모드가 끝난다`, (await title.count()) === 0)

    // 서랍을 닫으면 모드가 남지 않는다 — 다시 열었을 때 평소 서랍
    await p.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('inkpad.board.v3')!)
      raw.shortcuts.push({ id: 'lost2', kind: 'doc', refId: 'gone-2', gx: 4, gy: 0, label: '또 사라진 노트' })
      localStorage.setItem('inkpad.board.v3', JSON.stringify(raw))
    })
    await p.reload()
    await p.waitForSelector('.board-item.is-missing')
    await p.locator('.board-item.is-missing .board-relink-btn', { hasText: '다시 연결' }).click()
    await sleep(200)
    const toggle = p.getByRole('button', { name: '카드 서랍 — 노트·앱·파일' })
    if (width >= 900) await p.getByRole('button', { name: '서랍 닫기' }).click()
    else await toggle.click()
    await sleep(200)
    await toggle.click()
    await sleep(200)
    check(`${where}: 서랍을 닫았다 열면 평소 서랍`, (await title.count()) === 0 && (await p.getByText('카드 서랍').count()) > 0)
    await p.context().close()
  }
}
