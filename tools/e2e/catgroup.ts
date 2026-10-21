// 카테고리 묶음: "[태그] 이름" 카테고리는 사이드바에서 뒤쪽 이름 머리글 아래 태그 항목으로 모이고, 머리글을 누르면 태그별로 나눠 전부 보여 준다
import { addStroke, createDoc, device, sleep, type Ctx } from './lib.ts'

export default async function catgroup(ctx: Ctx) {
  const { base, check } = ctx
  const A = await device(ctx, { name: 'iPad' })
  const cats: [string, string | null][] = [
    ['논리회로 1주차', '[과제] 디지털 시스템'],
    ['논리회로 2주차', '[과제] 디지털 시스템'],
    ['중간 범위', '[시험] 디지털 시스템'],
    ['회로 실습 보고서', '[과제]회로 실습'],
    ['중간 정리', '[ 시험 ] 중간고사'],
    ['독서 노트', '교양'],
    ['메모', null]
  ]
  const ids: Record<string, string> = {}
  for (const [title, category] of cats) {
    const id = await createDoc(A, title)
    ids[title] = id
    if (category) await A.evaluate(async ([id, category]) => (await import('/src/storage/repo.ts')).updateDocument(id, { category }), [id, category] as const)
  }
  // 미리보기가 있는 노트 하나 — 처음 보일 때 타일로 맞춰지며 나타난다(tileReveal)
  await addStroke(A, ids['독서 노트'], 's1')
  await A.evaluate(async (id) => (await import('/src/io/docThumb.ts')).regenerateThumbnail(id), ids['독서 노트'])
  await A.goto(base + '/')
  await A.waitForSelector('.folder-tree .tree-group')
  await sleep(300)
  await A.waitForSelector('.doc-thumb img', { state: 'attached' })
  await sleep(1000)
  check('미리보기 타일 등장: 끝나면 타일 캔버스는 걷히고 미리보기가 보인다', (await A.locator('.thumb-tiles').count()) === 0 && (await A.locator('.doc-thumb img.is-revealed').count()) === 1)
  // 사이드바의 카테고리 부분을 위에서부터 읽는다: 묶음은 '▸/▾ 이름 (접히면 개수)', 닫는 구분선은 '──', 카테고리는 '이름 개수'
  const readRows = () =>
    A.evaluate(() => {
      const out: string[] = []
      const tree = document.querySelector('.folder-tree')!
      const els = [...tree.children].flatMap((e) => (e.classList.contains('tree-group-items') ? [...e.children] : [e]))
      let on = false
      for (const el of els) {
        if (el.classList.contains('tree-label')) {
          on = el.textContent?.trim().startsWith('카테고리') ?? false
          continue
        }
        if (!on) continue
        if (el.classList.contains('tree-group')) {
          const open = el.querySelector('.tree-group-toggle')?.getAttribute('aria-expanded') === 'true'
          const cnt = el.querySelector('.count')?.textContent
          const dots = el.querySelectorAll('.tree-group-dots i').length
          out.push(`${open ? '▾' : '▸'} ${el.querySelector('.tree-group-name')?.textContent ?? ''}${dots ? ' ' + '●'.repeat(dots) : ''}${cnt ? ' ' + cnt : ''}`)
        } else if (el.classList.contains('tree-group-end')) continue
        else out.push(`${el.querySelector('.tree-name')?.textContent} ${el.querySelector('.count')?.textContent}`)
      }
      return out
    })
  const eq = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b)
  let rows = await readRows()
  check('사이드바: "[태그] 이름"은 뒤쪽 이름으로 묶여 접힌 채로 시작(머리글에 안쪽 색 점·개수) → [태그] 없는 카테고리 → 미분류', eq(rows, ['▸ 디지털 시스템 ●● 3', '▸ 중간고사 ● 1', '▸ 회로 실습 ● 1', '교양 1', '미분류 1']), JSON.stringify(rows))
  await A.getByRole('button', { name: '디지털 시스템 펼치기' }).click()
  await sleep(300)
  rows = await readRows()
  check('묶음 머리글을 누르면 펼친다(안쪽 항목은 [태그] 이름, 들여 써서 안내선 안에)', eq(rows, ['▾ 디지털 시스템', '과제 2', '시험 1', '▸ 중간고사 ● 1', '▸ 회로 실습 ● 1', '교양 1', '미분류 1']), JSON.stringify(rows))
  await A.reload()
  await A.waitForSelector('.folder-tree .tree-group')
  await sleep(300)
  check('펼친 묶음은 이 기기에 기억된다(다시 열어도 그대로)', eq(await readRows(), rows), JSON.stringify(await readRows()))
  const colors = await A.evaluate(async () => {
    const u = await import('/src/shared/util.ts')
    return [u.categoryColor('[과제] 디지털 시스템'), u.categoryColor('[ 과제 ]회로 실습'), u.categoryColor('과제'), u.categoryColor('[과제]')]
  })
  check('카테고리 색: [태그]가 있으면 태그만 본다(과목이 달라도 [과제]는 같은 색)', colors[0] === colors[1] && colors[1] === colors[2] && colors[3] !== '#64748b', JSON.stringify(colors))
  if (process.env.MERGE_SHOT_DIR) await A.locator('.folder-tree').screenshot({ path: `${process.env.MERGE_SHOT_DIR}/catgroup.png` })

  // 묶음 안 카테고리를 누르면 그 카테고리(원래 이름 그대로)의 노트만
  await A.locator('.folder-tree .tree-group-items .tree-item', { hasText: '과제' }).click()
  await sleep(400)
  check('묶음 안 카테고리: 누르면 그 카테고리 노트만, 제목은 원래 이름', (await A.locator('.library-title').innerText()).includes('[과제] 디지털 시스템') && (await A.locator('.doc-card').count()) === 2)
  // 보고 있는 카테고리의 묶음을 접으면 선택 칩이 구분선에 앉고, 다시 그 카테고리로 오면 자동으로 펼친다
  await A.getByRole('button', { name: '디지털 시스템 접기' }).click()
  await sleep(300)
  check('보고 있는 카테고리의 묶음을 접으면 머리글이 선택 표시', (await A.locator('.tree-group.is-active', { hasText: '디지털 시스템' }).count()) === 1)
  await A.evaluate(() => sessionStorage.setItem('inkpad.section', JSON.stringify({ kind: 'category', name: '[ 시험 ] 중간고사' })))
  await A.reload()
  await A.waitForSelector('.folder-tree .tree-group')
  await sleep(400)
  check('접힌 묶음 안의 카테고리로 오면 그 묶음을 자동으로 펼친다', (await A.getByRole('button', { name: '중간고사 접기' }).count()) === 1 && (await A.locator('.folder-tree .tree-item.is-active', { hasText: '시험' }).count()) === 1)

  // ── 머리글 이름을 누르면 묶음 화면: 태그별 소제목 아래 전부, 소제목을 누르면 그 태그만 ──
  const subheads = () => A.locator('.grid-subhead').evaluateAll((els) => els.map((e) => e.textContent?.replace(/\s+/g, '')))
  check('(앞에서 접어 둔 묶음은 접힌 채)', (await A.getByRole('button', { name: '디지털 시스템 펼치기' }).count()) === 1)
  await A.locator('.tree-group-main', { hasText: '디지털 시스템' }).click()
  await sleep(500)
  check('묶음 화면: 제목은 묶음 이름, 태그별 소제목 아래 전부', (await A.locator('.library-title').innerText()).includes('디지털 시스템') && eq((await subheads()) as string[], ['과제2', '시험1']) && (await A.locator('.doc-card').count()) === 3, JSON.stringify(await subheads()))
  check('묶음 화면: 소제목 순서대로 카드가 놓인다', eq(await A.locator('.doc-grid > *').evaluateAll((els) => els.map((e) => (e.classList.contains('grid-subhead') ? '#' : 'c'))), ['#', 'c', 'c', '#', 'c']))
  check('묶음 화면: 머리글을 누르면 펼치고 선택 표시는 머리글에', (await A.getByRole('button', { name: '디지털 시스템 접기' }).count()) === 1 && (await A.locator('.tree-group.is-active', { hasText: '디지털 시스템' }).count()) === 1)
  await A.getByRole('button', { name: '디지털 시스템 접기' }).click()
  await sleep(200)
  check('화살표는 접고 펴기만 — 화면은 그대로', (await A.locator('.library-title').innerText()).includes('디지털 시스템') && (await A.locator('.grid-subhead').count()) === 2)
  // 한 번 더 누르면 최근 열람 — 태그로 나누지 않고 최근 연 순서
  await A.evaluate((list) => localStorage.setItem('inkpad.recentDocs.v1', JSON.stringify(list.map((id, i) => ({ id, at: Date.now() - i })))), [ids['중간 범위'], ids['논리회로 1주차']])
  await A.locator('.tree-group-main', { hasText: '디지털 시스템' }).click()
  await sleep(500)
  const recentTitles = await A.locator('.doc-card .doc-title').allInnerTexts()
  check('묶음 화면에서 한 번 더 누르면 최근 열람 — 소제목 없이 최근 순', (await A.locator('.grid-subhead').count()) === 0 && eq(recentTitles, ['중간 범위', '논리회로 1주차']), JSON.stringify(recentTitles))
  await A.locator('.tree-group-main', { hasText: '디지털 시스템' }).click() // 다시 묶음 화면
  await sleep(400)
  await A.locator('.grid-subhead', { hasText: '시험' }).getByRole('button').click()
  await sleep(500)
  check('소제목을 누르면 그 태그 카테고리만', (await A.locator('.library-title').innerText()).includes('[시험] 디지털 시스템') && (await A.locator('.doc-card').count()) === 1 && (await A.locator('.grid-subhead').count()) === 0)
  await A.context().close()
}
