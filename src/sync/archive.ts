// 보관함 관리 — 클라우드와 이 기기에 쌓이는 보관물을 보여 주고 정리한다 (docs/branch-merge.md §6).
//
//   기기 브랜치(Inkpad/branches/) · 옛 머지 백업(Inkpad/backups/) · 노트가 사라진 뒤 남은 파일 ·
//   이 기기 로컬 스냅샷 · 되돌리기가 만든 자동 고정(이 기기 기록) · 안 쓰는 노트 조각(Inkpad/objects/)
//
// 클라우드 파일은 지우지 않고 Drive 휴지통으로 옮긴다(30일 보관). 머지 안 된 브랜치는 부르는 쪽이 경고한 뒤에만 지운다.
// 모두 사용자가 이 화면에서 누를 때만 네트워크를 쓴다.
import type { ID } from '../shared/model'
import { db } from '../storage/db'
import { mergedOf } from './branch'
import * as drive from './drive'
import { ensureFolders, findBranchesFolder, getSync } from './folders'
import { newestPerDoc } from './judge'
import { withSyncLock } from './lock'
import { AUTO_PIN_PREFIX, unpinDocRevision } from './revisions'
import { forgetQueued } from './sync'
import { OBJECT_GRACE_MS, forgetTrashedObjects, isNoteFile, objsOf, type StoredNote } from './objects'
import { snapshotUsage } from './snapshots'
import { getDeviceId } from './token'

/** 노트가 사라진 뒤 남은 파일로 볼 만큼 오래됐나 — 막 만든 노트의 main이 아직 안 올라간 순간을 지우지 않게 */
const ORPHAN_AGE_MS = 24 * 3600_000

export interface ArchiveBranch {
  fileId: string
  docId: ID
  title: string
  deviceId: string
  device: string
  seq: number
  size: number
  at: number
  /** main에 다 들어갔거나 버린 것 — 지워도 잃는 것이 없다 */
  merged: boolean
  /** 노트(main)가 클라우드에 없다 */
  orphan: boolean
}

export interface ArchiveDevice {
  deviceId: string
  device: string
  mine: boolean
  branches: number
  bytes: number
  unmerged: number
  lastAt: number
}

export interface ArchiveReport {
  branches: ArchiveBranch[]
  devices: ArchiveDevice[]
  /** 옛 머지 백업 파일 */
  backups: { fileId: string; docId: ID; size: number; orphan: boolean }[]
  snapshots: { count: number; bytes: number; docs: number }
  autoPins: { key: string; fileId: string; revId: string; docId: ID }[]
}

async function findBackupsFolder(): Promise<string | null> {
  const saved = await getSync<string>('backupsFolderId')
  if (saved) {
    const m = await drive.getMeta(saved)
    if (m && !m.trashed) return saved
  }
  return drive.findFolder('backups', (await ensureFolders()).root)
}

/** 보관함 보고서 — Drive 목록 세 번(main·브랜치·백업) + 이 기기 기록 */
export async function loadArchive(): Promise<ArchiveReport> {
  const f = await ensureFolders()
  const [branchFolder, backupFolder, me] = await Promise.all([findBranchesFolder(), findBackupsFolder(), getDeviceId()])
  const [mains, branchFiles, backupFiles] = await Promise.all([
    drive.listFiles(f.docs),
    branchFolder ? drive.listFiles(branchFolder) : Promise.resolve([] as drive.RemoteFile[]),
    backupFolder ? drive.listFiles(backupFolder) : Promise.resolve([] as drive.RemoteFile[])
  ])
  const mainByDoc = new Map(newestPerDoc(mains).map((m) => [m.appProperties!.docId, m]))
  const old = (t: string) => Date.now() - (Date.parse(t) || 0) > ORPHAN_AGE_MS

  const branches: ArchiveBranch[] = []
  for (const b of branchFiles) {
    const p = b.appProperties ?? {}
    if (p.kind !== 'branch' || !p.docId || !p.dev) continue
    const main = mainByDoc.get(p.docId)
    const seq = Number(p.seq) || 0
    let resolved = Number(p.resolved) || 0
    if (p.dev === me) resolved = Math.max(resolved, (await getSync<{ resolved?: number }>(`br:${p.docId}`))?.resolved ?? 0)
    const orphan = !main && old(b.modifiedTime)
    branches.push({
      fileId: b.id,
      docId: p.docId,
      title: main?.appProperties?.title || p.title || (await db.documents.get(p.docId))?.title || p.docId,
      deviceId: p.dev,
      device: p.device || p.dev,
      seq,
      size: Number(b.size ?? 0) || 0,
      at: Number(p.updatedAt) || Date.parse(b.modifiedTime) || 0,
      merged: orphan || (!!main && seq <= Math.max(mergedOf(main.appProperties)[p.dev] ?? 0, resolved)),
      orphan
    })
  }

  const devMap = new Map<string, ArchiveDevice>()
  for (const b of branches) {
    const d = devMap.get(b.deviceId) ?? { deviceId: b.deviceId, device: b.device, mine: b.deviceId === me, branches: 0, bytes: 0, unmerged: 0, lastAt: 0 }
    d.branches++
    d.bytes += b.size
    if (!b.merged) d.unmerged++
    if (b.at > d.lastAt) {
      d.lastAt = b.at
      d.device = b.device // 가장 최근에 쓰던 이름
    }
    devMap.set(b.deviceId, d)
  }

  const backups = backupFiles.map((b) => ({ fileId: b.id, docId: b.appProperties?.docId ?? '', size: Number(b.size ?? 0) || 0, orphan: !mainByDoc.has(b.appProperties?.docId ?? '') }))
  const autoPins = (await db.syncState.where('key').startsWith(AUTO_PIN_PREFIX).toArray()).map((kv) => {
    const [fileId, revId] = kv.key.slice(AUTO_PIN_PREFIX.length).split(':')
    return { key: kv.key, fileId, revId, docId: (kv.value as { docId: ID }).docId }
  })

  return {
    branches: branches.sort((a, b) => b.at - a.at),
    devices: [...devMap.values()].sort((a, b) => Number(b.mine) - Number(a.mine) || b.lastAt - a.lastAt),
    backups,
    snapshots: await snapshotUsage(),
    autoPins
  }
}

