// 버전 기록 관리 — 노트 파일의 Drive 리비전 + 별도 머지 백업 파일(Inkpad/backups/)을 한 목록으로 보여 준다.
//
//   - 리비전: 올리기·머지 결과·되돌림이 쌓인다. 고정(keepForever)하지 않은 것은 약 30일 뒤 Drive가 지운다.
//   - 머지 백업: 머지에서 밀린 이 기기 상태('버려짐'). 노트 파일의 '현재'를 건드리지 않도록 별도 파일로 둔다
//     (예전 기록은 노트 파일의 고정 리비전으로 남아 있고, 그대로 보인다).
//
// 되돌리기 후 업로드는 UI가 syncNow()로 처리한다.
import type { ID } from '../shared/model'
import { gzipJson } from '../storage/compress'
import { db } from '../storage/db'
import { withDocExclusive } from '../storage/docGuard'
import { enqueue } from '../storage/repo'
import { applyDocFile } from './apply'
import * as drive from './drive'
import { REMOTE_EVENT } from './sync'
import { ensureFolders, getSync, putSync, type FileRecord } from './folders'
import type { DocFileV1, RevMarker } from './pack'
import { getCachedTag, putCachedTag, rememberRevTag, type RevTag } from './revTags'

export interface DocRevision {
  id: string
  modifiedTime: string
  size: number
  keepForever: boolean
  isHead: boolean
  /** 업로드한 기기 이름 (표식을 읽은 리비전에만) */
  device?: string
  /** push · merge(머지됨) · merge-backup(버려짐) · restore(되돌림) */
  revKind?: RevMarker['kind']
  conflicts?: number
  /** 표식을 이미 읽어봤는가(캐시 포함) — false인 고정 리비전만 fetchRevisionTags가 내려받는다 */
  tagged?: boolean
  /** 노트 파일의 리비전이 아니라 별도 머지 백업 파일(Inkpad/backups/)이면 그 파일 id — 고정·해제가 없다 */
  backupFileId?: string
}

/** 이 문서의 클라우드 파일 위치 */
async function fileRecordOf(docId: ID): Promise<FileRecord> {
  const rec = await getSync<FileRecord>(`doc:${docId}`)
  if (!rec?.fileId) {
    throw new Error('이 문서의 클라우드 위치를 아직 모릅니다. 먼저 "동기화"를 실행해 주세요.')
  }
  return rec
}

/** 이 문서의 버전 기록 (최신이 마지막). 표식은 캐시·헤드 appProperties에서 즉시 채운다 */
export async function listDocRevisions(docId: ID): Promise<DocRevision[]> {
  const rec = await fileRecordOf(docId)
  const [revs, meta, backups] = await Promise.all([
    drive.listRevisions(rec.fileId),
    drive.getMeta(rec.fileId).catch(() => null),
    listBackupRevisions(docId).catch(() => [] as DocRevision[])
  ])
  const props = meta?.appProperties
  const list = await Promise.all(
    revs.map(async (r, i) => {
      const isHead = i === revs.length - 1
      const cached = await getCachedTag(rec.fileId, r.id)
      let device = cached?.device
      let revKind = cached?.revKind
      let conflicts = cached?.conflicts
      let tagged = !!cached
      if (isHead && props) {
        // 헤드 리비전 = 마지막 업로드 → 파일 appProperties가 곧 표식 (내려받지 않고 읽는다)
        device = props.device ?? device
        revKind = (props.revKind as RevTag['revKind']) ?? revKind
        conflicts = props.revConflicts != null ? Number(props.revConflicts) : conflicts
        tagged = true
      } else if (!cached && !r.keepForever) {
        tagged = true // 고정되지 않은 옛 리비전은 내려받을 수 없어 표식을 읽을 방법이 없다
      }
      return {
        id: r.id,
        modifiedTime: r.modifiedTime,
        size: Number(r.size ?? 0) || 0,
        keepForever: !!r.keepForever,
        isHead,
        device,
        revKind,
        conflicts,
        tagged
      }
    })
  )
  // 별도 머지 백업 파일을 시간순으로 끼워 넣는다 (최신이 마지막 — 헤드는 늘 마지막에 남는다)
  if (!backups.length) return list
  const head = list.pop()
  const merged = [...list, ...backups].sort((a, b) => a.modifiedTime.localeCompare(b.modifiedTime))
  return head ? [...merged, head] : merged
}

