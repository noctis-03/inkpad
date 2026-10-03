// HTML 앱: 앱 1개 = Drive 파일 1개 (Inkpad/apps/<id>.html).
// 노트와 달리 머지가 없다 — 추가·업데이트·삭제가 곧바로 Drive에 반영되고,
// 실패하면 pending으로 남아 다음 올리기에서 처리된다.
import { MAX_APP_BYTES, MAX_APP_TITLE_CHARS, type HtmlApp, type ID } from '../shared/model'
import { ulid } from '../shared/ulid'
import { db } from '../storage/db'
import * as drive from './drive'
import { ensureFolders, getSync, putSync } from './folders'

export const APPS_EVENT = 'inkpad-apps-changed'
const emit = () => window.dispatchEvent(new Event(APPS_EVENT))

// Drive appProperties 제한: 키+값 합쳐 UTF-8 124바이트
const PROP_MAX = 124
const bytes = (s: string) => new TextEncoder().encode(s).length
function fitProp(key: string, value: string) {
  let v = value
  while (v && bytes(key) + bytes(v) > PROP_MAX) v = Array.from(v).slice(0, -1).join('')
  return v
}

// ───────── 로컬 ─────────

export async function listApps(): Promise<HtmlApp[]> {
  return (await db.apps.toArray()).filter((a) => !a.deletedAt)
}
export const getApp = (id: ID) => db.apps.get(id)

function titleFromHtml(html: string, fallback: string) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html)
  return (m?.[1].trim() || fallback || 'HTML 앱').slice(0, MAX_APP_TITLE_CHARS)
}

async function readHtml(file: File) {
  if (file.size > MAX_APP_BYTES) throw new Error(`${file.name}: ${MAX_APP_BYTES / 1024 / 1024}MB를 넘는 파일은 추가할 수 없습니다.`)
  return file.text()
}

async function purgeLocal(id: ID) {
  await db.transaction('rw', db.apps, db.appStorage, async () => {
    await db.apps.delete(id)
    await db.appStorage.delete(id)
  })
}

/** uploaded: 클라우드까지 저장됐으면 true */
export async function addApp(file: File, category: string | null): Promise<{ app: HtmlApp; uploaded: boolean }> {
  const html = await readHtml(file)
  const now = Date.now()
  const app: HtmlApp = {
    id: ulid(),
    title: titleFromHtml(html, file.name.replace(/\.html?$/i, '')),
    category,
    html,
    size: file.size,
    createdAt: now,
    updatedAt: now,
    pending: 'upsert'
  }
  await db.apps.add(app)
  emit()
  return { app, uploaded: await tryFlush(app.id) }
}

/** 업데이트 = 새 HTML 파일로 교체 (이름·카테고리 유지) */
export async function updateAppHtml(id: ID, file: File): Promise<boolean> {
  const html = await readHtml(file)
  await db.apps.update(id, { html, size: file.size, updatedAt: Date.now(), pending: 'upsert' })
  emit()
  return tryFlush(id)
}

export async function updateAppMeta(id: ID, patch: { title?: string; category?: string | null }): Promise<boolean> {
  const p = { ...patch }
  if (p.title) p.title = p.title.slice(0, MAX_APP_TITLE_CHARS)
  await db.apps.update(id, { ...p, updatedAt: Date.now(), pending: 'upsert' })
  emit()
  return tryFlush(id)
}

/** 삭제 = 이 기기 + 클라우드 */
export async function deleteApp(id: ID): Promise<boolean> {
  const a = await db.apps.get(id)
  if (!a) return true
  if (!a.fileId) {
    await purgeLocal(id) // 클라우드에 올라간 적 없음
    emit()
    return true
  }
  await db.apps.update(id, { deletedAt: Date.now(), pending: 'delete' })
  emit()
  return tryFlush(id)
}

// 앱의 localStorage 대용 (로컬 전용, 동기화 안 함)
export async function loadAppStorage(id: ID): Promise<Record<string, string>> {
  return (await db.appStorage.get(id))?.data ?? {}
}
export async function saveAppStorage(id: ID, data: Record<string, unknown>) {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(data)) if (typeof v === 'string') clean[k] = v
  await db.appStorage.put({ appId: id, data: clean })
}

// ───────── 클라우드 ─────────

async function appsFolder(): Promise<string> {
  const { root } = await ensureFolders()
  const saved = await getSync<string>('appsFolderId')
  if (saved) {
    const m = await drive.getMeta(saved)
    if (m && !m.trashed) return saved
  }
  const id = (await drive.findFolder('apps', root)) ?? (await drive.createFolder('apps', root))
  if (saved && saved !== id) {
    // 폴더가 통째로 사라졌다 — 로컬은 지우지 않고 전부 다시 올린다 (sync 규칙 5)
    await db.apps.toCollection().modify((a) => {
      delete a.fileId
      if (a.pending !== 'delete') a.pending = 'upsert'
    })
  }
  await putSync('appsFolderId', id)
  return id
}

