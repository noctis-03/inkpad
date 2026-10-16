// 편집 도구창: [도구] | [색·굵기 3·지금 펜 미리보기] | [되돌리기·다시] ⋯ — 블록·전체 보기·접기는 ⋯ 메뉴.
// 펜↔지우개 전환 버튼은 필기 영역 안(화면 밖으로 잘리지 않는다)
import { createDoc, device, openEditor, sleep, type Ctx } from './lib.ts'

export default async function toolbar(ctx: Ctx) {
  const { base, check } = ctx
  const A = await device(ctx, { name: 'iPad' })
  const D = await createDoc(A, '도구 노트', 2, 'lined')
  await A.setViewportSize({ width: 1366, height: 1024 })
  await openEditor(A, base, D)
  await sleep(600)
  const bar = A.locator('.ft-bar')
  check('바: 굵기는 3개만 바로', (await bar.locator('.ft-wbtn:visible').count()) === 3)
  check('바: 블록·전체 보기·접기 버튼은 바에 없다', (await bar.getByRole('button', { name: /블록 추가|전체 보기|도구 메뉴 접기/ }).count()) === 0)
  check('바: 지금 펜 미리보기', (await bar.locator('.ft-chip .ft-mini').count()) === 1)
  await bar.getByRole('button', { name: '더보기' }).click()
  for (const name of ['블록 추가', '전체 보기', '도구 메뉴 접기']) check(`⋯ 메뉴: ${name}`, (await A.locator('.ft-pop').getByRole('button', { name }).count()) === 1)
  await A.locator('.ft-pop').getByRole('button', { name: '블록 추가' }).click()
  await sleep(300)
  const pop = await A.locator('.ft-pop').boundingBox()
  check('⋯ 메뉴 → 블록 추가: 팔레트가 ⋯ 근처에 뜬다', !!pop && pop.y > 60 && (await A.locator('.ft-pop').innerText()).includes('메모'))
  await A.keyboard.press('Escape')

  // 6단계 굵기 중 바에 없는 굵기를 골라도 바에 보인다
  await bar.getByRole('button', { name: '색상·굵기 더 보기' }).click()
  await A.locator('.ft-pop .ft-wseg button').last().click()
  await A.keyboard.press('Escape')
  await sleep(200)
  check('바: 고른 굵기가 바에 없으면 가까운 자리에 넣어 보인다', (await bar.locator('.ft-wbtn.is-active').count()) === 1 && (await bar.locator('.ft-wbtn:visible').count()) === 3)

  // 펜↔지우개 전환 버튼은 화면 안
  for (const [w, h] of [[1366, 1024], [820, 1180], [390, 844]]) {
    await A.setViewportSize({ width: w, height: h })
    await sleep(300)
    const b = (await A.locator('#quick-switch').boundingBox())!
    check(`전환 버튼: ${w}×${h}에서 화면 안`, b.y + b.height <= h && b.x >= 0, JSON.stringify(b))
  }
  await A.context().close()
}
