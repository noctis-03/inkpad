// 에셋 원본(PDF·이미지) 지연 로딩 — GitHub 허브 버전.
//
// 규칙:
//   - 메타데이터(문서·페이지·필기·에셋 정보)는 "받기"에서 전부 내려받는다 (가볍다).
//   - 원본 바이트는 "받기"에서 받지 않는다. 그 원본을 쓰는 문서를 실제로 열 때 받는다.
//   - 받은 원본은 IndexedDB에 저장하고, 다음부터는 다시 받지 않는다.
//   - 같은 에셋을 여러 곳에서 동시에 요청해도 다운로드는 한 번만 나간다.
import type { ID } from '../shared/model'
import { db, type AssetRow } from '../storage/db'
import * as gh from './github'
import { getSync, putSync, type FileRecord } from './folders'
import { assetFileName } from './pack'

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
export async function downloadAllMissing(onProgress?: (done: number, total: number) => void): Promise<{ ok: number; failed: number }> {
  const missing = await listMissingAssets()
  let ok = 0
  let failed = 0
  for (let i = 0; i < missing.length; i++) {
    try {
      await ensureAssetLocal(missing[i].id)
      ok++
    } catch {
      failed++
    }
    onProgress?.(i + 1, missing.length)
  }
  return { ok, failed }
}

async function downloadAsset(row: AssetRow): Promise<Blob> {
  const key = KEY(row.sha256)
  let rec: FileRecord | null | undefined = await getSync<FileRecord>(key)

  if (!rec?.blobSha) {
    rec = await locateRemote(row)
    if (!rec) {
      throw new AssetUnavailableError('이 원본은 아직 허브(GitHub)에 없습니다. 원본이 있는 기기에서 "올리기"를 먼저 실행해 주세요.')
    }
    await putSync(key, rec)
  }

  try {
    return await gh.downloadRaw(rec.blobSha, (p) => emit({ assetId: row.id, ...p, done: false }))
  } catch (e) {
    // 위치 기록이 잘못됐다면 버리고 한 번만 다시 찾는다
    if (!/404|409|422/.test(String(e))) throw new AssetUnavailableError('원본을 받지 못했습니다. 네트워크 상태를 확인해 주세요.')
    await db.syncState.delete(key)
    const again = await locateRemote(row)
    if (!again) throw new AssetUnavailableError('허브에서 이 원본을 찾지 못했습니다.')
    await putSync(key, again)
    return gh.downloadRaw(again.blobSha, (p) => emit({ assetId: row.id, ...p, done: false }))
  }
}

let treeCache: { headSha: string; entries: Map<string, gh.TreeEntry> } | null = null
export function cacheTree(headSha: string, entries: gh.TreeEntry[]) {
  treeCache = { headSha, entries: new Map(entries.map((e) => [e.path, e])) }
}
export function cachedTree(): Map<string, gh.TreeEntry> | null {
  return treeCache?.entries ?? null
}

async function locateRemote(row: AssetRow): Promise<FileRecord | null> {
  const path = gh.assetsPrefix() + assetFileName(row.sha256, row.mime).slice('assets/'.length)
  const entries = cachedTree() ?? new Map<string, gh.TreeEntry>()
  const hit = entries.get(path)
  return hit ? { path, blobSha: hit.sha } : null
}

// ───────────────── 받기 시 인덱싱 (바이트 없음) ─────────────────

/**
 * "받기"에서 호출. 원본 바이트는 받지 않고, 허브에 어떤 원본이 있는지 위치 기록만 채운다.
 * 이렇게 해두면 나중에 문서를 열 때 파일 하나만 바로 내려받을 수 있다.
 * entries: 마지막 "받기"/"올리기"에서 얻은 허브 트리.
 */
export async function indexAssets(entries: Map<string, gh.TreeEntry>): Promise<number> {
  const missing = (await db.assets.toArray()).filter((a) => !a.blob)
  if (!missing.length) return 0

  let n = 0
  for (const a of missing) {
    if (await getSync<FileRecord>(KEY(a.sha256))) continue
    for (const [path, e] of entries) {
      if (!path.startsWith(gh.assetsPrefix())) continue
      const sha = path.slice(gh.assetsPrefix().length).replace(/\..*$/, '')
      if (sha !== a.sha256) continue
      await putSync(KEY(a.sha256), { path, blobSha: e.sha })
      n++
      break
    }
  }
  return n
}
