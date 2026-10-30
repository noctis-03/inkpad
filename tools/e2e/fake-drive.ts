/**
 * 테스트용 가짜 Google Drive — Playwright route로 브라우저의 Drive API 요청을 가로챈다.
 * 이 앱이 쓰는 API만 흉내 낸다: 파일 목록·메타·내려받기, multipart·이어 올리기(resumable) 업로드,
 * 리비전(목록·고정·내려받기·삭제), 폴더 만들기, 휴지통, appProperties 검색.
 * 실패 주입: fail.nextDocUpload(노트 main 파일 덮어쓰기 한 번 403), fail.abortChunk(n번째 이어 올리기 조각에서 연결 끊기),
 *           fail.download(이 파일 id의 내려받기 500), fail.revisionList(이 파일 id의 리비전 목록 500).
 */
import { gunzipSync } from 'node:zlib'
import type { BrowserContext, Request, Route } from 'playwright'

interface Revision {
  id: string
  content: Buffer
  modifiedTime: string
  keepForever: boolean
}
interface FakeFile {
  id: string
  name: string
  mimeType: string
  parents: string[]
  appProperties: Record<string, string>
  trashed: boolean
  version: number
  revisions: Revision[]
  created?: string
}
interface Session {
  metadata: { name?: string; mimeType?: string; parents?: string[]; appProperties?: Record<string, string> }
  fileId?: string
  size: number
  parts: Buffer[]
  received: number
}