/** 브랜치 파일들을 Drive 휴지통으로. 이 기기 브랜치면 기록한 파일 위치만 지운다(seq는 이어 센다 — 다음 올리기가 새 파일을 만든다) */
export function trashBranches(list: Pick<ArchiveBranch, 'fileId' | 'docId' | 'deviceId'>[]): Promise<number> {
  return withSyncLock(async () => {
    const me = await getDeviceId()
    let n = 0
    for (const b of list) {
      await drive.trash(b.fileId)
      n++
      if (b.deviceId === me) {
        const row = await db.syncState.get(`br:${b.docId}`)
        if (row?.value) {
          const { fileId: _gone, ...rest } = row.value as { fileId?: string }
          await db.syncState.put({ key: row.key, value: rest })
        }
      }
    }
    await forgetQueued(list) // 머지 대기 배지에서도 뺀다
    return n
  })
}

/** 옛 머지 백업 파일들을 Drive 휴지통으로 */
export async function trashFiles(fileIds: string[]): Promise<number> {
  for (const id of fileIds) await drive.trash(id)
  return fileIds.length
}

/**
 * 자동 고정 정리 — 되돌리기가 내려받으려고 고정한 리비전의 고정을 푼다(내용은 고정 없는 리비전으로 남아 약 30일 뒤 정리).
 * 이미 사라진 리비전이면 기록만 지운다. 고정 해제는 노트 파일을 다시 쓰므로 하나씩 한다.
 */
export async function releaseAutoPins(pins: ArchiveReport['autoPins']): Promise<{ released: number; failed: number }> {
  let released = 0
  let failed = 0
  for (const p of pins) {
    try {
      const revs = await drive.listRevisions(p.fileId).catch(() => [])
      const rev = revs.find((r) => r.id === p.revId)
      if (rev?.keepForever) {
        await unpinDocRevision(p.docId, p.revId)
        released++
      }
      await db.syncState.delete(p.key)
    } catch (e) {
      console.warn('[archive] 자동 고정 해제 실패:', p, e)
      failed++
    }
  }
  return { released, failed }
}

// ───────── 안 쓰는 노트 조각 (Inkpad/objects/, sync/objects.ts) ─────────
// 조각은 main·브랜치·고정한 리비전이 가리킨다. 아무도 가리키지 않는 조각은 바로 지우지 않는다 —
// 고정하지 않은 옛 리비전(약 30일 산다)이 아직 가리킬 수 있고, 다른 기기가 최근에 본 조각을 다시 가리킬 수 있다.
//   1. 정리를 누르면 아무도 가리키지 않는 조각에 '안 씀' 표식(unref=시각)을 단다. 다시 가리키는 조각은 표식을 지운다
//   2. 표식을 단 지 45일이 지나도 여전히 아무도 가리키지 않는 조각만 휴지통으로(30일 뒤 Drive가 지운다)
// 올리기는 휴지통의 조각을 다시 가리키지 않고 새로 올린다(objects.ts) — 정리와 올리기가 겹쳐도 잃지 않는다.
// 검사에서 노트 파일(main·브랜치·고정한 버전·버전 목록)을 하나라도 읽지 못하면 그 검사로는 표식도 휴지통도 하지 않는다 —
// 못 읽은 파일이 가리키는 조각(최신일 수 있다)을 '안 씀'으로 잘못 세기 때문이다. 표식 지우기(다시 쓰게 된 조각)만 한다.

export interface ObjectScan {
  total: number
  bytes: number
  /** 아무도 가리키지 않는 조각 */
  unused: { id: string; size: number; markedAt: number }[]
  unusedBytes: number
  /** 다시 가리키게 된(표식을 지울) 조각 */
  revived: string[]
  /** 표식을 단 지 45일이 지나 이번 정리에 휴지통으로 갈 조각 */
  ready: number
  readyBytes: number
  /** 살펴본 노트 파일(main·브랜치·고정 리비전) 수 */
  files: number
  /** 읽지 못한 노트 파일(이름) — 하나라도 있으면 이 검사로는 표식·휴지통을 하지 않는다 */
  unreadable: string[]
}

