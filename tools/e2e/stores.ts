// 동기화 원칙: 자동 동기화는 없다 — 네트워크는 사용자가 누른 동작이 직접 일으킬 때만 쓴다.
//  - 앱을 켜고 노트·작업보드를 돌아다니고 필기해도 Drive 요청은 0
//  - 앱·기타 파일·보드 프리셋은 추가·변경하는 그 동작이 곧 '올리기' — 그 항목만 바로 올라가고,
//    오프라인이면 대기로 남아 시트의 '모두 업로드'로 올라간다
//  - appProperties 크기 제한(키+값 124바이트), 클라우드 폴더가 통째로 사라졌을 때 다시 올리기
//  - 카드 미리보기: 파일은 이 기기 원본에서만(받지 않는다), HTML 앱은 늘 아이콘
//  - HTML 앱의 내보내기: 브라우저가 바로 받지 않고 Inkpad가 묻는다 — 기기에 저장 / Inkpad(기타 파일)에 저장
import { createFakeDrive } from './fake-drive.ts'
import { addStroke, createDoc, device, sleep, type Ctx } from './lib.ts'

export default async function stores(ctx: Ctx) {
  const { base, check } = ctx
  const drive = createFakeDrive()
  const p = await device(ctx, { drive, name: 'A' })
  let driveRequests = 0
  p.context().on('request', (r) => {
    if (r.url().includes('googleapis.com')) driveRequests++
  })

  // ── 자동 동기화 없음 ──
  await p.reload()
  await p.waitForSelector('#root *')
  const docId = await createDoc(p, '그냥 노트')
  await addStroke(p, docId, 's1')
  await p.goto(`${base}/#/board`)
  await sleep(800)
  await p.goto(`${base}/#/doc/${docId}`)
  await sleep(1500)
  await p.goto(`${base}/#/`)
  await sleep(800)
  check('원칙: 앱을 켜고 노트·작업보드를 오가며 편집해도 Drive 요청 0', driveRequests === 0, String(driveRequests))

  // ── 앱: 추가하는 그 동작이 곧 올리기 ──
  const LONG_CAT = '아주긴카테고리이름'.repeat(6) // 54자 ≈ 162바이트 — 키와 합쳐 124바이트를 넘는다
  const added = await p.evaluate(async (longCat) => {
    const apps = await import('/src/sync/apps.ts')
    const mk = (t: string) => new File([`<!doctype html><title>${t}</title><p>x</p>`], `${t}.html`, { type: 'text/html' })
    const a = await apps.addApp(mk('계산기'), '도구')
    const b = await apps.addApp(mk('타이머'), longCat)
    return { a: a.app.id, aUp: a.uploaded, b: b.app.id, bUp: b.uploaded }
  }, LONG_CAT)
  const appRemote = (id: string) => [...drive.files.values()].find((f) => f.name === `${id}.html` && !f.trashed)
  check('앱: 추가하면 그 앱만 바로 올라간다', added.aUp && added.bUp && !!appRemote(added.a) && !!appRemote(added.b))
  check('앱: 표식에 제목·카테고리', appRemote(added.a)?.appProperties.title === '계산기' && appRemote(added.a)?.appProperties.category === '도구')
  check('앱: 124바이트를 넘는 카테고리는 표식에서 뺀다(업로드는 성공)', !!appRemote(added.b) && appRemote(added.b)?.appProperties.category === undefined)

  // ── 오프라인이면 대기로 남고, '모두 업로드'로 올라간다 ──
  await p.context().setOffline(true)
  const offline = await p.evaluate(async () => {
    const apps = await import('/src/sync/apps.ts')
    const r = await apps.addApp(new File(['<title>메모장</title>'], '메모장.html', { type: 'text/html' }), null)
    const { db } = await import('/src/storage/db.ts')
    return { id: r.app.id, uploaded: r.uploaded, pending: (await db.apps.toArray()).filter((a) => a.pending).length }
  })
  await p.context().setOffline(false)
  check('오프라인: 추가는 되지만 올라가지 않고 대기 1건', !offline.uploaded && offline.pending === 1 && !appRemote(offline.id))
  // 앱 시트의 '모두 업로드'는 올릴 것(대기·이 기기에만·클라우드에 없음)마다 reuploadApp을 부른다
  const flushed = await p.evaluate(async (id) => {
    const apps = await import('/src/sync/apps.ts')
    const { db } = await import('/src/storage/db.ts')
    const ok = await apps.reuploadApp(id)
    return { ok, left: (await db.apps.toArray()).filter((a) => a.pending).length }
  }, offline.id)
  check("오프라인: '모두 업로드'로 올라가고 대기가 비워진다", flushed.ok && flushed.left === 0 && !!appRemote(offline.id))

  // ── 이미 올린 앱을 오프라인에서 고친 뒤 시트의 '모두 업로드'(= 항목별 reuploadApp) ──
  // 같은 앱의 클라우드 파일이 둘이 되면 다른 기기가 옛 판을 고를 수 있다
  await p.context().setOffline(true)
  await p.evaluate(async (id) => {
    const apps = await import('/src/sync/apps.ts')
    await apps.updateAppHtml(id, new File(['<title>계산기</title><p>v2</p>'], '계산기.html', { type: 'text/html' }))
  }, added.a)
  await p.context().setOffline(false)
  const re = await p.evaluate(async (id) => (await import('/src/sync/apps.ts')).reuploadApp(id), added.a)
  const copies = [...drive.files.values()].filter((f) => f.name === `${added.a}.html` && !f.trashed)
  const latest = copies[0]?.revisions.at(-1)?.content.toString('utf8') ?? ''
  check('다시 올리기: 같은 앱의 클라우드 파일은 하나뿐이고 새 판으로 덮어쓴다', re && copies.length === 1 && latest.includes('v2'), `파일 ${copies.length}개`)

  // ── 기타 파일: '이 기기에만 추가'는 올리지 않고 대기로 남는다 ──
  const files = await p.evaluate(async () => {
    const f = await import('/src/sync/files.ts')
    const up = await f.addFile(new File(['hello'], '메모.txt', { type: 'text/plain' }), null)
    const local = await f.addFile(new File(['local'], '비밀.txt', { type: 'text/plain' }), null, { upload: false })
    const { db } = await import('/src/storage/db.ts')
    const pending = async () => (await db.files.toArray()).filter((x) => x.pending).length
    const pendingBefore = await pending()
    const ok = await f.reuploadFile(local.file.id) // 파일 시트의 '모두 업로드'가 항목마다 부르는 것
    return { upId: up.file.id, up: up.uploaded, localId: local.file.id, localUp: local.uploaded, pendingBefore, n: ok ? 1 : 0, left: await pending() }
  })
  const fileRemote = (id: string) => [...drive.files.values()].find((f) => f.appProperties.fileId === id && !f.trashed)
  check('기타 파일: 추가하면 바로 올라간다', files.up && !!fileRemote(files.upId))
  check("기타 파일: '이 기기에만 추가'는 올라가지 않고 대기로 남는다", !files.localUp && files.pendingBefore === 1)
  check("기타 파일: '모두 업로드'로 그 대기가 올라간다", files.n === 1 && files.left === 0 && !!fileRemote(files.localId))

  // ── 보드 프리셋 ──
  const preset = await p.evaluate(async () => {
    const b = await import('/src/sync/board.ts')
    const pr = await b.createPreset('작업용', { wallpaper: 'plain', snap: true, shortcuts: [], groups: [] })
    return { id: pr.id, up: await b.uploadPreset(pr.id) }
  })
  const presetRemote = [...drive.files.values()].find((f) => f.appProperties.presetId === preset.id && !f.trashed)
  check('보드 프리셋: 저장하면 바로 올라가고 표식에 이름', preset.up && presetRemote?.appProperties.title === '작업용')

  // ── 앱·파일 카드: 동기화 꼬리표 없이, 올라가는 동안만 제목 옆 로딩 고리 ──
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  await p.route('**/*googleapis.com/**', async (r) => {
    await gate // 업로드를 잠시 붙잡아 '올리는 중'을 본다
    await r.fallback()
  })
  await p.goto(`${base}/#/`)
  await p.waitForSelector(`[data-flip-key="file:${files.upId}"]`)
  const card = `[data-flip-key="file:${files.upId}"]`
  const idle = await p.locator(`${card} .item-busy`).count()
  const renaming = p.evaluate(async (id) => (await import('/src/sync/files.ts')).updateFileMeta(id, { title: '메모 2' }), files.upId)
  const spinning = await p.waitForSelector(`${card} .item-busy`, { timeout: 5000 }).then(() => true, () => false)
  release()
  const renamed = await renaming
  const stopped = await p.waitForSelector(`${card} .item-busy`, { state: 'detached', timeout: 5000 }).then(() => true, () => false)
  await p.unroute('**/*googleapis.com/**')
  check('앱·파일 카드: 동기화 꼬리표를 붙이지 않는다', (await p.locator('.app-card .sync-tag, .file-card .sync-tag').count()) === 0)
  check('앱·파일 카드: 올라가는 동안만 제목 옆에 로딩 고리', idle === 0 && spinning && renamed && stopped, JSON.stringify({ idle, spinning, renamed, stopped }))

  // ── 클라우드 앱 폴더가 통째로 사라졌을 때 ──
  for (const f of drive.files.values()) if (f.name === 'apps') f.trashed = true
  const recovered = await p.evaluate(async (id) => {
    const apps = await import('/src/sync/apps.ts')
    const up = await apps.updateAppMeta(id, { title: '계산기 2' }) // 이 동작이 폴더를 다시 만든다
    const { db } = await import('/src/storage/db.ts')
    const pendingIds = async () => (await db.apps.toArray()).filter((a) => a.pending).map((a) => a.id)
    const waiting = await pendingIds() // 나머지 앱은 '다시 올릴 것'으로 돌아간다
    for (const pid of waiting) await apps.reuploadApp(pid) // 앱 시트의 '모두 업로드'
    return { up, pendingAfter: waiting.length, left: (await pendingIds()).length, total: (await apps.listApps()).length }
  }, added.a)
  const newAppsFolder = [...drive.files.values()].find((f) => f.name === 'apps' && !f.trashed)
  const inNew = [...drive.files.values()].filter((f) => f.name.endsWith('.html') && !f.trashed && newAppsFolder && f.parents.includes(newAppsFolder.id))
  check('폴더 재생성: 바꾼 앱은 새 폴더로 바로 올라간다', recovered.up && !!newAppsFolder)
  check('폴더 재생성: 나머지 앱은 지우지 않고 다시 올릴 대기로', recovered.pendingAfter === recovered.total - 1, JSON.stringify(recovered))
  check("폴더 재생성: '모두 업로드'로 앱 전부가 새 폴더에", recovered.left === 0 && inNew.length === recovered.total, `${inNew.length}/${recovered.total}`)

  // ── 앱·파일 카드 미리보기 (로컬 전용) ──
  // 파일: 원본이 이 기기에 있으면 그린다. 원본이 없는(메타만 받은) 파일은 미리보기를 만들려고 받지 않는다
  const before = driveRequests
  const pv = await p.evaluate(async () => {
    const files = await import('/src/sync/files.ts')
    const { db } = await import('/src/storage/db.ts')
    const c = new OffscreenCanvas(300, 200)
    const g = c.getContext('2d')!
    g.fillStyle = '#2a6'
    g.fillRect(0, 0, 300, 200)
    const img = await files.addFile(new File([await c.convertToBlob({ type: 'image/png' })], '사진.png', { type: 'image/png' }), null, { upload: false })
    const now = Date.now()
    await db.files.add({ id: 'metaonly', title: '받지 않은 사진', category: null, name: '받지 않은.png', mime: 'image/png', size: 10, kind: 'image', createdAt: now, updatedAt: now, fileId: 'remote-x' })
    window.dispatchEvent(new Event(files.FILES_EVENT))
    return { img: img.file.id }
  })
  const imgThumb = await p.waitForSelector(`[data-flip-key="file:${pv.img}"] .doc-thumb img`, { timeout: 8000 }).then(() => true, () => false)
  await sleep(800)
  const metaOnly = await p.evaluate(async () => {
    const { db } = await import('/src/storage/db.ts')
    return { blob: !!(await db.files.get('metaonly'))?.blob, thumb: !!(await db.itemThumbs.get('file:metaonly')) }
  })
  const metaIcon = (await p.locator('[data-flip-key="file:metaonly"] .doc-thumb img').count()) === 0
  check('미리보기: 원본이 있는 이미지 파일은 카드에 그림', imgThumb)
  check('미리보기: 원본이 없는 파일은 받지 않고 아이콘', !metaOnly.blob && !metaOnly.thumb && metaIcon && driveRequests === before, JSON.stringify({ ...metaOnly, metaIcon, req: driveRequests - before }))

  // HTML 앱: 미리보기를 만들지 않는다 — 실행해도 카드는 아이콘, 예전에 저장한 앱 미리보기는 지운다
  const appId = await p.evaluate(async () => {
    const apps = await import('/src/sync/apps.ts')
    const { db } = await import('/src/storage/db.ts')
    const html = '<!doctype html><html><head><title>색판</title></head><body style="margin:0;background:#fde"><div style="height:120px;background:#235"></div></body></html>'
    const id = (await apps.addApp(new File([html], '색판.html', { type: 'text/html' }), null)).app.id
    await db.itemThumbs.put({ key: 'app:' + id, blob: new Blob(['x'], { type: 'image/jpeg' }), updatedAt: Date.now() }) // 예전 판이 남긴 것
    return id
  })
  await p.goto(`${base}/#/app/${appId}`)
  await p.waitForSelector('iframe.app-runner-frame')
  await sleep(3000)
  await p.goto(`${base}/#/`)
  await p.waitForSelector(`[data-flip-key="app:${appId}"]`)
  await sleep(800)
  const appIcon = (await p.locator(`[data-flip-key="app:${appId}"] .doc-thumb img`).count()) === 0
  const appThumbLeft = await p.evaluate(async () => (await (await import('/src/storage/db.ts')).db.itemThumbs.toCollection().primaryKeys()).some((k) => String(k).startsWith('app:')))
  check('미리보기: HTML 앱 카드는 실행해도 아이콘, 예전 앱 미리보기는 지운다', appIcon && !appThumbLeft, JSON.stringify({ appIcon, appThumbLeft }))

  // ── HTML 앱의 내보내기 ──
  // a: 붙이지 않은 <a download>를 click()하고 곧바로 revoke · b: showSaveFilePicker · c: inkpad.saveFile · d: 화면에 있는 data: 링크
  const exporter = await p.evaluate(async () => {
    const apps = await import('/src/sync/apps.ts')
    const html = `<!doctype html><html><head><title>내보내기</title></head><body>
<button id="a">a</button><button id="b">b</button><button id="c">c</button><a id="d" href="data:text/plain,DDD" download="d.txt">d</a><pre id="out"></pre>
<script>
var out=document.getElementById('out');function log(t){out.textContent+=t+' '}
document.getElementById('a').onclick=function(){var u=URL.createObjectURL(new Blob(['AAA'],{type:'text/plain'}));var a=document.createElement('a');a.href=u;a.download='a.txt';a.click();URL.revokeObjectURL(u)};
document.getElementById('b').onclick=async function(){try{var h=await showSaveFilePicker({suggestedName:'b.json',types:[{accept:{'application/json':['.json']}}]});var w=await h.createWritable();await w.write('{"b":1}');await w.close();log('b:ok')}catch(e){log('b:'+e.name)}};
document.getElementById('c').onclick=function(){inkpad.saveFile('CCC','c.txt','text/plain').then(function(ok){log('c:'+ok)})};
</script></body></html>`
    return (await apps.addApp(new File([html], '내보내기.html', { type: 'text/html' }), '도구')).app.id
  }, undefined)
  let downloads: string[] = []
  p.on('download', (d) => downloads.push(d.suggestedFilename()))
  await p.goto(`${base}/#/app/${exporter}`)
  const fr = p.frameLocator('iframe.app-runner-frame')
  await fr.locator('#out').waitFor({ state: 'attached' })
  const saveModal = p.locator('.modal', { hasText: '파일 저장' })
  const fileRow = (name: string) =>
    p.evaluate(async (n) => {
      const { db } = await import('/src/storage/db.ts')
      const r = (await db.files.toArray()).find((f) => f.name === n)
      return r ? { text: r.text ?? null, category: r.category, fileId: r.fileId ?? null, pending: r.pending ?? null } : null
    }, name)
  const waitRow = async (name: string) => {
    for (let i = 0; i < 40; i++) {
      const r = await fileRow(name)
      if (r && !r.pending) return r
      await sleep(150)
    }
    return fileRow(name)
  }

  await fr.locator('#a').click()
  await saveModal.waitFor({ timeout: 5000 })
  const asked = (await saveModal.textContent())?.includes('a.txt') ?? false
  await saveModal.getByRole('button', { name: 'Inkpad에 저장' }).click()
  const ra = await waitRow('a.txt')
  check('앱 내보내기: <a download>를 가로채 묻는다(브라우저가 바로 받지 않음)', asked && downloads.length === 0, JSON.stringify(downloads))
  check('앱 내보내기: Inkpad에 저장 → 기타 파일에 추가되고 바로 올라간다 (곧바로 revoke한 blob도)', ra?.text === 'AAA' && !!ra.fileId && ra.category === '도구', JSON.stringify(ra))

  await fr.locator('#b').click()
  await saveModal.waitFor({ timeout: 5000 })
  const dl = p.waitForEvent('download', { timeout: 5000 })
  await saveModal.getByRole('button', { name: '기기에 저장' }).click()
  const got = await dl.then((d) => d.suggestedFilename(), () => '')
  await fr.locator('#out', { hasText: 'b:ok' }).waitFor({ timeout: 5000 }).catch(() => {})
  check('앱 내보내기: showSaveFilePicker → 기기에 저장은 Inkpad가 내려받는다', got === 'b.json' && ((await fr.locator('#out').textContent()) ?? '').includes('b:ok'), got)

  await fr.locator('#c').click()
  await saveModal.waitFor({ timeout: 5000 })
  await saveModal.getByRole('button', { name: '취소' }).click()
  await fr.locator('#out', { hasText: 'c:false' }).waitFor({ timeout: 5000 }).catch(() => {})
  check('앱 내보내기: inkpad.saveFile — 취소하면 앱이 false를 받는다', ((await fr.locator('#out').textContent()) ?? '').includes('c:false') && !(await fileRow('c.txt')))

  downloads = []
  await fr.locator('#d').click()
  await saveModal.waitFor({ timeout: 5000 })
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT })
  await saveModal.getByRole('button', { name: 'Inkpad 이 기기에만' }).click() // 큰 파일 확인(기본 '무조건')을 저장 창에 합쳤다
  await sleep(500)
  const rd = await fileRow('d.txt')
  check('앱 내보내기: 화면의 data: 링크도 가로챈다 · "이 기기에만"은 올리지 않고 대기로', rd?.text === 'DDD' && !rd.fileId && rd.pending === 'upsert' && downloads.length === 0, JSON.stringify({ rd, downloads }))

  await p.context().close()
}
