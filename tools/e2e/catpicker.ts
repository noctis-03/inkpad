// 카테고리 지정 창 (ui/library/CategoryPicker)
// 입력 하나로 검색·새로 만들기 · [태그] 묶음 · 지금 값 ✓ · 숨긴 카테고리 경고 · 되돌리기 토스트 · 선택 모드 일괄 지정 · 색 점 없음
import type { Page } from 'playwright'
import { createDoc, device, sleep, type Ctx } from './lib.ts'

const card = (p: Page, title: string) => p.locator('.doc-card', { hasText: title })
const catOf = (p: Page, id: string) => p.evaluate(async (id) => (await (await import('/src/storage/db.ts')).db.documents.get(id))?.category ?? null, id)
const picker = (p: Page) => p.locator('.modal.cp')
/** 목록을 위에서부터 글자로 — 묶음 '▸/▾ 이름', 카테고리 '이름 개수 [✓]' */
const readList = (p: Page) =>
  p.locator('.cp-list > *').evaluateAll((els) =>
    els
      .map((e) => {
        if (e.classList.contains('cp-sep')) return '──'
        if (e.classList.contains('cp-group')) return `${e.getAttribute('aria-expanded') === 'true' ? '▾' : '▸'} ${e.querySelector('.cp-name')?.textContent}`
        const name = e.querySelector('.cp-name')?.textContent?.trim() ?? ''
        const n = e.querySelector('.cp-count')?.textContent?.trim()
        const cur = e.classList.contains('is-current') || e.querySelector('.is-current') ? ' ✓' : ''
        const hid = e.querySelector('.cp-badge') ? ' (숨김)' : ''
        return `${e.classList.contains('is-child') ? '  ' : ''}${name}${hid}${n ? ' ' + n : ''}${cur}`
      })
      .filter(Boolean)
  )
async function openFor(p: Page, title: string) {
  await card(p, title).getByRole('button', { name: '더보기' }).click()
  await p.getByRole('menuitem', { name: '카테고리 지정' }).click()
  await picker(p).waitFor()
}
async function longPress(p: Page, title: string) {
  const b = (await card(p, title).locator('.doc-thumb').boundingBox())!
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await p.mouse.down()
  await sleep(700)
  await p.mouse.up()
  await sleep(250)
}

