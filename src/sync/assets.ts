// 에셋 원본(PDF·이미지) 지연 로딩 (동기화 방식 A안 ②)
//
// 규칙:
//   - 메타데이터(문서·페이지·필기·에셋 정보)는 "받기"에서 전부 내려받는다 (가볍다).
//   - 원본 바이트는 "받기"에서 받지 않는다. 그 원본을 쓰는 문서를 실제로 열 때 받는다.
//   - 받은 원본은 IndexedDB에 저장하고, 다음부터는 다시 받지 않는다.
//   - 같은 에셋을 여러 곳에서 동시에 요청해도 다운로드는 한 번만 나간다.
import type { ID } from '../shared/model'
import { db, type AssetRow } from '../storage/db'
import * as drive from './drive'
import { ensureFolders, getSync, putSync, type FileRecord } from './folders'
import { assetFileName } from './pack'
import { AuthRequiredError } from './token'

/** 이 기기에 원본이 없고, 지금 받아올 수도 없을 때 */
export class AssetUnavailableError extends Error {}

const KEY = (sha256: string) => `asset:${sha256}`

// ───────────────── 진행률 알림(UI용) ─────────────────

export interface AssetProgress {
  assetId: ID
  loaded: number
  total: number | null
  /** 다운로드가 끝났는지 (진행률 UI를 닫는 신호) */
  done: boolean
}

const listeners = new Set<(e: AssetProgress) => void>()

/** 원본 다운로드 진행률 구독. 해제 함수를 돌려준다. */
export function onAssetProgress(fn: (e: AssetProgress) => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

const emit = (e: AssetProgress) => listeners.forEach((f) => f(e))

// ───────────────── 폴더 위치 ─────────────────

let cachedAssetsFolder: string | null = null

async function assetsFolder(): Promise<string> {
  if (cachedAssetsFolder) return cachedAssetsFolder
  const saved = await getSync<string>('assetsFolderId')
  if (saved) {
    cachedAssetsFolder = saved
    return saved
  }
  cachedAssetsFolder = (await ensureFolders()).assets
  return cachedAssetsFolder
}

/** 폴더를 새로 찾아야 할 때(캐시 무효화) */
export function invalidateAssetsFolderCache() {
  cachedAssetsFolder = null
}

// ───────────────── 조회 ─────────────────

export async function isAssetLocal(assetId: ID): Promise<boolean> {
  const row = await db.assets.get(assetId)
  return !!row?.blob
}

/** 이 기기에 원본이 없는 에셋 목록 */
export async function listMissingAssets(): Promise<AssetRow[]> {
  return (await db.assets.toArray()).filter((a) => !a.blob)
}

export async function countMissingAssets(): Promise<number> {
  return (await listMissingAssets()).length
}

// ───────────────── 지연 로딩 본체 ─────────────────

const inflight = new Map<ID, Promise<Blob>>()

/**
 * 원본을 이 기기에 확보한다. 이미 있으면 그대로 돌려준다.
 * 실패하면 AssetUnavailableError(사용자에게 보여줄 한국어 메시지)를 던진다.
 */
export async function ensureAssetLocal(assetId: ID): Promise<Blob> {
  const row = await db.assets.get(assetId)
  if (!row) throw new AssetUnavailableError('이 문서가 참조하는 원본 정보가 없습니다.')
  if (row.blob) return row.blob

  const running = inflight.get(assetId)
  if (running) return running

  const p = (async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new AssetUnavailableError('오프라인이라 원본을 받을 수 없습니다. 연결한 뒤 다시 열어 주세요.')
    }
    const row_ = row as AssetRow
    emit({ assetId: row_.id, loaded: 0, total: null, done: false })
    const blob = await downloadAsset(row_)
    await db.assets.update(row_.id, { blob })
    emit({ assetId: row_.id, loaded: blob.size, total: blob.size, done: true })
    return blob
  })()
  inflight.set(assetId, p)
  try {
    return await p
  } finally {
    inflight.delete(assetId)
  }
}

/** 실패해도 예외를 던지지 않는 판본 (내보내기 등에서 사용) */
export async function tryEnsureAssetLocal(assetId: ID): Promise<Blob | null> {
  try {
    return await ensureAssetLocal(assetId)
  } catch (e) {
    if (!(e instanceof AssetUnavailableError)) console.warn('[sync] 원본 확보 실패:', assetId, e)
    return null
  }
}

/** 이 기기에 없는 원본을 순서대로 모두 받는다 (사용자가 명시적으로 요청할 때만) */
export async function downloadAllMissing(onProgress?: (done: number, total: number) => void): Promise<{ ok: number; failed: number; authFailed: boolean }> {
  const missing = await listMissingAssets()
  let ok = 0
  let failed = 0
  let authFailed = false
  for (let i = 0; i < missing.length; i++) {
    try {
      await ensureAssetLocal(missing[i].id)
      ok++
    } catch (e) {
      failed++
      // 로그인이 만료된 케이스는 알려야 한다 — 실패 숫자만으로는 사용자가 대처할 수 없다
      if (e instanceof AuthRequiredError) authFailed = true
    }
    onProgress?.(i + 1, missing.length)
  }
  return { ok, failed, authFailed }
}

