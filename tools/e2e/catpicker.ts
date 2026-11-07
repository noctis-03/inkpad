// 카테고리 지정 창 (ui/library/CategoryPicker) + 고른 색 동기화 (sync/categoryColors) — 기기 두 대와 가짜 Drive.
// 입력 하나로 검색·새로 만들기 · [태그] 묶음 · 지금 값 ✓ · 숨긴 카테고리 경고 · 되돌리기 토스트 · 선택 모드 일괄 지정 ·
// 색 점을 눌러 색 고르기(노트는 다시 올리지 않고 파일 하나만) · 받기 때 다른 기기로 퍼진다 · 설정 전에는 네트워크 0
import type { Page } from 'playwright'
import { createFakeDrive } from './fake-drive.ts'
import { createDoc, device, sleep, type Ctx } from './lib.ts'

const card = (p: Page, title: string) => p.locator('.doc-card', { hasText: title })
const catOf = (p: Page, id: string) => p.evaluate(async (id) => (await (await import('/src/storage/db.ts')).db.documents.get(id))?.category ?? null, id)
const colorOf = (p: Page, name: string) => p.evaluate(async (name) => (await import('/src/shared/util.ts')).categoryColor(name), name)
const pull = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pullNow())
const picker = (p: Page) => p.locator('.modal.cp')
/** 목록을 위에서부터 글자로 — 묶음 '▸/▾ 이름', 카테고리 '이름 개수 [✓]' */
const readList = (p: Page) =>
  p.locator('.cp-list > *').evaluateAll((els) =>
    els
      .map((e) => {
        if (e.classList.contains('cp-sep')) return '──'
        if (e.classList.contains('cp-group')) return `${e.getAttribute('aria-expanded') === 'true' ? '▾' : '▸'} ${e.querySelector('.cp-name')?.textContent}`
        if (e.classList.contains('cp-pop')) return '[색]'
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
  const drive = createFakeDrive()
  const A = await device(ctx, { drive, name: 'iPad' })
  let requests = 0
  A.on('request', (r) => {
    if (r.url().includes('googleapis.com')) requests++
  })
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
  check('카테고리 없음은 색 점이 아니라 속이 빈 링', (await picker(A).locator('.cp-ring').count()) === 1)
  check('마우스 기기에서는 입력 칸에 바로', await picker(A).locator('.cp-search input').evaluate((e) => e === document.activeElement))
  await picker(A).getByRole('button', { name: '디지털 시스템' }).click()
  rows = await readList(A)
  check('묶음을 누르면 [태그]들이 들여 써서 펼쳐진다', JSON.stringify(rows.slice(2, 5)) === JSON.stringify(['▾ 디지털 시스템', '  과제 2', '  시험 1']), JSON.stringify(rows))

  // ── 검색: 걸러지고 묶음은 펼친 채로, 같은 이름이 없으면 새로 만들기 ──
  const input = picker(A).locator('.cp-search input')
  await input.fill('과제')
  rows = await readList(A)
  check('검색: 걸러지고 맨 아래에 「새로 만들기」', JSON.stringify(rows) === JSON.stringify(['▾ 디지털 시스템', '  과제 2', '‘과제’ 새로 만들기새 카테고리 · 색은 나중에 바꿀 수 있어요']), JSON.stringify(rows))
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

  // ── 색 점: 그 자리에서 색 고르기 (동기화 설정 전 — 네트워크 0) ──
  const before = await colorOf(A, '교양')
  await picker(A).getByRole('button', { name: '교양 색 바꾸기' }).click()
  check('색 점을 누르면 그 줄 아래에 색 고르기', (await readList(A)).join('|').includes('교양 1|[색]') && (await picker(A).locator('.cp-swatch').count()) === 10)
  const purple = '#7c3aed'
  await picker(A).locator('.cp-swatch[title="보라"]').click()
  await sleep(200)
  check('색을 고르면 바로 바뀐다(창 안·화면 배정)', before !== purple && (await colorOf(A, '교양')) === purple && (await picker(A).locator('.cp-cat', { hasText: '교양' }).locator('.cp-dot').evaluate((e) => getComputedStyle(e).backgroundColor)) === 'rgb(124, 58, 237)')
  check('고른 색에는 ✓, 「자동으로」가 생긴다', (await picker(A).locator('.cp-swatch.is-on[title="보라"]').count()) === 1 && (await picker(A).getByRole('button', { name: '자동으로' }).count()) === 1)
  await A.keyboard.press('Escape')
  await picker(A).waitFor({ state: 'detached' })
  check('사이드바 점도 같은 색', (await A.locator('.folder-tree .tree-item', { hasText: '교양' }).locator('.tree-cat-dot').evaluate((e) => getComputedStyle(e).backgroundColor)) === 'rgb(124, 58, 237)')
  await sleep(1000)
  check('동기화를 설정하기 전에는 색을 골라도 Drive 요청 0', requests === 0, String(requests))

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

  // ── 받기: 고른 색 파일이 올라가고, 다른 기기가 받는다 ──
  await pull(A)
  const colorFile = () => [...drive.files.values()].find((f) => f.name === 'category-colors.json' && !f.trashed)
  const body = () => JSON.parse(colorFile()!.revisions.at(-1)!.content.toString('utf8'))
  check('받기: 고친 색이 Inkpad/category-colors.json 하나로 올라간다', !!colorFile() && body().entries['교양'].color === purple)
  const B = await device(ctx, { drive, name: '휴대폰' })
  check('다른 기기: 받기 전에는 자기 배정', (await colorOf(B, '교양')) !== purple)
  await pull(B)
  check('다른 기기: 받기 끝에 같은 색', (await colorOf(B, '교양')) === purple)

  // ── 설정한 뒤에는 고치면 그 파일 하나만 바로 올라간다 (노트는 다시 올리지 않는다) ──
  const ups = drive.stats.uploads
  await B.evaluate(async () => (await import('/src/storage/categoryColors.ts')).setCategoryColor('[과제] 회로 실습', '#0891b2'))
  for (let i = 0; i < 40 && body().entries['과제']?.color !== '#0891b2'; i++) await sleep(100)
  check('색을 고치면 바로 올라간다 · [태그] 단위', body().entries['과제']?.color === '#0891b2' && body().entries['교양'].color === purple)
  check('올라간 것은 색 파일 하나뿐 (노트 재업로드 없음)', drive.stats.uploads - ups === 1, String(drive.stats.uploads - ups))
  await pull(A)
  check('A가 받으면 과제 묶음 전부 새 색', (await colorOf(A, '[과제] 디지털 시스템')) === '#0891b2' && (await colorOf(A, '[과제] 아무거나')) === '#0891b2')
  // 자동으로 되돌리기도 퍼진다(옛 값이 되살아나지 않는다)
  await A.evaluate(async () => (await import('/src/storage/categoryColors.ts')).setCategoryColor('교양', null))
  for (let i = 0; i < 40 && body().entries['교양'].color !== null; i++) await sleep(100)
  await pull(B)
  check('자동으로 되돌린 것도 다른 기기에 퍼진다', (await colorOf(B, '교양')) !== purple && body().entries['교양'].color === null)
}
