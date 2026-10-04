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

/** 클라우드 삭제 = 이 기기 + Drive(휴지통). 앱 메뉴의 "클라우드에서 삭제"에서 부른다 */
export async function deleteAppFromCloud(id: ID): Promise<boolean> {
  const a = await db.apps.get(id)
  if (!a) {
    // 설치하지 않은(클라우드 전용) 앱 — Drive에서만 지운다
    const folder = await appsFolder()
    const r = (await drive.listFiles(folder)).find((x) => x.appProperties?.appId === id)
    if (r) await drive.trash(r.id)
    emit()
    return true
  }
  if (!a.fileId) {
    // 클라우드에 지울 것이 없다 — 메뉴에서도 이 동작을 보여 주지 않는다
    return true
  }
  // 이 기기의 사본은 남긴다: Drive만 휴지통으로 보내고 로컬 행은 "이 기기에만 있음"으로 표시한다
  if (!navigator.onLine) throw new Error('오프라인에서는 클라우드에서 삭제할 수 없습니다.')
  await drive.trash(a.fileId)
  await db.apps.update(id, { fileId: undefined, pending: undefined, cloudDetachedAt: Date.now() })
  emit()
  return true
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
      if (a.cloudDetachedAt) return // 이 기기에서 직접 클라우드 삭제한 항목은 건드리지 않는다
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
    console.warn('[apps] 클라우드 반영 실패 — 사용자가 재업로드해야 함', e)
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
// 노트 동기화와 분리한다: Drive의 Inkpad/apps/ = 스토어(카탈로그), 각 기기는 원하는 앱만 설치/업데이트/제거.
// "설치됨" = 로컬 db.apps에 행이 있는가. 원격에 없다고 로컬을 자동으로 지우지 않는다.

export type CloudAppState =
  | 'installed' // 설치됨, 최신
  | 'update' // 설치됨, 원격 updatedAt이 더 새로움
  | 'available' // 클라우드에만 있음
  | 'pending' // 이 기기에서 바뀌어 올릴 것이 있음 (pending 존재)
  | 'cloud-missing' // 설치돼 있고 fileId도 있는데 클라우드에서 사라짐
  | 'local-only' // 클라우드에 올라간 적 없음 (fileId 없음, 업로드 실패)
  | 'detached' // 이 기기에서 직접 클라우드 삭제 — 이 기기에만 남아 있음 (cloudDetachedAt)

export interface CloudAppInfo {
  appId: ID
  title: string
  category: string | null
  remoteUpdatedAt?: number
  localUpdatedAt?: number
  driveFileId?: string
  state: CloudAppState
}

/** 이 기기 설치 목록만으로 만든다 (오프라인에서 열 때) */
async function localCloudApps(): Promise<CloudAppInfo[]> {
  return (await db.apps.toArray())
    .filter((a) => !a.deletedAt)
    .map((a) => ({
      appId: a.id,
      title: a.title,
      category: a.category,
      localUpdatedAt: a.updatedAt,
      driveFileId: a.fileId,
      state: (a.cloudDetachedAt && !a.fileId
        ? 'detached'
        : a.pending || !a.fileId
          ? a.fileId
            ? 'pending'
            : 'local-only'
          : 'installed') as CloudAppState
    }))
}

/**
 * Drive에 올라가 있는 앱 목록 — 메타(appProperties)만으로 만든다(HTML 본문 내려받지 않음).
 * 로컬 db.apps와 합쳐 상태를 계산한다. 원격에 없다고 로컬을 자동 삭제하지 않는다.
 */
export async function listCloudApps(): Promise<CloudAppInfo[]> {
  if (!navigator.onLine) return localCloudApps()
  const folder = await appsFolder()
  const remotes = await drive.listFiles(folder)
  const cloud = new Map<string, drive.RemoteFile>()
  for (const r of remotes) {
    const appId = r.appProperties?.appId
    if (appId) cloud.set(appId, r)
  }
  const out: CloudAppInfo[] = []
  for (const [appId, r] of cloud) {
    const local = await db.apps.get(appId)
    const remoteAt = Number(r.appProperties?.updatedAt) || Date.parse(r.modifiedTime) || 0
    const state: CloudAppState =
      local?.pending
        ? 'pending'
        : !local
          ? 'available'
          : !local.fileId
            ? 'local-only'
            : remoteAt > local.updatedAt
              ? 'update'
              : 'installed'
    out.push({
      appId,
      title: r.appProperties?.title || local?.title || 'HTML 앱',
      category: r.appProperties?.category ?? local?.category ?? null,
      remoteUpdatedAt: remoteAt || undefined,
      localUpdatedAt: local?.updatedAt,
      driveFileId: r.id,
      state
    })
  }
  // 클라우드 목록에 없는 이 기기 앱 — listFiles 인덱스 지연 대비 getMeta로 재확인한다
  for (const a of await db.apps.toArray()) {
    if (a.deletedAt || cloud.has(a.id)) continue
    let state: CloudAppState
    if (a.cloudDetachedAt && !a.fileId) state = 'detached'
    else if (!a.fileId) state = 'local-only'
    else if (a.pending) state = 'pending'
    else {
      const m = await drive.getMeta(a.fileId).catch(() => undefined)
      state = m === null || m?.trashed ? 'cloud-missing' : 'installed'
    }
    out.push({
      appId: a.id,
      title: a.title,
      category: a.category,
      localUpdatedAt: a.updatedAt,
      driveFileId: a.fileId,
      state
    })
  }
  return out.sort((a, b) => (b.remoteUpdatedAt ?? b.localUpdatedAt ?? 0) - (a.remoteUpdatedAt ?? a.localUpdatedAt ?? 0))
}

/** 클라우드 앱 하나를 이 기기로 내려받는다 (기존 pullApps의 단건 다운로드 로직) */
async function downloadAppFromCloud(appId: ID): Promise<void> {
  const local = await db.apps.get(appId)
  if (local?.pending) throw new Error('이 기기의 변경을 먼저 업로드해 주세요.')
  const folder = await appsFolder()
  const r = (await drive.listFiles(folder)).find((x) => x.appProperties?.appId === appId)
  if (!r) throw new Error('클라우드에서 앱을 찾지 못했습니다.')
  const html = await (await drive.downloadBlob(r.id)).text()
  const remoteAt = Number(r.appProperties?.updatedAt) || Date.parse(r.modifiedTime) || Date.now()
  await db.apps.put({
    id: appId,
    title: r.appProperties?.title || local?.title || 'HTML 앱',
    category: r.appProperties?.category ?? local?.category ?? null,
    html,
    size: new Blob([html]).size,
    createdAt: local?.createdAt ?? remoteAt,
    updatedAt: remoteAt,
    fileId: r.id
  })
  emit()
}

/** 설치 — 클라우드에만 있는 앱을 이 기기로 받는다 */
export async function installApp(appId: ID): Promise<void> {
  await downloadAppFromCloud(appId)
}

/** 업데이트 — 설치된 앱을 최신 원격 내용으로 덮어쓴다 */
export async function updateInstalledApp(appId: ID): Promise<void> {
  await downloadAppFromCloud(appId)
}

/** update 상태인 앱만 순서대로 받는다 */
export async function updateAllApps(): Promise<number> {
  const ids = (await listCloudApps()).filter((a) => a.state === 'update').map((a) => a.appId)
  let n = 0
  for (const id of ids) {
    try {
      await downloadAppFromCloud(id)
      n++
    } catch (e) {
      console.warn('[apps] 업데이트 실패', id, e)
    }
  }
  return n
}

/** 이 기기에서 제거 — 로컬 db.apps 행만 지운다. clearData일 때만 db.appStorage도 지운다 */
export async function uninstallApp(appId: ID, opts?: { clearData?: boolean }): Promise<void> {
  if (opts?.clearData) {
    await db.transaction('rw', db.apps, db.appStorage, async () => {
      await db.apps.delete(appId)
      await db.appStorage.delete(appId)
    })
  } else {
    await db.apps.delete(appId)
  }
  emit()
}

/** cloud-missing / local-only / detached / pending 앱을 다시 올린다 (fileId를 지우고 pending upsert) */
export async function reuploadApp(appId: ID): Promise<boolean> {
  await db.apps.update(appId, { fileId: undefined, deletedAt: undefined, pending: 'upsert', cloudDetachedAt: undefined })
  emit()
  return tryFlush(appId)
}

/**
 * available 앱(이 기기에 설치되지 않음)의 새 버전 업로드 — 클라우드 사본만 바꾼다.
 * 로컬 db는 건드리지 않는다(자동 설치 금지). 원격 title·category는 유지하고 updatedAt만 갱신한다.
 */
export async function uploadAppVersionToCloud(appId: ID, file: File): Promise<void> {
  const html = await readHtml(file)
  const folder = await appsFolder()
  const r = (await drive.listFiles(folder)).find((x) => x.appProperties?.appId === appId)
  if (!r) throw new Error('클라우드에서 앱을 찾지 못했습니다.')
  const title = r.appProperties?.title || titleFromHtml(html, file.name.replace(/\.html?$/i, ''))
  const category = r.appProperties?.category
  await drive.upload(
    new Blob([html], { type: 'text/html' }),
    {
      name: `${appId}.html`,
      mimeType: 'text/html',
      appProperties: {
        appId,
        updatedAt: String(Date.now()),
        title: fitProp('title', title),
        ...(category && bytes('category') + bytes(category) <= PROP_MAX ? { category } : {})
      }
    },
    folder,
    r.id
  )
  emit()
}
