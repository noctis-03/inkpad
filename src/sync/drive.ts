// Google Drive API 래퍼 (SDF 가이드 6장)
// 401이면 토큰 강제 갱신 후 1회 재시도, 429/5xx는 지수 백오프로 재시도한다.
import { gunzipJson } from '../storage/compress'
import { getAccessToken } from './token'

/** 업로드 본문을 gzip으로 올릴 때 appProperties에 붙이는 표식 */
export const ENC_GZIP = 'gzip'

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const FIELDS = 'id,name,modifiedTime,version,appProperties,trashed'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

export interface RemoteFile {
  id: string
  name: string
  modifiedTime: string
  version: string
  trashed?: boolean
  appProperties?: Record<string, string>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

/** 폴더 이동 — 부모만 바꾸므로 fileId·내용·이름은 그대로다 (에셋 GC의 격리·복구에 쓴다) */
export async function moveFile(fileId: string, fromFolderId: string, toFolderId: string): Promise<RemoteFile> {
  return ok<RemoteFile>(
    await driveFetch(`${API}/files/${fileId}?addParents=${toFolderId}&removeParents=${fromFolderId}&fields=${FIELDS}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
  )
}

export async function listFiles(folderId: string): Promise<RemoteFile[]> {
  const out: RemoteFile[] = []
  let pageToken = ''
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`)
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

/** GC용 상세 목록 — createdTime·size를 추가로 받는다 (sync/gcRun.ts, 구현.md 7.1) */
export interface RemoteFileInfo extends RemoteFile {
  createdTime?: string
  size?: string
}

export async function listFilesDetailed(folderId: string): Promise<RemoteFileInfo[]> {
  const out: RemoteFileInfo[] = []
  let pageToken = ''
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`)
  const fields = 'id,name,modifiedTime,createdTime,version,size,appProperties,trashed'
  do {
    const url =
      `${API}/files?q=${q}&pageSize=1000&fields=nextPageToken,files(${fields})` +
      (pageToken ? `&pageToken=${pageToken}` : '')
    const page = await ok<{ files: RemoteFileInfo[]; nextPageToken?: string }>(await driveFetch(url))
    out.push(...page.files)
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
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    parts.push(value)
    loaded += value.byteLength
    onProgress?.({ loaded, total })
  }
  return new Blob(parts as unknown as BlobPart[], { type })
}

interface UploadMeta {
  name: string
  mimeType: string
  appProperties?: Record<string, string>
}

/** fileId가 없으면 새로 생성, 있으면 덮어쓴다 (multipart) */
export async function upload(
  content: unknown | Blob,
  meta: UploadMeta,
  folderId: string,
  fileId?: string
): Promise<RemoteFile> {
  const metadata = { ...meta, ...(fileId ? {} : { parents: [folderId] }) }
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