/** 표식을 아직 못 읽은 고정 리비전을 내려받아 기기명·태그를 채운다 — 하나씩 읽을 때마다 onUpdate */
export async function fetchRevisionTags(docId: ID, list: DocRevision[], onUpdate: (next: DocRevision[]) => void): Promise<void> {
  const rec = await fileRecordOf(docId)
  const pending = list.filter((r) => !r.tagged && r.keepForever)
  if (!pending.length) return
  const current = [...list]
  let idx = 0
  const worker = async () => {
    while (idx < pending.length) {
      const t = pending[idx++]
      let tag: RevTag = {}
      try {
        const file = await drive.downloadRevision<DocFileV1>(rec.fileId, t.id)
        if (file?.rev) tag = { device: file.rev.device, revKind: file.rev.kind, conflicts: file.rev.conflicts }
      } catch {
        // 못 내려받으면 표식 없음으로 기록해 다음에 다시 시도하지 않는다
      }
      await putCachedTag(rec.fileId, t.id, tag)
      const at = current.findIndex((r) => r.id === t.id)
      if (at >= 0) current[at] = { ...current[at], device: tag.device, revKind: tag.revKind, conflicts: tag.conflicts, tagged: true }
      onUpdate([...current])
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, () => worker()))
}

export async function pinDocRevision(docId: ID, revisionId: string): Promise<void> {
  const rec = await fileRecordOf(docId)
  await drive.setKeepForever(rec.fileId, revisionId, true)
}

/**
 * 고정 해제 — Drive는 keepForever를 false로 되돌리는 것을 허용하지 않는다(400
 * illegalKeepForeverModification). 그래서 흉내 낸다:
 *  1. 그 버전 내용을 고정하지 않은 새 리비전으로 다시 올린다 (내용은 남고 30일 뒤 자동 정리 대상)
 *  2. 고정 리비전을 지운다
 *  3. 원래 최신본(헤드)을 다시 올려 헤드로 되돌린다
 * 예전에는 3을 하지 않아 클라우드의 '현재'가 옛 버전 내용으로 바뀐 채 남았고, 다른 기기는 받기에서
 * 그 옛 내용을 받았다. 고정 해제할 버전이 곧 헤드면 1·2만 한다.
 */
export async function unpinDocRevision(docId: ID, revisionId: string): Promise<void> {
  const rec = await fileRecordOf(docId)
  const revs = await drive.listRevisions(rec.fileId)
  const isHead = revs[revs.length - 1]?.id === revisionId
  const file = await drive.downloadRevision<DocFileV1>(rec.fileId, revisionId)
  if (file?.kind !== 'inkpad-doc') throw new Error('그 버전을 읽을 수 없습니다.')
  const meta = await drive.getMeta(rec.fileId)
  const headProps = { ...(meta?.appProperties ?? {}), docId, enc: drive.ENC_GZIP }
  // 3에서 다시 올릴 헤드 내용 — 1이 헤드를 바꾸기 전에 받아 둔다
  const head = isHead ? null : await drive.downloadJson<DocFileV1>(rec.fileId, meta?.appProperties?.enc)
  if (!isHead && head?.kind !== 'inkpad-doc') throw new Error('클라우드 최신본을 읽지 못해 고정을 해제하지 않았습니다.')
  const { docs } = await ensureFolders()
  const name = `docs/${docId}.json`

  // 1. 그 버전 내용을 고정하지 않은 리비전으로
  const copyProps = { ...headProps, ...(file.rev ? { device: file.rev.device, revKind: file.rev.kind } : {}) }
  let result = await drive.upload(await gzipJson(file), { name, mimeType: 'application/json', appProperties: copyProps }, docs, rec.fileId)
  await rememberRevTag(result.id, { device: file.rev?.device, revKind: file.rev?.kind, conflicts: file.rev?.conflicts })
  // 2. 고정 리비전 삭제 (이제 마지막 리비전이 아니므로 지울 수 있다)
  try {
    await drive.deleteRevision(rec.fileId, revisionId)
  } catch (e) {
    console.warn('[sync] 고정 리비전 삭제 실패 — 고정이 남아 있다:', e)
  }
  // 3. 원래 헤드를 다시 헤드로 — 내용과 표식(제목·기기·종류) 그대로
  if (head) {
    result = await drive.upload(await gzipJson(head), { name, mimeType: 'application/json', appProperties: headProps }, docs, rec.fileId)
    await rememberRevTag(result.id, { device: head.rev?.device, revKind: head.rev?.kind, conflicts: head.rev?.conflicts })
  }
  // 내용은 그대로이므로 위치 기록만 앞으로 옮긴다 — 이 기기가 방금 올린 것을 '받을 것'으로 오판하지 않게
  const prev = await getSync<FileRecord>(`doc:${docId}`)
  if (!prev || BigInt(prev.version || 0) < BigInt(result.version || 0)) await putSync(`doc:${docId}`, { fileId: result.id, version: result.version })
}

