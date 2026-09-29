// 폴더 → 카테고리 전환 마이그레이션 (SCHEMA_VERSION 1 → 2, 앱 시작 시 1회).
//  - 기존 폴더의 경로 이름(하위 폴더는 "부모/자식")을 그 폴더 노트의 category로 부여하고,
//    같은 이름을 폴더에 매핑해 화면을 그대로 유지한다.
//  - 폴더는 이 시점부터 기기별 로컬 전용이다 — Drive로 올리지 않는다.
//  - 모든 문서에 새 스키마 버전을 찍어 전체 재업로드를 예약하고,
//    폴더 동기화의 잔재(outbox의 folder 항목·foldersFile 기록)를 소거한다.
import { SCHEMA_VERSION, type Folder, type ID } from '../shared/model'
import { db } from './db'
import { backupFolderConfig, enqueue } from './repo'

const MARKER = 'categoryMigration.v2'

/** 폴더의 전체 경로 이름 — 최상위부터 "부모/자식" */
function folderPath(f: Folder, byId: Map<ID, Folder>): string {
  const parts: string[] = []
  let cur: Folder | undefined = f
  const seen = new Set<ID>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    parts.unshift(cur.name)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return parts.join('/')
}

let running: Promise<void> | null = null

/** 1회 마이그레이션. 마커가 있으면 아무 것도 하지 않는다. */
export async function migrateFoldersToCategories(): Promise<void> {
  if (running) return running
  running = (async () => {
    if (await db.settings.get(MARKER)) return
    await backupFolderConfig('폴더 → 카테고리 전환 전')
    const now = Date.now()
    await db.transaction('rw', [db.folders, db.documents, db.outbox, db.settings, db.syncState], async () => {
      const folders = await db.folders.toArray()
      const byId = new Map(folders.map((f) => [f.id, f]))
      const pathOf = new Map<ID, string>()

      // 폴더: 경로 이름을 매핑한 로컬 폴더로 전환하고, 옛 삭제 표식은 정리한다
      for (const f of folders) {
        if (f.deletedAt) {
          await db.folders.delete(f.id)
          continue
        }
        pathOf.set(f.id, folderPath(f, byId))
      }
      for (const [id, path] of pathOf) {
        await db.folders.update(id, { categories: [path], schemaVersion: SCHEMA_VERSION, deletedAt: undefined })
      }

      // 문서: 폴더 경로를 카테고리로 기록하고 전체 재업로드를 예약한다
      for (const d of await db.documents.toArray()) {
        await db.documents.put({ ...d, category: (d.folderId && pathOf.get(d.folderId)) || null, schemaVersion: SCHEMA_VERSION })
        await enqueue('document', d.id)
      }

      // 폴더 동기화의 잔재 소거
      for (const r of await db.outbox.toArray()) {
        if ((r.entity as string) === 'folder') await db.outbox.delete(r.seq!)
      }
      await db.syncState.delete('foldersFile')
      await db.settings.put({ key: MARKER, value: now })
    })
  })().finally(() => {
    running = null
  })
  return running
}
