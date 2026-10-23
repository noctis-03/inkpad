// 라이브러리에 파일 끌어 놓기 — "파일 추가"와 같은 길로 나눠 넣는다
//  - 파일을 끌고 들어오면 '여기에 놓아 추가' 표시, 나가면 사라진다 (파일이 아닌 끌기에는 뜨지 않는다)
//  - .zip은 안을 보고 Inkpad 파일이면 가져오기, 일반 zip이면 기타 파일
import { createDoc, device, sleep, type Ctx } from './lib.ts'

export default async function drop(ctx: Ctx) {
  const { check } = ctx
  const p = await device(ctx)
  const docId = await createDoc(p, '보낼 노트')
  await p.reload()
  await p.waitForSelector('.library')

  // 페이지 안에서 파일을 만들어 DataTransfer에 담고 drag 이벤트를 보낸다
  const fire = (type: string, kind: 'files' | 'text' = 'files') =>
    p.evaluate(
      async ([type, kind, docId]) => {
        const w = window as unknown as { __dt?: DataTransfer }
        if (!w.__dt || type === 'dragenter') {
          const dt = new DataTransfer()
          if (kind === 'text') dt.setData('text/plain', '그냥 글')
          else {
            const { zipSync, strToU8 } = await import('/node_modules/fflate/esm/browser.js')
            const { exportInkpad } = await import('/src/io/inkpadFormat.ts')
            dt.items.add(new File([zipSync({ 'a.txt': strToU8('hello') })], '보통.zip', { type: 'application/zip' }))
            dt.items.add(new File([await exportInkpad([docId as string], 'document')], '노트백업.zip', { type: 'application/zip' }))
            dt.items.add(new File(['메모'], '메모.txt', { type: 'text/plain' }))
          }
          w.__dt = dt
        }
        const el = document.querySelector('.library-header')!
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: w.__dt }))
      },
      [type, kind, docId] as const
    )
  const hint = () => p.locator('.lib-drop-hint').count()

  await fire('dragenter', 'text')
  await sleep(100)
  const textHint = await hint()
  await fire('dragleave')
  await fire('dragenter')
  await fire('dragover')
  await sleep(100)
  const shown = await hint()
  await fire('dragleave')
  await sleep(100)
  const gone = await hint()
  check('끌어 놓기: 파일을 끌고 들어오면 표시, 나가면 사라진다 (글 끌기에는 안 뜬다)', textHint === 0 && shown === 1 && gone === 0, JSON.stringify({ textHint, shown, gone }))

  await fire('dragenter')
  await fire('drop')
  await sleep(100)
  const afterDrop = await hint()
  // 기타 파일 2개(보통.zip·메모.txt)는 큰 파일 확인(기본 '무조건')을 거친다
  const choice = p.locator('.dialog-host').getByRole('button', { name: '이 기기에만 추가' })
  await choice.waitFor({ timeout: 8000 }).then(() => choice.click(), () => {})
  let r = { files: [] as string[], docs: 0 }
  for (let i = 0; i < 40; i++) {
    r = await p.evaluate(async () => {
      const { db } = await import('/src/storage/db.ts')
      return { files: (await db.files.toArray()).map((f) => f.name).sort(), docs: (await db.documents.toArray()).filter((d) => !d.deletedAt && d.title === '보낼 노트').length }
    })
    if (r.files.length >= 2 && r.docs >= 2) break
    await sleep(150)
  }
  check('끌어 놓기: 놓으면 표시가 사라진다', afterDrop === 0)
  check('끌어 놓기: 일반 zip은 기타 파일로 (가져오기 실패가 아니다)', r.files.includes('보통.zip') && !r.files.includes('노트백업.zip'), JSON.stringify(r))
  check('끌어 놓기: Inkpad 파일인 zip은 노트로 가져온다', r.docs === 2, JSON.stringify(r))
  check('끌어 놓기: 나머지 파일은 기타 파일로', r.files.includes('메모.txt'), JSON.stringify(r))
  if (process.env.SHOT) {
    await fire('dragenter')
    await sleep(200)
    await p.screenshot({ path: process.env.SHOT })
  }
  await p.context().close()
}
