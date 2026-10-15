// Google Drive API 래퍼
// 401이면 토큰 강제 갱신 후 1회 재시도, 429/5xx는 지수 백오프로 재시도한다.
import { gunzipJson } from '../storage/compress'
import { getAccessToken } from './token'
import { recordTransfer } from '../shared/netMeter'

/** 업로드 본문을 gzip으로 올릴 때 appProperties에 붙이는 표식 */
export const ENC_GZIP = 'gzip'

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const FIELDS = 'id,name,modifiedTime,version,size,appProperties,trashed'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

export interface RemoteFile {
  id: string
  name: string
  modifiedTime: string
  version: string
  size?: string // 파일 바이트 수 (폴더는 없음)
  trashed?: boolean
  appProperties?: Record<string, string>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ───────────────── appProperties 크기 제한 ─────────────────
// Drive는 appProperties 한 항목의 키+값이 UTF-8로 124바이트를 넘으면 업로드 전체를 거부한다.
// 값만 재면 한글 40자(≈120바이트)에 키 'category'(8바이트)가 붙어 128바이트가 되므로 키 길이까지 함께 잰다.
// 이 값들은 목록을 본문 없이 그리기 위한 표식일 뿐이고, 온전한 값은 파일 본문에 늘 들어 있다.

export const APP_PROPERTY_MAX_BYTES = 124
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length

/** 상한에 맞춰 값을 뒤에서부터 글자 단위로 자른다 — 제목처럼 잘려도 알아볼 수 있는 값에 */
export function fitAppProperty(key: string, value: string): string {
  let v = value
  while (v && utf8Bytes(key) + utf8Bytes(v) > APP_PROPERTY_MAX_BYTES) v = Array.from(v).slice(0, -1).join('')
  return v
}

/** 상한 안이면 { key: value }, 넘거나 비었으면 {} — 카테고리처럼 잘리면 다른 값이 되는 것은 통째로 뺀다 */
export function appPropertyIfFits(key: string, value: string | null | undefined): Record<string, string> {
  if (!value || utf8Bytes(key) + utf8Bytes(value) > APP_PROPERTY_MAX_BYTES) return {}
  return { [key]: value }
}

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let force = false
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = await getAccessToken(force)
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` }
    })
    if (res.status === 401 && !force) {
      force = true
      continue
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(2 ** attempt * 500 + Math.random() * 300)
      continue
    }
    return res
  }
  throw new Error('Drive 요청 실패 (재시도 초과)')
}

async function ok<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`Drive ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function getMeta(fileId: string): Promise<RemoteFile | null> {
  const res = await driveFetch(`${API}/files/${fileId}?fields=${FIELDS}`)
  if (res.status === 404) return null
  return ok(res)
}

export async function findFolder(name: string, parentId?: string): Promise<string | null> {
  const q = encodeURIComponent(
    `${parentId ? `'${parentId}' in parents and ` : ''}name=${JSON.stringify(name)} and mimeType='${FOLDER_MIME}' and trashed=false`
  )
  const { files } = await ok<{ files: RemoteFile[] }>(await driveFetch(`${API}/files?q=${q}&fields=files(id)`))
  return files[0]?.id ?? null
}

/** 이름(정확히 일치)으로 파일 찾기 — 내용 주소 에셋의 중복 업로드 방지용 */
export async function findByName(name: string, parentId?: string): Promise<RemoteFile | null> {
  const q = encodeURIComponent(
    `${parentId ? `'${parentId}' in parents and ` : ''}name=${JSON.stringify(name)} and trashed=false`
  )
  const { files } = await ok<{ files: RemoteFile[] }>(await driveFetch(`${API}/files?q=${q}&fields=files(${FIELDS})`))
  return files[0] ?? null
}

/**
 * 덮어쓸 파일을 정한다 — 기록해 둔 파일이 살아 있으면 그것, 아니면 폴더 안의 같은 이름 파일, 둘 다 없으면
 * undefined(새로 만든다). 기록이 비었어도(다시 올리기는 기록을 지우고 올린다) 이름으로 찾아 덮어써야
 * 같은 항목의 파일이 둘 생기지 않는다 — 둘이 되면 다른 기기가 옛 판을 고를 수 있다.
 */
export async function liveFileIdFor(fileId: string | undefined, name: string, folderId: string): Promise<string | undefined> {
  if (fileId) {
    const m = await getMeta(fileId)
    if (m && !m.trashed) return fileId
  }
  return (await findByName(name, folderId))?.id
}

export async function createFolder(name: string, parentId?: string): Promise<string> {
  const f = await ok<RemoteFile>(
    await driveFetch(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) })
    })
  )
  return f.id
}