export default async function catpicker(ctx: Ctx) {
  const { base, check } = ctx
  const A = await device(ctx, { name: 'iPad' })
  const ids: Record<string, string> = {}
  for (const [title, cat] of [
    ['논리회로 1주차', '[과제] 디지털 시스템'],
    ['논리회로 2주차', '[과제] 디지털 시스템'],
    ['중간 범위', '[시험] 디지털 시스템'],
    ['독서 노트', '교양'],
    ['일기', '개인'],
    ['새 노트', null]
  ] as const) {
    ids[title] = await createDoc(A, title)
    if (cat) await A.evaluate(async ([id, category]) => (await import('/src/storage/repo.ts')).updateDocument(id, { category }), [ids[title], cat] as const)
  }
  await A.evaluate(async () => (await import('/src/storage/repo.ts')).setHiddenCategories(['개인']))
  await A.goto(base + '/')
  await card(A, '새 노트').waitFor()

  // ── 열기: 대상 이름, 카테고리 없음(✓) → 구분선 → 묶음(접힘) → [태그] 없는 것, 숨김 표시와 개수 ──
  await openFor(A, '새 노트')
  check('대상 이름이 제목 아래', (await picker(A).locator('.cp-target').first().innerText()) === '새 노트')
  let rows = await readList(A)
  check('목록: 카테고리 없음(지금 값) → 구분선 → 묶음 → [태그] 없는 카테고리(숨김 표시·개수)', JSON.stringify(rows) === JSON.stringify(['카테고리 없음 ✓', '──', '▸ 디지털 시스템', '개인 (숨김) 1', '교양 1']), JSON.stringify(rows))
  check('색 점이 없다 (이름으로 고르는 창)', (await picker(A).locator('.cp-dot, .cp-ring, .cp-swatch, [aria-label$="색 바꾸기"]').count()) === 0)
  check('마우스 기기에서는 입력 칸에 바로', await picker(A).locator('.cp-search input').evaluate((e) => e === document.activeElement))
  await picker(A).getByRole('button', { name: '디지털 시스템' }).click()
  rows = await readList(A)
  check('묶음을 누르면 [태그]들이 들여 써서 펼쳐진다', JSON.stringify(rows.slice(2, 5)) === JSON.stringify(['▾ 디지털 시스템', '  과제 2', '  시험 1']), JSON.stringify(rows))

  // ── 검색: 걸러지고 묶음은 펼친 채로, 같은 이름이 없으면 새로 만들기 ──
  const input = picker(A).locator('.cp-search input')
  await input.fill('과제')
  rows = await readList(A)
  check('검색: 걸러지고 맨 아래에 「새로 만들기」', JSON.stringify(rows) === JSON.stringify(['▾ 디지털 시스템', '  과제 2', '‘과제’ 새로 만들기새 카테고리']), JSON.stringify(rows))
  await input.fill('[과제]디지털 시스템')
  check('띄어쓰기만 다르면 기존 이름을 권한다', (await picker(A).locator('.cp-suggest').innerText()).includes('[과제] 디지털 시스템'))
  await input.fill('[과제] 디지털 시스템')
  check('같은 이름이 있으면 새로 만들기가 없다', (await picker(A).locator('.cp-create').count()) === 0)
  await input.press('Enter')
  await picker(A).waitFor({ state: 'detached' })
  check('Enter: 첫 결과(같은 이름)로 지정하고 닫는다', (await catOf(A, ids['새 노트'])) === '[과제] 디지털 시스템')
  const toast = A.locator('.toast', { hasText: '‘디지털 시스템 · 과제’(으)로 옮겼습니다' })
  await toast.waitFor()
  await toast.getByRole('button', { name: '되돌리기' }).click()
  await sleep(300)
  check('토스트의 되돌리기로 원래 카테고리로', (await catOf(A, ids['새 노트'])) === null)

  // ── 새로 만들기 ──
  await openFor(A, '새 노트')
  check('최근 지정한 카테고리가 칩으로', (await picker(A).locator('.cp-chip').allInnerTexts()).join() === '디지털 시스템 · 과제')
  await picker(A).locator('.cp-search input').fill('  독서   모임 ')
  await picker(A).locator('.cp-create').click()
  await picker(A).waitFor({ state: 'detached' })
  check('새로 만들기: 공백을 정리한 이름으로 지정', (await catOf(A, ids['새 노트'])) === '독서 모임')

  // ── 숨긴 카테고리: 먼저 알린다 ──
  await openFor(A, '새 노트')
  check('열 때 지금 카테고리가 ✓', (await readList(A)).includes('독서 모임 1 ✓'))
  await picker(A).locator('.cp-cat', { hasText: '개인' }).locator('.cp-row').click()
  check('숨긴 카테고리를 고르면 바로 지정하지 않고 알린다', (await picker(A).locator('.cp-confirm').count()) === 1 && (await catOf(A, ids['새 노트'])) === '독서 모임')
  await picker(A).locator('.cp-confirm').getByRole('button', { name: '취소' }).click()
  check('취소하면 알림만 닫힌다', (await picker(A).locator('.cp-confirm').count()) === 0 && (await picker(A).count()) === 1)

  await A.keyboard.press('Escape')
  await picker(A).waitFor({ state: 'detached' })

  // ── 선택 모드: 여러 개에 한 번에 ──
  await longPress(A, '독서 노트')
  await card(A, '논리회로 1주차').click()
  await A.locator('.sel-cat').click()
  await picker(A).waitFor()
  const heads = (await picker(A).locator('.cp-target').allInnerTexts()).join('|')
  check('일괄: 제목은 개수, 지금 값 요약', heads === '2개 항목|지금: 디지털 시스템 · 과제 1 · 교양 1' || heads === '2개 항목|지금: 교양 1 · 디지털 시스템 · 과제 1', heads)
  check('일괄: 일부에만 붙은 카테고리는 n/전체', (await picker(A).locator('.cp-part').allInnerTexts()).sort().join() === '1/2,1/2')
  await picker(A).locator('.cp-row', { hasText: '카테고리 없음' }).click()
  await picker(A).waitFor({ state: 'detached' })
  await A.locator('.toast', { hasText: '2개의' }).waitFor()
  check('일괄: 모두 지정 + 「2개를 …」 토스트', (await catOf(A, ids['독서 노트'])) === null && (await catOf(A, ids['논리회로 1주차'])) === null && (await A.locator('.toast', { hasText: '2개의 카테고리를 해제했습니다' }).count()) === 1, (await A.locator('.toast').allInnerTexts()).join('|'))
  await A.locator('.toast', { hasText: '2개의' }).getByRole('button', { name: '되돌리기' }).click()
  await sleep(300)
  check('일괄 되돌리기: 각자 원래 카테고리로', (await catOf(A, ids['독서 노트'])) === '교양' && (await catOf(A, ids['논리회로 1주차'])) === '[과제] 디지털 시스템')
  await A.locator('.sel-done').click()
}
