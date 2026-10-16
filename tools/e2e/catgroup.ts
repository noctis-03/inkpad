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
  // 사이드바의 카테고리 부분을 위에서부터 읽는다: 구분선은 '── 이름 ──', 카테고리는 '이름 개수'
  const rows = await A.evaluate(() => {
    const out: string[] = []
    const tree = document.querySelector('.folder-tree')!
    let on = false
    for (const el of tree.children) {
      if (el.classList.contains('tree-label')) {
        on = el.textContent?.trim().startsWith('카테고리') ?? false
        continue
      }
      if (!on) continue
      if (el.classList.contains('tree-group')) out.push(`── ${el.textContent?.trim() ?? ''} ──`)
      else out.push(`${el.querySelector('.tree-name')?.textContent} ${el.querySelector('.count')?.textContent}`)
    }
    return out
  })
  const want = ['교양 1', '── 과제 ──', '디지털 시스템 2', '회로 실습 1', '── 시험 ──', '중간고사 1', '──  ──', '미분류 1']
  check('사이드바: [묶음] 없는 카테고리 → 묶음마다 구분선 아래(앞의 [묶음]은 뗀 이름) → 닫는 구분선 → 미분류', JSON.stringify(rows) === JSON.stringify(want), JSON.stringify(rows))
  if (process.env.MERGE_SHOT_DIR) await A.locator('.folder-tree').screenshot({ path: `${process.env.MERGE_SHOT_DIR}/catgroup.png` })

  // 묶음 안 카테고리를 누르면 그 카테고리(원래 이름 그대로)의 노트만
  await A.locator('.folder-tree .tree-item', { hasText: '디지털 시스템' }).click()
  await sleep(400)
  check('묶음 안 카테고리: 누르면 그 카테고리 노트만, 제목은 원래 이름', (await A.locator('.library-title').innerText()).includes('[과제] 디지털 시스템') && (await A.locator('.doc-card').count()) === 2)
  await A.context().close()
}