/** 폴더 안의 파일 목록. where: appProperties로 좁히기 (예: { docId: '…' } — 값은 ULID처럼 따옴표가 없는 것만) */
/** modifiedAfter(RFC 3339)를 주면 그 뒤에 바뀐 파일만 — 받기의 목록을 줄인다 (sync.ts listDocs) */
export async function listFiles(folderId: string, where?: Record<string, string>, modifiedAfter?: string): Promise<RemoteFile[]> {
  const out: RemoteFile[] = []
  let pageToken = ''
  const props = Object.entries(where ?? {})
    .map(([k, v]) => ` and appProperties has { key='${k}' and value='${v.replace(/['\\]/g, '')}' }`)
    .join('')
  const since = modifiedAfter ? ` and modifiedTime > '${modifiedAfter.replace(/[^0-9TZ:.+-]/g, '')}'` : ''
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false${props}${since}`)
  do {
    const url =
      `${API}/files?q=${q}&pageSize=1000&fields=nextPageToken,files(${FIELDS})` +
      (pageToken ? `&pageToken=${pageToken}` : '')
    const page = await ok<{ files: RemoteFile[]; nextPageToken?: string }>(await driveFetch(url))
    out.push(...page.files)
    pageToken = page.nextPageToken ?? ''
  } while (pageToken)
  return out
}

/** 폴더에서 휴지통에 있는 파일 (id만) — 조각 정리가 휴지통으로 보낸 조각을 다시 가리키지 않게 (sync/objects.ts) */
export async function listTrashedIds(folderId: string): Promise<Set<string>> {
  const out = new Set<string>()
  let pageToken = ''
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=true`)
  do {
    const url = `${API}/files?q=${q}&pageSize=1000&fields=nextPageToken,files(id)` + (pageToken ? `&pageToken=${pageToken}` : '')
    const page = await ok<{ files: { id: string }[]; nextPageToken?: string }>(await driveFetch(url))
    for (const f of page.files) out.add(f.id)
    pageToken = page.nextPageToken ?? ''
  } while (pageToken)
  return out
}

export async function download<T = unknown>(fileId: string): Promise<T> {
  return ok<T>(await driveFetch(`${API}/files/${fileId}?alt=media`))
}

/**
 * JSON 파일 다운로드. appProperties.enc === 'gzip'이면 압축을 풀어서 파싱한다.
 * gzip 도입 전에 올린 평문 파일도 그대로 읽히도록 enc가 없으면 기존 경로를 쓴다.
 */
export async function downloadJson<T>(fileId: string, enc?: string): Promise<T> {
  const res = await driveFetch(`${API}/files/${fileId}?alt=media`)
  if (!res.ok) throw new Error(`Drive ${res.status}: ${await res.text()}`)
  if (enc === 'gzip') return gunzipJson<T>(await res.blob())
  return res.json() as Promise<T>
}

export async function downloadBlob(fileId: string): Promise<Blob> {
  const res = await driveFetch(`${API}/files/${fileId}?alt=media`)
  if (!res.ok) throw new Error(`Drive ${res.status}: ${await res.text()}`)
  return res.blob()
}