async function downloadAsset(row: AssetRow): Promise<Blob> {
  const key = KEY(row.sha256)
  let rec: FileRecord | null | undefined = await getSync<FileRecord>(key)

  if (!rec?.fileId) {
    rec = await locateRemote(row)
    if (!rec) {
      throw new AssetUnavailableError('이 원본은 아직 클라우드에 없습니다. 원본이 있는 기기에서 "올리기"를 먼저 실행해 주세요.')
    }
    await putSync(key, rec)
  }

  try {
    return await drive.downloadBlobWithProgress(rec.fileId, (p) => emit({ assetId: row.id, ...p, done: false }))
  } catch (e) {
    // 원격 파일이 사라졌다면(404) 위치 기록을 버리고 한 번만 다시 찾는다
    if (!/404/.test(String(e))) throw new AssetUnavailableError('원본을 받지 못했습니다. 네트워크 상태를 확인해 주세요.')
    await db.syncState.delete(key)
    invalidateAssetsFolderCache()
    const again = await locateRemote(row)
    if (!again) throw new AssetUnavailableError('클라우드에서 이 원본을 찾지 못했습니다.')
    await putSync(key, again)
    return drive.downloadBlobWithProgress(again.fileId, (p) => emit({ assetId: row.id, ...p, done: false }))
  }
}

async function locateRemote(row: AssetRow): Promise<FileRecord | null> {
  const folder = await assetsFolder()
  const found = await drive.findByName(assetFileName(row.sha256, row.mime), folder)
  return found ? { fileId: found.id, version: found.version } : null
}

// ───────────────── 수동 재업로드 (에셋 관리 시트) ─────────────────

/**
 * 이 기기의 원본 바이트를 클라우드에 (다시) 올린다.
 * 클라우드 사본이 지워졌거나(확인 필요) 아직 올라가지 않았을 때(업로드 대기) 쓴다.
 * 원본은 sha256 내용 주소라 내용이 같은데 덮어쓰는 일은 없다 — 살아 있는 사본을 찾아
 * 있으면 그 파일을 덮어쓰고(같은 내용), 없으면 새로 만든다(휴지통에 있는 사본은 건드리지 않는다).
 */
export async function uploadAssetLocal(assetId: ID): Promise<boolean> {
  if (typeof navigator !== 'undefined' && !navigator.onLine)
    throw new Error('오프라인에서는 업로드할 수 없습니다. 연결된 뒤 다시 시도해 주세요.')
  const row = await db.assets.get(assetId)
  if (!row?.blob) return false // 이 기기에 원본이 없다 — 올릴 것이 없다
  const folder = await assetsFolder()
  const name = assetFileName(row.sha256, row.mime)
  const found = await drive.findByName(name, folder) // trashed=false만 본다
  const res = await drive.upload(row.blob, { name, mimeType: row.mime, appProperties: { sha256: row.sha256 } }, folder, found?.id)
  await putSync(KEY(row.sha256), { fileId: res.id, version: res.version })
  // 수동으로 올렸으면 대기열의 asset 항목을 치운다 — 올리기에서 다시 시도하지 않는다
  await db.outbox.where('[entity+entityId]').equals(['asset', assetId]).delete()
  return true
}

// ───────────────── pull 시 인덱싱 (바이트 없음) ─────────────────

/**
 * "받기"에서 호출. 원본 바이트는 받지 않고, 원격에 어떤 원본이 있는지 위치 기록만 채운다.
 * 이렇게 해두면 나중에 문서를 열 때 파일 하나만 바로 내려받을 수 있다.
 */
export async function indexAssets(assetsFolderId: string): Promise<number> {
  const missing = (await db.assets.toArray()).filter((a) => !a.blob)
  if (!missing.length) return 0

  const unknown: AssetRow[] = []
  for (const a of missing) {
    if (!(await getSync<FileRecord>(KEY(a.sha256)))) unknown.push(a)
  }
  if (!unknown.length) return 0

  const files = await drive.listFiles(assetsFolderId)
  const bySha = new Map<string, drive.RemoteFile>()
  for (const f of files) {
    const sha = f.appProperties?.sha256 ?? f.name.slice('assets/'.length).replace(/\..*$/, '')
    if (sha && !bySha.has(sha)) bySha.set(sha, f)
  }

  let n = 0
  for (const a of unknown) {
    const f = bySha.get(a.sha256)
    if (!f) continue
    await putSync(KEY(a.sha256), { fileId: f.id, version: f.version })
    n++
  }
  return n
}
