// 버전 기록(리비전) 관리 — 충돌 사본 대신 Drive의 리비전을 쓴다.
//
// 충돌 해소 규칙(사용자 결정):
//   - 원격(다른 기기) 버전이 그 문서의 헤드가 된다.
//   - 이 기기의 편집은 "고정 리비전(keepForever)"으로 보존한다 → 문서가 복제되지 않는다.
//   - 리비전 고정에 실패하면(200개 한도 등) 예전 방식대로 "(충돌 사본)" 문서를 만든다. 데이터를 잃지 않기 위한 안전망.
//
// 순환 import를 피하려고 sync.ts를 import하지 않는다. 되돌리기 후 업로드는 UI가 syncNow()로 처리한다.
import type { ID } from '../shared/model'
import { gzipJson } from '../storage/compress'
import { db } from '../storage/db'
import { enqueue } from '../storage/repo'
import { applyDocFile } from './apply'
import * as drive from './drive'
import { REMOTE_EVENT } from './sync'
import { ensureFolders, getSync, putSync, type FileRecord } from './folders'
import type { DocFileV1, RevMarker } from './pack'
import { getCachedTag, putCachedTag, rememberRevTag, type RevTag } from './revTags'
import { getDeviceName } from './token'

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
  const [revs, meta] = await Promise.all([drive.listRevisions(rec.fileId), drive.getMeta(rec.fileId).catch(() => null)])
  const props = meta?.appProperties
  return Promise.all(
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
 * illegalKeepForeverModification). 그래서 그 버전 내용을 새 헤드 리비전으로 다시
 * 올린 뒤(내용은 그대로 남는다) 고정 리비전을 삭제하는 방식으로 흉내 낸다.
 */
export async function unpinDocRevision(docId: ID, revisionId: string): Promise<void> {
  const rec = await fileRecordOf(docId)
  const file = await drive.downloadRevision<DocFileV1>(rec.fileId, revisionId)
  if (file?.kind !== 'inkpad-doc') throw new Error('그 버전을 읽을 수 없습니다.')
  // 파일의 표식(제목·기기 등)은 그대로 유지한다
  const meta = await drive.getMeta(rec.fileId)
  const appProperties = {
    ...(meta?.appProperties ?? {}),
    docId,
    enc: drive.ENC_GZIP,
    ...(file.rev ? { device: file.rev.device, revKind: file.rev.kind } : {})
  }
  const { docs } = await ensureFolders()
  const result = await drive.upload(
    await gzipJson(file),
    { name: `docs/${docId}.json`, mimeType: 'application/json', appProperties },
    docs,
    rec.fileId
  )
  await putSync(`doc:${docId}`, { fileId: result.id, version: result.version })
  try {
    await drive.deleteRevision(rec.fileId, revisionId) // 이제 마지막 리비전이 아니므로 삭제 가능
  } catch (e) {
    console.warn('[sync] 고정 리비전 삭제 실패 — 해제는 됐지만 고정이 남아 있다:', e)
  }
}

export async function deleteDocRevision(docId: ID, revisionId: string): Promise<void> {
  const rec = await fileRecordOf(docId)
  await drive.deleteRevision(rec.fileId, revisionId)
}

/**
 * 버전 되돌리기: 그 시점 내용을 이 기기에 적용하고 업로드 대기열에 올린다.
 * 실제 반영은 다음 동기화에서 일어나므로, 호출한 쪽에서 syncNow()를 이어서 부르면 된다.
 */
export async function restoreDocRevision(docId: ID, revisionId: string): Promise<void> {
  const rec = await fileRecordOf(docId)
  // 내려받으려면 먼저 "영구 보존"으로 표시해야 한다 (Drive 규칙)
  const revs = await drive.listRevisions(rec.fileId)
  const target = revs.find((r) => r.id === revisionId)
  if (!target) throw new Error('그 버전을 찾을 수 없습니다. 목록을 새로 고쳐 주세요.')
  if (!target.keepForever) await drive.setKeepForever(rec.fileId, revisionId, true)

  const file = await drive.downloadRevision<DocFileV1>(rec.fileId, revisionId)
  if (file?.kind !== 'inkpad-doc') throw new Error('그 버전을 읽을 수 없습니다.')
  // 문서 ID는 그대로 유지하고 수정 시각만 갱신한다 (사본을 만들지 않는다)
  const payload: DocFileV1 = { ...file, doc: { ...file.doc, id: docId, updatedAt: Date.now() } }
  await applyDocFile(payload, { force: true })
  await db.transaction('rw', db.outbox, async () => {
    await enqueue('document', docId)
  })
  // 이 기기의 '현재' 표식 — 버전 기록이 이 리비전을 현재로 표시한다 (기기별 로컬 전용)
  await putSync(`curRev:${docId}`, { revId: revisionId, updatedAt: payload.doc.updatedAt })
  // 다음 올리기가 '되돌림' 리비전이 되도록 표식을 남긴다 (업로드 때 소모된다)
  await putSync(`revKind:${docId}`, 'restore')
  // 열려 있는 편집 화면에 "다시 불러오기" 안내를 띄운다 (되돌린 내용으로 갱신)
  window.dispatchEvent(new CustomEvent(REMOTE_EVENT, { detail: new Set<string>([docId]) }))
}

/**
 * 충돌 해소: 이 기기의 편집을 먼저 헤드로 올려 고정 리비전으로 만들고,
 * 그다음 원격(다른 기기) 버전을 다시 헤드로 되돌린다.
 * @returns 고정된 리비전 ID. 실패하면 null (호출한 쪽에서 예전 방식으로 대체)
 */
export async function preserveAsRevision(
  docId: ID,
  local: DocFileV1,
  remote: drive.RemoteFile,
  docsFolderId: string
): Promise<string | null> {
  const device = await getDeviceName()
  const rev: RevMarker = { kind: 'merge-backup', device, at: Date.now() }
  const uploaded = await drive.upload(
    await gzipJson({ ...local, rev }),
    {
      name: `docs/${docId}.json`,
      mimeType: 'application/json',
      appProperties: { docId, updatedAt: String(local.doc.updatedAt), enc: drive.ENC_GZIP, revKind: rev.kind }
    },
    docsFolderId,
    remote.id
  )
  const revs = await drive.listRevisions(uploaded.id)
  const newest = revs[revs.length - 1]
  if (!newest) return null
  try {
    await drive.setKeepForever(uploaded.id, newest.id, true)
    await putCachedTag(uploaded.id, newest.id, { device, revKind: rev.kind })
    return newest.id
  } catch (e) {
    console.warn('[sync] 리비전 고정 실패 — 충돌 사본으로 대체합니다:', e)
    return null
  }
}