/** 진행률을 알 수 있는 다운로드 (원본 지연 로딩용). Content-Length가 없으면 total은 null. */
export async function downloadBlobWithProgress(
  fileId: string,
  onProgress?: (p: { loaded: number; total: number | null }) => void
): Promise<Blob> {
  const res = await driveFetch(`${API}/files/${fileId}?alt=media`)
  if (!res.ok) throw new Error(`Drive ${res.status}: ${await res.text()}`)
  if (!res.body) return res.blob()

  const header = res.headers.get('Content-Length')
  const total = header ? Number(header) || null : null
  const type = res.headers.get('Content-Type') ?? 'application/octet-stream'
  // 받은 조각을 JS 배열에 모았다가 Blob으로 다시 합치면 순간 메모리가 파일 크기의 두 배가 된다(200MB PDF면 400MB).
  // 진행률만 세며 그대로 흘려보내고, Blob 조립은 브라우저에 맡긴다
  let loaded = 0
  const counted = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        loaded += chunk.byteLength
        onProgress?.({ loaded, total })
        ctl.enqueue(chunk)
      }
    })
  )
  return new Response(counted, { headers: { 'Content-Type': type } }).blob()
}

interface UploadMeta {
  name: string
  mimeType: string
  appProperties?: Record<string, string>
}

/** 이보다 큰 Blob은 이어 올리기(resumable)로 보낸다 — Google 권장 기준(5MB) */
export const RESUMABLE_MIN_BYTES = 5 * 1024 * 1024
/** 이어 올리기 한 조각 — 256KiB의 배수여야 한다 */
const RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024

/**
 * fileId가 없으면 새로 생성, 있으면 덮어쓴다.
 * 5MB 이하는 multipart 한 번에, 그보다 큰 Blob(PDF 원본 등)은 이어 올리기로 조각내 보낸다 —
 * 중간에 끊겨도 처음부터가 아니라 받은 곳부터 다시 보낸다.
 */