export function createFakeDrive() {
  const files = new Map<string, FakeFile>()
  const sessions = new Map<string, Session>()
  const fail = { nextDocUpload: false, abortChunk: 0, download: new Set<string>(), revisionList: new Set<string>() }
  /** upBytes·downBytes: 노트 파일·조각을 오간 본문 바이트 (multipart 업로드 본문 · alt=media 내려받기) */
  const stats = { chunkPuts: 0, uploadedBytes: 0, aborted: 0, statusQueries: 0, upBytes: 0, downBytes: 0, uploads: 0, downloads: 0, listedFiles: 0 }
  let chunkSeen = 0
  let seq = 0
  let clock = Date.parse('2026-10-13T00:00:00Z')
  const now = () => new Date((clock += 1000)).toISOString()
  const newId = (p: string) => `${p}${(++seq).toString(36).padStart(6, '0')}`
  const head = (f: FakeFile) => f.revisions[f.revisions.length - 1]
  const meta = (f: FakeFile) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    parents: f.parents,
    modifiedTime: head(f)?.modifiedTime ?? f.created,
    version: String(f.version),
    size: head(f) ? String(head(f).content.length) : undefined,
    appProperties: f.appProperties,
    trashed: f.trashed
  })

  function matches(f: FakeFile, q: string) {
    let ok = true
    const parent = /'([^']+)' in parents/.exec(q)
    ok = ok && (parent ? f.parents.includes(parent[1]) : f.parents.length === 0)
    if (/trashed=false/.test(q)) ok = ok && !f.trashed
    if (/trashed=true/.test(q)) ok = ok && f.trashed
    const name = /name=("(?:[^"\\]|\\.)*")/.exec(q)
    if (name) ok = ok && f.name === JSON.parse(name[1])
    const mime = /mimeType='([^']+)'/.exec(q)
    if (mime) ok = ok && f.mimeType === mime[1]
    for (const m of q.matchAll(/appProperties has \{ key='([^']+)' and value='([^']*)' \}/g)) ok = ok && f.appProperties?.[m[1]] === m[2]
    const after = /modifiedTime > '([^']+)'/.exec(q)
    if (after) ok = ok && Date.parse(head(f)?.modifiedTime ?? f.created ?? '') > Date.parse(after[1])
    return ok
  }

  function parseMultipart(buf: Buffer, contentType: string) {
    const boundary = /boundary=([^;]+)/.exec(contentType)![1]
    const sep = Buffer.from(`--${boundary}`)
    const parts: Buffer[] = []
    let i = buf.indexOf(sep)
    while (i >= 0) {
      const start = i + sep.length
      const next = buf.indexOf(sep, start)
      if (next < 0) break
      let part = buf.subarray(start, next)
      if (part.subarray(0, 2).toString() === '\r\n') part = part.subarray(2)
      let body = part.subarray(part.indexOf('\r\n\r\n') + 4)
      if (body.subarray(body.length - 2).toString() === '\r\n') body = body.subarray(0, body.length - 2)
      parts.push(body)
      i = next
    }
    return { metadata: JSON.parse(parts[0].toString('utf8')), content: Buffer.from(parts[1]) }
  }

  const cors = (req: Request | null) => ({
    'Access-Control-Allow-Origin': req?.headers()['origin'] || '*',
    'Access-Control-Expose-Headers': 'Location, Range',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  })
  const json = (route: Route, req: Request | null, status: number, body: unknown, extra: Record<string, string> = {}) =>
    route.fulfill({ status, contentType: 'application/json', headers: { ...cors(req), ...extra }, body: JSON.stringify(body) })

  async function handleResumable(route: Route, req: Request, url: URL, path: string) {
    const sid = url.searchParams.get('upload_id')
    if (!sid) {
      const fid = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(path)?.[1]
      const id = newId('u')
      sessions.set(id, { metadata: JSON.parse(req.postData() || '{}'), fileId: fid, size: Number(req.headers()['x-upload-content-length']), parts: [], received: 0 })
      return route.fulfill({ status: 200, headers: { ...cors(req), Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${id}` }, body: '' })
    }
    const ses = sessions.get(sid)
    if (!ses) return json(route, req, 404, { error: 'no session' })
    const cr = req.headers()['content-range'] || ''
    const range308 = () => route.fulfill({ status: 308, headers: { ...cors(req), ...(ses.received ? { Range: `bytes=0-${ses.received - 1}` } : {}) }, body: '' })
    if (/^bytes \*\//.test(cr)) {
      stats.statusQueries++
      return range308()
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr)
    const body = req.postDataBuffer() || Buffer.alloc(0)
    chunkSeen++
    stats.chunkPuts++
    if (fail.abortChunk && chunkSeen === fail.abortChunk) {
      fail.abortChunk = 0
      stats.aborted++
      return route.abort('connectionreset')
    }
    if (!m || Number(m[1]) !== ses.received) return range308()
    ses.parts.push(body)
    ses.received += body.length
    stats.uploadedBytes += body.length
    if (ses.received < ses.size) return range308()
    const content = Buffer.concat(ses.parts)
    sessions.delete(sid)
    if (ses.fileId) {
      const f = files.get(ses.fileId)!
      f.appProperties = { ...f.appProperties, ...(ses.metadata.appProperties ?? {}) }
      f.revisions.push({ id: newId('r'), content, modifiedTime: now(), keepForever: false })
      f.version++
      return json(route, req, 200, meta(f))
    }
    const f: FakeFile = {
      id: newId('f'),
      name: ses.metadata.name ?? '',
      mimeType: ses.metadata.mimeType ?? '',
      parents: ses.metadata.parents ?? [],
      appProperties: ses.metadata.appProperties ?? {},
      trashed: false,
      version: 1,
      revisions: [{ id: newId('r'), content, modifiedTime: now(), keepForever: false }]
    }
    files.set(f.id, f)
    return json(route, req, 200, meta(f))
  }

  async function handle(route: Route) {
    const req = route.request()
    const url = new URL(req.url())
    const method = req.method()
    const path = url.pathname
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors(req), body: '' })
    if (path.startsWith('/upload/drive/v3/files') && url.searchParams.get('uploadType') === 'resumable') return handleResumable(route, req, url, path)

    // multipart 업로드
    let m = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(path)
    if (m) {
      const { metadata, content } = parseMultipart(req.postDataBuffer()!, req.headers()['content-type'])
      stats.upBytes += content.length
      stats.uploads++
      if (m[1]) {
        const f = files.get(m[1])
        if (!f) return json(route, req, 404, { error: 'notFound' })
        if (fail.nextDocUpload && f.name.startsWith('docs/')) {
          fail.nextDocUpload = false
          return json(route, req, 403, { error: { message: 'injected failure' } })
        }
        if (metadata.name) f.name = metadata.name
        f.appProperties = { ...f.appProperties, ...(metadata.appProperties ?? {}) }
        f.revisions.push({ id: newId('r'), content, modifiedTime: now(), keepForever: false })
        f.version++
        return json(route, req, 200, meta(f))
      }
      const f: FakeFile = { id: newId('f'), name: metadata.name, mimeType: metadata.mimeType, parents: metadata.parents ?? [], appProperties: metadata.appProperties ?? {}, trashed: false, version: 1, revisions: [] }
      f.revisions.push({ id: newId('r'), content, modifiedTime: now(), keepForever: false })
      files.set(f.id, f)
      return json(route, req, 200, meta(f))
    }

    // 리비전
    m = /^\/drive\/v3\/files\/([^/]+)\/revisions(?:\/([^/]+))?$/.exec(path)
    if (m) {
      const f = files.get(m[1])
      if (!f) return json(route, req, 404, { error: 'notFound' })
      if (!m[2] && fail.revisionList.has(f.id)) return json(route, req, 500, { error: { message: 'injected failure' } })
      if (!m[2]) return json(route, req, 200, { revisions: f.revisions.map((r) => ({ id: r.id, modifiedTime: r.modifiedTime, size: String(r.content.length), keepForever: r.keepForever })) })
      const r = f.revisions.find((x) => x.id === m![2])
      if (!r) return json(route, req, 404, { error: 'notFound' })
      if (method === 'GET') {
        if (!r.keepForever && r !== head(f)) return json(route, req, 403, { error: { message: 'Only revisions with keepForever set to true can be downloaded' } })
        stats.downBytes += r.content.length
        stats.downloads++
        return route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: cors(req), body: r.content })
      }
      if (method === 'PATCH') {
        const body = JSON.parse(req.postData() || '{}')
        if (r.keepForever && body.keepForever === false) return json(route, req, 400, { error: { message: 'illegalKeepForeverModification' } })
        r.keepForever = !!body.keepForever
        f.version++
        return json(route, req, 200, { id: r.id, keepForever: r.keepForever })
      }
      if (method === 'DELETE') {
        if (r === head(f)) return json(route, req, 400, { error: { message: 'cannotDeleteLastRevision' } })
        f.revisions = f.revisions.filter((x) => x !== r)
        return route.fulfill({ status: 204, headers: cors(req), body: '' })
      }
    }

    // 파일 하나
    m = /^\/drive\/v3\/files\/([^/]+)$/.exec(path)
    if (m) {
      const f = files.get(m[1])
      if (!f) return json(route, req, 404, { error: 'notFound' })
      if (method === 'GET' && url.searchParams.get('alt') === 'media') {
        if (fail.download.has(f.id)) return json(route, req, 500, { error: { message: 'injected failure' } })
        stats.downBytes += head(f).content.length
        stats.downloads++
        return route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: cors(req), body: head(f).content })
      }
      if (method === 'GET') return json(route, req, 200, meta(f))
      if (method === 'PATCH') {
        const body = JSON.parse(req.postData() || '{}')
        if (body.trashed !== undefined) f.trashed = body.trashed
        if (body.name) f.name = body.name
        if (body.appProperties) f.appProperties = { ...f.appProperties, ...body.appProperties }
        f.version++
        return json(route, req, 200, meta(f))
      }
    }

    // 목록 · 폴더 만들기
    if (path === '/drive/v3/files') {
      if (method === 'GET') {
        const q = url.searchParams.get('q') ?? ''
        const found = [...files.values()].filter((f) => matches(f, q)).map(meta)
        stats.listedFiles += found.length
        return json(route, req, 200, { files: found })
      }
      if (method === 'POST') {
        const body = JSON.parse(req.postData() || '{}')
        const f: FakeFile = { id: newId('d'), name: body.name, mimeType: body.mimeType, parents: body.parents ?? [], appProperties: {}, trashed: false, version: 1, revisions: [], created: now() }
        files.set(f.id, f)
        return json(route, req, 200, meta(f))
      }
    }
    return json(route, req, 501, { error: `fake drive: ${method} ${path} 미구현` })
  }

  async function attach(context: BrowserContext) {
    await context.route('https://www.googleapis.com/**', handle)
    await context.route('**/api/auth/token', (route) => json(route, null, 200, { access_token: 'fake', expires_in: 3600 }))
  }

  // ── 검사용 ──
  /** 노트 파일 본문 — 매니페스트(조각 목록)면 조각 파일을 읽어 chunks를 채운다 (src/sync/objects.ts) */
  const ungz = (buf: Buffer) => {
    const file = JSON.parse(gunzipSync(buf).toString('utf8'))
    if (file?.kind !== 'inkpad-doc-m') return file
    const chunks = (file.objs as { pageId: string; key: string; f: string }[]).map((o) => {
      const obj = files.get(o.f)
      return { pageId: o.pageId, key: o.key, elements: obj ? JSON.parse(gunzipSync(head(obj).content).toString('utf8')) : [] }
    })
    return { ...file, kind: 'inkpad-doc', chunks }
  }
  /** 조각 파일들 (objects/{해시}.gz) */
  const objects = () => [...files.values()].filter((f) => f.name.startsWith('objects/'))
  const strokeIds = (file: { chunks: { elements: { id: string }[] }[] }) => file.chunks.flatMap((c) => c.elements.map((e) => e.id)).sort()
  const docFile = (docId: string) => [...files.values()].find((f) => f.name === `docs/${docId}.json` && !f.trashed)
  const backupsOf = (docId: string) => [...files.values()].filter((f) => f.name.startsWith(`backups/${docId}-`) && !f.trashed)
  const revisionStrokes = (f: FakeFile) => f.revisions.map((r) => ({ id: r.id, keepForever: r.keepForever, strokes: strokeIds(ungz(r.content)) }))
  const headStrokes = (docId: string) => strokeIds(ungz(head(docFile(docId)!).content))
  /** 그 노트의 기기 브랜치 파일들 (branches/{docId}@{deviceId}.json) */
  const branchesOf = (docId: string) => [...files.values()].filter((f) => f.name.startsWith(`branches/${docId}@`) && !f.trashed)
  const branchOf = (docId: string, deviceId: string) => branchesOf(docId).find((f) => f.name === `branches/${docId}@${deviceId}.json`)
  const fileStrokes = (f: FakeFile) => strokeIds(ungz(head(f).content))
  /** 그 노트의 파일(main·브랜치)이 휴지통까지 포함해 모두 휴지통에 있는가 */
  const allTrashed = (docId: string) => {
    const all = [...files.values()].filter((f) => f.name === `docs/${docId}.json` || f.name.startsWith(`branches/${docId}@`))
    return all.length > 0 && all.every((f) => f.trashed)
  }

  /** 가짜 Drive 시계를 앞으로 — '바뀐 시각' 목록 검사용 */
  const advance = (ms: number) => void (clock += ms)

  return { attach, advance, fail, stats, files, objects, docFile, backupsOf, branchesOf, branchOf, fileStrokes, allTrashed, revisionStrokes, headStrokes, ungz, strokeIds }
}

export type FakeDrive = ReturnType<typeof createFakeDrive>