const markedAt = (f: drive.RemoteFile) => Number(f.appProperties?.unref) || 0

/**
 * 조각 검사 — 모든 main·브랜치와 고정한 리비전의 매니페스트를 받아(조각 목록만, 작다) 가리키는 조각을 모은다.
 * 노트마다 리비전 목록을 한 번 읽는다. 누를 때만.
 */
export async function scanObjects(onProgress?: (done: number, total: number) => void): Promise<ObjectScan | null> {
  const folder = (await getSync<string>('objectsFolderId')) ?? (await drive.findFolder('objects', (await ensureFolders()).root))
  if (!folder) return null
  const f = await ensureFolders()
  const branchFolder = await findBranchesFolder()
  const [objects, mains, branches] = await Promise.all([
    drive.listFiles(folder),
    drive.listFiles(f.docs),
    branchFolder ? drive.listFiles(branchFolder) : Promise.resolve([] as drive.RemoteFile[])
  ])
  const used = new Set<string>()
  const unreadable: string[] = []
  /** 노트 파일 하나를 읽어 가리키는 조각을 모은다. 읽지 못하면(네트워크·망가진 파일) 이름을 남긴다 — 조용히 넘기면 그 파일의 조각이 '안 씀'이 된다.
      읽었지만 노트 파일이 아니면 조각을 가리킬 수 없으므로 그냥 넘어간다 */
  const take = async (what: string, get: () => Promise<unknown>) => {
    let raw: unknown
    try {
      raw = await get()
    } catch {
      unreadable.push(what)
      return
    }
    if (isNoteFile(raw)) for (const o of objsOf(raw as StoredNote)) used.add(o.f)
  }
  const nameOf = (f: drive.RemoteFile) => f.appProperties?.title || f.name
  const jobs: (() => Promise<void>)[] = []
  for (const m of mains) {
    jobs.push(async () => {
      await take(nameOf(m), () => drive.downloadJson(m.id, m.appProperties?.enc))
      let revs: drive.Revision[]
      try {
        revs = await drive.listRevisions(m.id)
      } catch {
        unreadable.push(`${nameOf(m)} (버전 목록)`) // 고정한 버전이 가리키는 조각을 모를 수 있다
        return
      }
      for (const r of revs.slice(0, -1)) if (r.keepForever) await take(`${nameOf(m)} (고정한 버전)`, () => drive.downloadRevision(m.id, r.id, m.appProperties?.enc))
    })
  }
  for (const b of branches) jobs.push(() => take(`${nameOf(b)} (기기 브랜치)`, () => drive.downloadJson(b.id, b.appProperties?.enc ?? drive.ENC_GZIP)))
  let done = 0
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(4, jobs.length) }, async () => {
      while (next < jobs.length) {
        await jobs[next++]()
        onProgress?.(++done, jobs.length)
      }
    })
  )

  const now = Date.now()
  const scan: ObjectScan = { total: objects.length, bytes: 0, unused: [], unusedBytes: 0, revived: [], ready: 0, readyBytes: 0, files: jobs.length, unreadable }
  for (const o of objects) {
    const size = Number(o.size ?? 0) || 0
    scan.bytes += size
    if (used.has(o.id)) {
      if (markedAt(o)) scan.revived.push(o.id)
      continue
    }
    scan.unused.push({ id: o.id, size, markedAt: markedAt(o) })
    scan.unusedBytes += size
    if (!unreadable.length && markedAt(o) && now - markedAt(o) >= OBJECT_GRACE_MS) {
      scan.ready++
      scan.readyBytes += size
    }
  }
  return scan
}

/** 조각 정리 — 검사 결과대로 표식을 달고·지우고, 45일 지난 것은 휴지통으로.
    검사에서 읽지 못한 노트 파일이 있으면 표식 지우기만 한다(blocked) — '안 씀' 판정을 믿을 수 없다 */
export function cleanObjects(scan: ObjectScan): Promise<{ marked: number; trashed: number; revived: number; blocked: number }> {
  return withSyncLock(async () => {
    const now = Date.now()
    let marked = 0
    let trashed = 0
    for (const id of scan.revived) await drive.updateMeta(id, { appProperties: { unref: '0' } })
    if (scan.unreadable.length) return { marked, trashed, revived: scan.revived.length, blocked: scan.unreadable.length }
    for (const o of scan.unused) {
      if (!o.markedAt) {
        await drive.updateMeta(o.id, { appProperties: { unref: String(now) } })
        marked++
      } else if (now - o.markedAt >= OBJECT_GRACE_MS) {
        await drive.trash(o.id)
        trashed++
      }
    }
    forgetTrashedObjects()
    return { marked, trashed, revived: scan.revived.length, blocked: 0 }
  })
}