export async function upload(
  content: unknown | Blob,
  meta: UploadMeta,
  folderId: string,
  fileId?: string,
  onProgress?: (p: { loaded: number; total: number }) => void
): Promise<RemoteFile> {
  const metadata = { ...meta, ...(fileId ? {} : { parents: [folderId] }) }
  if (content instanceof Blob && content.size > RESUMABLE_MIN_BYTES) return uploadResumable(content, metadata, meta.mimeType, fileId, onProgress)
  const boundary = 'b' + crypto.randomUUID()
  const contentPart = content instanceof Blob ? content : JSON.stringify(content)
  const contentMime = content instanceof Blob ? meta.mimeType : 'application/json'
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${contentMime}\r\n\r\n`,
    contentPart,
    `\r\n--${boundary}--`
  ])
  const url = fileId
    ? `${UPLOAD}/files/${fileId}?uploadType=multipart&fields=${FIELDS}`
    : `${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`
  return ok<RemoteFile>(
    await driveFetch(url, {
      method: fileId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    })
  )
}

// ───────────────── 이어 올리기 (resumable upload) ─────────────────
// 1) 세션 시작(메타데이터만) → 응답 Location 헤더가 업로드 주소
// 2) 그 주소로 조각을 PUT (Content-Range). 덜 받았으면 308 + Range(받은 곳까지), 다 받으면 200/201 + 파일 메타
// 3) 끊기면 `bytes */전체`로 어디까지 받았는지 물어 거기서부터 다시 보낸다
// Google의 브라우저 예제(googledrive/cors-upload-sample)와 같은 흐름이다. 조각 전송은 예제처럼 XHR로 한다 —
// 308(Resume Incomplete)을 그대로 받고, 업로드 진행률도 알 수 있다.

interface ChunkReply {
  status: number
  range: string | null
  body: string
}

function putChunk(sessionUrl: string, body: Blob | null, contentRange: string, type: string, onSent?: (n: number) => void): Promise<ChunkReply> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', sessionUrl, true)
    xhr.setRequestHeader('Content-Range', contentRange)
    if (body) xhr.setRequestHeader('Content-Type', type)
    if (onSent && xhr.upload) xhr.upload.onprogress = (e) => onSent(e.loaded)
    xhr.onload = () => {
      recordTransfer(sessionUrl, 'PUT', body?.size ?? 0, xhr.responseText.length, xhr.status, Date.now() - t0) // 디버그 계량기(fetch만 센다)에 반영
      resolve({ status: xhr.status, range: xhr.getResponseHeader('Range'), body: xhr.responseText })
    }
    xhr.onerror = () => reject(new Error('업로드 연결이 끊겼습니다.'))
    xhr.ontimeout = () => reject(new Error('업로드 시간이 초과됐습니다.'))
    xhr.send(body)
  })
}

/** 308의 Range("bytes=0-1234")에서 다음에 보낼 위치. Range가 없으면 아직 아무것도 받지 않은 것 (Drive 문서) */
const nextOffset = (range: string | null) => (range ? Number(/-(\d+)\s*$/.exec(range)?.[1] ?? -1) + 1 : 0)

async function uploadResumable(
  blob: Blob,
  metadata: Record<string, unknown>,
  type: string,
  fileId: string | undefined,
  onProgress?: (p: { loaded: number; total: number }) => void
): Promise<RemoteFile> {
  const total = blob.size
  const start = fileId ? `${UPLOAD}/files/${fileId}?uploadType=resumable&fields=${FIELDS}` : `${UPLOAD}/files?uploadType=resumable&fields=${FIELDS}`
  const init = await driveFetch(start, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(total) },
    body: JSON.stringify(metadata)
  })
  if (!init.ok) throw new Error(`Drive ${init.status}: ${await init.text()}`)
  const session = init.headers.get('Location')
  if (!session) throw new Error('Drive 이어 올리기 주소를 받지 못했습니다.')

  let offset = 0
  let failures = 0
  for (;;) {
    const end = Math.min(offset + RESUMABLE_CHUNK_BYTES, total)
    let reply: ChunkReply
    try {
      reply = await putChunk(session, blob.slice(offset, end), `bytes ${offset}-${end - 1}/${total}`, type, (n) => onProgress?.({ loaded: offset + n, total }))
    } catch (e) {
      // 끊김 — 잠시 뒤 어디까지 받았는지 묻고 거기서 이어 간다
      if (++failures > 5) throw e
      await sleep(2 ** failures * 500)
      try {
        reply = await putChunk(session, null, `bytes */${total}`, type)
      } catch {
        continue // 묻기도 실패 — 다음 바퀴에 같은 조각부터 다시
      }
    }
    if (reply.status === 200 || reply.status === 201) {
      onProgress?.({ loaded: total, total })
      return JSON.parse(reply.body) as RemoteFile
    }
    if (reply.status === 308) {
      offset = nextOffset(reply.range)
      failures = 0
      continue
    }
    if (reply.status === 429 || reply.status >= 500) {
      if (++failures > 5) throw new Error(`Drive ${reply.status}: 이어 올리기 실패 (재시도 초과)`)
      await sleep(2 ** failures * 500 + Math.random() * 300)
      try {
        const q = await putChunk(session, null, `bytes */${total}`, type)
        if (q.status === 308) offset = nextOffset(q.range)
        else if (q.status === 200 || q.status === 201) return JSON.parse(q.body) as RemoteFile
      } catch {
        /* 다음 바퀴에 같은 조각부터 */
      }
      continue
    }
    // 404·410 = 세션이 만료됨(약 1주) 등 — 이어 갈 수 없다. 호출한 쪽의 대기가 남아 다음 올리기에서 새로 시작한다
    throw new Error(`Drive ${reply.status}: ${reply.body}`)
  }
}

/** 본문 없이 appProperties(·name)만 바꾼다 — 전송량 수 KB (이름·카테고리 변경용) */
export async function updateMeta(fileId: string, patch: { name?: string; appProperties: Record<string, string> }): Promise<RemoteFile> {
  const body: Record<string, unknown> = { appProperties: patch.appProperties }
  if (patch.name) body.name = patch.name
  return ok<RemoteFile>(
    await driveFetch(`${API}/files/${fileId}?fields=${FIELDS}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  )
}

