// 버전 기록 — GitHub 커밋 이력을 그대로 쓴다.
//
// git이므로 모든 버전이 영구 보존된다(삭제·고정 개념이 없다). 문서 파일
// 하나를 건드린 커밋 목록 = 그 문서의 버전 기록이고, 아무 커밋이든 꺼내
// 되돌릴 수 있다. 커밋 메시지에는 올린 기기 이름이 들어간다.
//
// 순환 import를 피하려고 sync.ts를 import하지 않는다. 되돌리기 후 업로드는 UI가 syncNow()/pushNow()로 처리한다.
import type { ID } from '../shared/model'
import { db } from '../storage/db'
import { enqueue } from '../storage/repo'
import { applyDocFile } from './apply'
import * as gh from './github'
import { docPath } from './github'
import { getSync, type FileRecord } from './folders'
import type { DocFileV1 } from './pack'

export interface DocRevision {
  id: string // 커밋 SHA
  modifiedTime: string // ISO 8601
  message: string
  author: string
  isHead: boolean
}

async function fileRecordOf(docId: ID): Promise<FileRecord | null> {
  return await getSync<FileRecord>(`doc:${docId}`) ?? null
}

/** 이 문서의 버전 기록 (최신이 마지막) */
export async function listDocRevisions(docId: ID): Promise<DocRevision[]> {
  const rec = await fileRecordOf(docId)
  if (!rec) return [] // 아직 올린 적이 없다
  const commits = await gh.listPathCommits(docPath(docId))
  return commits
    .slice()
    .reverse()
    .map((c, i) => ({ id: c.sha, modifiedTime: c.date, message: c.message, author: c.author, isHead: i === 0 }))
}

/**
 * 버전 되돌리기: 그 커밋 시점 내용을 이 기기에 적용하고 업로드 대기열에 올린다.
 * 실제 반영은 다음 올리기에서 일어나므로, 호출한 쪽에서 pushNow()를 이어서 부르면 된다.
 */
export async function restoreDocRevision(docId: ID, commitSha: string): Promise<void> {
  const file = await gh.readGzipJsonAt<DocFileV1>(docPath(docId), commitSha)
  if (file?.kind !== 'inkpad-doc') throw new Error('그 버전을 읽을 수 없습니다.')
  // 문서 ID는 그대로 유지하고 수정 시각만 갱신한다 (사본을 만들지 않는다)
  const payload: DocFileV1 = { ...file, doc: { ...file.doc, id: docId, updatedAt: Date.now() } }
  await applyDocFile(payload, { force: true })
  await db.transaction('rw', db.outbox, async () => {
    await enqueue('document', docId)
  })
}