export async function deleteDocRevision(docId: ID, revisionId: string): Promise<void> {
  const backup = backupFileIdOf(revisionId)
  if (backup) return drive.trash(backup) // 별도 백업 파일 — Drive 휴지통으로 (30일 보관)
  const rec = await fileRecordOf(docId)
  await drive.deleteRevision(rec.fileId, revisionId)
}

// ───────── 머지 백업 파일 (Inkpad/backups/) ─────────
// 머지 전 이 기기 상태는 노트 파일의 리비전이 아니라 별도 파일로 남긴다 (sync.ts finishMerge).
// 버전 기록에는 리비전과 함께 보이고, id는 'backup:<파일 id>'로 구분한다.

const BACKUP_PREFIX = 'backup:'
const backupFileIdOf = (revisionId: string) => (revisionId.startsWith(BACKUP_PREFIX) ? revisionId.slice(BACKUP_PREFIX.length) : null)

async function listBackupRevisions(docId: ID): Promise<DocRevision[]> {
  // 이 기기가 아직 백업 폴더를 모르면 찾기만 한다(만들지 않는다) — 다른 기기가 만든 백업도 보이게
  let folder = await getSync<string>('backupsFolderId')
  if (!folder) {
    folder = (await drive.findFolder('backups', (await ensureFolders()).root)) ?? undefined
    if (!folder) return []
    await putSync('backupsFolderId', folder)
  }
  const files = await drive.listFiles(folder, { docId }).catch(() => [] as drive.RemoteFile[])
  return files.map((f) => {
    const p = f.appProperties ?? {}
    return {
      id: BACKUP_PREFIX + f.id,
      modifiedTime: p.at ? new Date(Number(p.at)).toISOString() : f.modifiedTime,
      size: Number(f.size ?? 0) || 0,
      keepForever: true, // 별도 파일이라 자동으로 지워지지 않는다
      isHead: false,
      device: p.device,
      revKind: 'merge-backup' as const,
      conflicts: p.revConflicts != null ? Number(p.revConflicts) : undefined,
      tagged: true,
      backupFileId: f.id
    }
  })
}

/**
 * 버전 되돌리기: 그 시점 내용을 이 기기에 적용하고 업로드 대기열에 올린다.
 * 실제 반영은 다음 동기화에서 일어나므로, 호출한 쪽에서 syncNow()를 이어서 부르면 된다.
 */
export async function restoreDocRevision(docId: ID, revisionId: string): Promise<void> {
  let file: DocFileV1
  const backup = backupFileIdOf(revisionId)
  if (backup) {
    file = await drive.downloadJson<DocFileV1>(backup, drive.ENC_GZIP) // 별도 백업 파일
  } else {
    const rec = await fileRecordOf(docId)
    // 내려받으려면 먼저 "영구 보존"으로 표시해야 한다 (Drive 규칙)
    const revs = await drive.listRevisions(rec.fileId)
    const target = revs.find((r) => r.id === revisionId)
    if (!target) throw new Error('그 버전을 찾을 수 없습니다. 목록을 새로 고쳐 주세요.')
    if (!target.keepForever) await drive.setKeepForever(rec.fileId, revisionId, true)
    file = await drive.downloadRevision<DocFileV1>(rec.fileId, revisionId)
  }
  if (file?.kind !== 'inkpad-doc') throw new Error('그 버전을 읽을 수 없습니다.')
  // 문서 ID는 그대로 유지하고 수정 시각만 갱신한다 (사본을 만들지 않는다)
  const payload: DocFileV1 = { ...file, doc: { ...file.doc, id: docId, updatedAt: Date.now() } }
  // 열린 편집 화면을 멈춘 채로 덮어쓰고, 다 쓴 뒤에 되돌린 내용으로 다시 열게 한다 (storage/docGuard).
  // 다른 탭에서 편집 중이면 DocBusyError — 버전 기록 패널이 그 메시지를 그대로 보여 준다
  await withDocExclusive(docId, async () => {
    await applyDocFile(payload, { force: true })
    await db.transaction('rw', db.outbox, async () => {
      await enqueue('document', docId)
    })
    // 이 기기의 '현재' 표식 — 버전 기록이 이 리비전을 현재로 표시한다 (기기별 로컬 전용)
    await putSync(`curRev:${docId}`, { revId: revisionId, updatedAt: payload.doc.updatedAt })
    // 다음 올리기가 '되돌림' 리비전이 되도록 표식을 남긴다 (업로드 때 소모된다)
    await putSync(`revKind:${docId}`, 'restore')
  })
  // 목록·읽기 전용 편집 화면에 알린다 (쓰기 가능한 편집 화면은 위 노트 보호가 이미 다시 열었다)
  window.dispatchEvent(new CustomEvent(REMOTE_EVENT, { detail: new Set<string>([docId]) }))
}
