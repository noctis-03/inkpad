// 카테고리 묶음: 이름이 [묶음]으로 시작하는 카테고리는 사이드바에서 구분선(가운데 묶음 이름) 아래 모인다
import { createDoc, device, sleep, type Ctx } from './lib.ts'

export default async function catgroup(ctx: Ctx) {
  const { base, check } = ctx
  const A = await device(ctx, { name: 'iPad' })
  const cats: [string, string | null][] = [
    ['논리회로 1주차', '[과제] 디지털 시스템'],
    ['논리회로 2주차', '[과제] 디지털 시스템'],
    ['회로 실습 보고서', '[과제]회로 실습'],
    ['중간 정리', '[ 시험 ] 중간고사'],
    ['독서 노트', '교양'],
    ['메모', null]
  ]
  for (const [title, category] of cats) {
    const id = await createDoc(A, title)
    if (category) await A.evaluate(async ([id, category]) => (await import('/src/storage/repo.ts')).updateDocument(id, { category }), [id, category] as const)
  }
  await A.goto(base + '/')
  await A.waitForSelector('.folder-tree .tree-group')
  await sleep(300)
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
        if (el.tagName === 'BUTTON' && el.classList.contains('tree-group')) {
          const open = el.getAttribute('aria-expanded') === 'true'
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
  check('사이드바: 묶음은 접힌 채로 시작(머리글에 안쪽 색 점·묶음 전체 개수) → [묶음] 없는 카테고리 → 미분류', eq(rows, ['▸ 과제 ●● 3', '▸ 시험 ● 1', '교양 1', '미분류 1']), JSON.stringify(rows))
  await A.getByRole('button', { name: '과제 펼치기' }).click()
  await sleep(300)
  rows = await readRows()
  check('묶음 머리글을 누르면 펼친다(앞의 [묶음]은 뗀 이름, 들여 써서 안내선 안에)', eq(rows, ['▾ 과제', '디지털 시스템 2', '회로 실습 1', '▸ 시험 ● 1', '교양 1', '미분류 1']), JSON.stringify(rows))
  await A.reload()
  await A.waitForSelector('.folder-tree .tree-group')
  await sleep(300)
  check('펼친 묶음은 이 기기에 기억된다(다시 열어도 그대로)', eq(await readRows(), rows), JSON.stringify(await readRows()))
  const colors = await A.evaluate(async () => {
    const u = await import('/src/shared/util.ts')
    return [u.categoryColor('[과제] 디지털 시스템'), u.categoryColor('디지털 시스템'), u.categoryColor('[ 시험 ]디지털 시스템'), u.categoryColor('[과제]')]
  })
  check('카테고리 색: 앞의 [묶음]은 빼고 나머지 이름만 본다', colors[0] === colors[1] && colors[1] === colors[2] && colors[3] !== '#64748b', JSON.stringify(colors))
  if (process.env.MERGE_SHOT_DIR) await A.locator('.folder-tree').screenshot({ path: `${process.env.MERGE_SHOT_DIR}/catgroup.png` })

  // 묶음 안 카테고리를 누르면 그 카테고리(원래 이름 그대로)의 노트만
  await A.locator('.folder-tree .tree-item', { hasText: '디지털 시스템' }).click()
  await sleep(400)
  check('묶음 안 카테고리: 누르면 그 카테고리 노트만, 제목은 원래 이름', (await A.locator('.library-title').innerText()).includes('[과제] 디지털 시스템') && (await A.locator('.doc-card').count()) === 2)
  // 보고 있는 카테고리의 묶음을 접으면 선택 칩이 구분선에 앉고, 다시 그 카테고리로 오면 자동으로 펼친다
  await A.getByRole('button', { name: '과제 접기' }).click()
  await sleep(300)
  check('보고 있는 카테고리의 묶음을 접으면 머리글이 선택 표시', (await A.locator('.tree-group.is-active', { hasText: '과제' }).count()) === 1)
  await A.evaluate(() => sessionStorage.setItem('inkpad.section', JSON.stringify({ kind: 'category', name: '[ 시험 ] 중간고사' })))
  await A.reload()
  await A.waitForSelector('.folder-tree .tree-group')
  await sleep(400)
  check('접힌 묶음 안의 카테고리로 오면 그 묶음을 자동으로 펼친다', (await A.getByRole('button', { name: '시험 접기' }).count()) === 1 && (await A.locator('.folder-tree .tree-item.is-active', { hasText: '중간고사' }).count()) === 1)
  await A.context().close()
}