async function flushOne(id: ID, folderId: string) {
  const a = await db.apps.get(id)
  if (!a?.pending) return
  if (a.pending === 'delete') {
    if (a.fileId) await drive.trash(a.fileId) // Drive 휴지통 (복구 가능)
    await purgeLocal(id)
    return
  }
  let fileId = a.fileId
  if (fileId) {
    const m = await drive.getMeta(fileId)
    if (!m || m.trashed) fileId = undefined
  }
  const res = await drive.upload(
    new Blob([a.html], { type: 'text/html' }),
    {
      name: `${a.id}.html`,
      mimeType: 'text/html',
      appProperties: {
        appId: a.id,
        updatedAt: String(a.updatedAt),
        title: fitProp('title', a.title),
        ...(a.category && bytes('category') + bytes(a.category) <= PROP_MAX ? { category: a.category } : {})
      }
    },
    folderId,
    fileId
  )
  await db.transaction('rw', db.apps, async () => {
    const cur = await db.apps.get(id)
    if (!cur) return
    // 업로드 중에 또 바뀌었으면 pending을 남겨 다음에 다시 올린다
    await db.apps.update(id, cur.updatedAt === a.updatedAt ? { fileId: res.id, pending: undefined } : { fileId: res.id })
  })
}

async function tryFlush(id: ID): Promise<boolean> {
  if (!navigator.onLine) return false
  try {
    await flushOne(id, await appsFolder())
    emit()
    return true
  } catch (e) {
    console.warn('[apps] 클라우드 반영 실패 — 다음 올리기에서 재시도', e)
    return false
  }
}

/** 올리기에서 호출 */
export async function flushPendingApps(): Promise<number> {
  const rows = (await db.apps.toArray()).filter((a) => a.pending)
  if (!rows.length) return 0
  const folder = await appsFolder()
  for (const a of rows) await flushOne(a.id, folder)
  emit()
  return rows.length
}

export async function countPendingApps() {
  return (await db.apps.toArray()).filter((a) => a.pending).length
}

// ───────── 앱 전용 클라우드 관리 (앱 메뉴) ─────────

export type CloudAppState = 'same' | 'remote-new' | 'pending' | 'deleted-local'

export interface CloudAppInfo {
  appId: ID
  driveFileId: string
  title: string
  category: string | null
  updatedAt: number
  state: CloudAppState
}

/** Drive에 올라가 있는 앱 목록 — 메타만으로 만든다(본문 내려받지 않음) */
export async function listCloudApps(): Promise<CloudAppInfo[]> {
  const folder = await appsFolder()
  const remotes = await drive.listFiles(folder)
  const out: CloudAppInfo[] = []
  for (const r of remotes) {
    const appId = r.appProperties?.appId
    if (!appId) continue
    const local = await db.apps.get(appId)
    const remoteAt = Number(r.appProperties?.updatedAt) || 0
    const state: CloudAppState =
      local?.pending === 'delete' ? 'deleted-local'
      : local?.pending === 'upsert' ? 'pending'
      : !local || remoteAt > local.updatedAt ? 'remote-new'
      : 'same'
    out.push({
      appId,
      driveFileId: r.id,
      title: r.appProperties?.title || local?.title || 'HTML 앱',
      category: r.appProperties?.category ?? local?.category ?? null,
      updatedAt: remoteAt || Date.parse(r.modifiedTime) || Date.now(),
      state
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 클라우드 앱 하나를 이 기기로 내려받는다 (이 기기의 변경이 우선) */
export async function downloadCloudApp(info: CloudAppInfo): Promise<'applied' | 'skipped'> {
  const local = await db.apps.get(info.appId)
  if (local?.pending) return 'skipped'
  const html = await (await drive.downloadBlob(info.driveFileId)).text()
  await db.apps.put({
    id: info.appId,
    title: info.title,
    category: info.category,
    html,
    size: new Blob([html]).size,
    createdAt: local?.createdAt ?? Date.now(),
    updatedAt: info.updatedAt || Date.now(),
    fileId: info.driveFileId
  })
  emit()
  return 'applied'
}

/** 클라우드에서 앱을 지운다. 앱은 노트와 달리 표식이 없어 사본도 함께 지운다(다른 기기도 받기 때 지워짐) */
export async function deleteCloudApp(info: Pick<CloudAppInfo, 'appId' | 'driveFileId'>): Promise<void> {
  await drive.trash(info.driveFileId)
  if (await db.apps.get(info.appId)) await purgeLocal(info.appId)
  emit()
}

/** 받기에서 호출: 다른 기기의 추가·업데이트·삭제 반영 */
export async function pullApps(): Promise<number> {
  const folder = await appsFolder()
  const remotes = await drive.listFiles(folder)
  const seen = new Set<string>()
  let n = 0
  for (const r of remotes) {
    const appId = r.appProperties?.appId
    if (!appId) continue
    seen.add(r.id)
    const local = await db.apps.get(appId)
    if (local?.pending) continue // 이 기기의 변경이 우선
    const remoteAt = Number(r.appProperties?.updatedAt) || 0
    if (local && local.updatedAt >= remoteAt) {
      if (local.fileId !== r.id) await db.apps.update(appId, { fileId: r.id })
      continue
    }
    const html = await (await drive.downloadBlob(r.id)).text()
    await db.apps.put({
      id: appId,
      title: r.appProperties?.title || local?.title || 'HTML 앱',
      category: r.appProperties?.category ?? local?.category ?? null,
      html,
      size: new Blob([html]).size,
      createdAt: local?.createdAt ?? (Date.parse(r.modifiedTime) || Date.now()),
      updatedAt: remoteAt || Date.now(),
      fileId: r.id
    })
    n++
  }
  // 다른 기기에서 삭제한 앱. listFiles 인덱스 지연 대비로 getMeta 재확인
  for (const a of await db.apps.toArray()) {
    if (!a.fileId || a.pending || seen.has(a.fileId)) continue
    const m = await drive.getMeta(a.fileId).catch(() => undefined)
    if (m === null || m?.trashed) {
      await purgeLocal(a.id)
      n++
    }
  }
  if (n) emit()
  return n
}