/** 완전 삭제 대신 휴지통으로 이동 (실수로 지워도 복구 가능) */
export async function trash(fileId: string): Promise<void> {
  const res = await driveFetch(`${API}/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true })
  })
  if (!res.ok && res.status !== 404) throw new Error(`trash 실패 ${res.status}`)
}

// ───────────────── 리비전(파일 버전 기록) ─────────────────
// 우리 문서 파일은 Google Docs가 아니라 blob 파일이므로 Drive가 리비전을 자체 보관한다.
// 규칙(공식 문서):
//   - keepForever가 아닌 리비전은 새 버전이 올라온 뒤 30일 후 자동 삭제된다
//   - 리비전 100개가 쌓이면 더 일찍 잘릴 수 있다
//   - 이전 리비전을 내려받으려면 먼저 keepForever=true로 표시해야 한다
//   - keepForever는 파일당 최대 200개, 용량은 드라이브 쿼터에서 차감된다
//   - 헤드 리비전은 자동 purge 대상이 아니고, 파일의 마지막 리비전은 삭제할 수 없다

const REV_FIELDS = 'id,modifiedTime,size,keepForever,originalFilename'

export interface Revision {
  id: string
  modifiedTime: string
  size?: string
  keepForever?: boolean
  originalFilename?: string
}

export async function listRevisions(fileId: string): Promise<Revision[]> {
  const out: Revision[] = []
  let pageToken = ''
  do {
    const url =
      `${API}/files/${fileId}/revisions?pageSize=200&fields=nextPageToken,revisions(${REV_FIELDS})` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '')
    const page = await ok<{ revisions: Revision[]; nextPageToken?: string }>(await driveFetch(url))
    out.push(...(page.revisions ?? []))
    pageToken = page.nextPageToken ?? ''
  } while (pageToken)
  // 오래된 것 → 최신 순으로 정렬 (헤드가 마지막)
  return out.sort((a, b) => a.modifiedTime.localeCompare(b.modifiedTime))
}

/** 리비전을 영구 보존으로 표시 (이후에 내려받거나 되돌릴 수 있게 된다) */
export async function setKeepForever(fileId: string, revisionId: string, keep: boolean): Promise<void> {
  const res = await driveFetch(`${API}/files/${fileId}/revisions/${revisionId}?fields=${REV_FIELDS}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keepForever: keep })
  })
  if (!res.ok) throw new Error(`리비전 고정 실패 ${res.status}: ${await res.text()}`)
}

/** 리비전 영구 삭제. 파일의 마지막 리비전은 지울 수 없다 */
export async function deleteRevision(fileId: string, revisionId: string): Promise<void> {
  const res = await driveFetch(`${API}/files/${fileId}/revisions/${revisionId}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) throw new Error(`리비전 삭제 실패 ${res.status}: ${await res.text()}`)
}

/** 리비전 내용 다운로드. keepForever로 표시된 리비전만 받을 수 있다. */
export async function downloadRevision<T = unknown>(fileId: string, revisionId: string, enc?: string): Promise<T> {
  const res = await driveFetch(`${API}/files/${fileId}/revisions/${revisionId}?alt=media`)
  if (!res.ok) {
    const body = await res.text()
    if (/keepForever/i.test(body)) throw new Error('이 버전은 아직 고정되지 않아 내려받을 수 없습니다.')
    throw new Error(`Drive ${res.status}: ${body}`)
  }
  const blob = await res.blob()
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer())
  // gzip 마법 부호(1f 8b)면 압축을 푼다 — enc 표식 유무와 관계없이 옛 리비전도 읽힌다
  if (enc === 'gzip' || (head[0] === 0x1f && head[1] === 0x8b)) return gunzipJson<T>(blob)
  return JSON.parse(await blob.text()) as T
}
