// 카테고리 색 동기화 — 사용자가 고른 색 전체 = Drive 파일 1개 (Inkpad/category-colors.json, 작은 평문 JSON).
// 규칙:
//  1. 노트는 카테고리 '이름'만 갖는다 — 색을 바꿔도 노트는 다시 올리지 않고 이 파일 하나만 오간다
//  2. 올리기: 색을 고르는 동작이 곧 올리기(sync.ts 규칙 12) — 고치면 잠깐 뒤 바로 올린다.
//     오프라인·실패면 pending으로 남고, 다음에 색을 고칠 때나 "받기" 때 함께 올라간다
//  3. 받기: 노트 "받기"(pullNow) 끝에 함께 — 파일 버전이 마지막으로 맞춘 것과 같으면 본문을 받지 않는다
//  4. 올리기 전에 Drive 파일이 마지막으로 맞춘 것과 다르면 받아서 합친 뒤 올린다 (색 이름마다 나중에 고친 쪽)
//  5. 파일을 읽고 쓰는 일은 탭이 여러 개여도 한 번에 하나만 (CATCOLORS_LOCK)
import { CATEGORY_COLOR_FILE, fromCatColorFile, sameCatColors, toCatColorFile, type CatColorMap } from '../shared/categoryColors'
import { CATCOLORS_EVENT, readCategoryColors, storeMergedCategoryColors } from '../storage/categoryColors'
import * as drive from './drive'
import { ensureFolders, getSync, putSync, tryUpload, type FileRecord } from './folders'

const CATCOLORS_LOCK = 'inkpad-catcolors'
const REC_KEY = 'catColorsFile'

/** 받기·합치기·올리기를 한 번에. 받아서 바뀐 게 있으면 down, 올렸으면 up */
export function syncCategoryColors(): Promise<{ down: boolean; up: boolean }> {
  return navigator.locks.request(CATCOLORS_LOCK, async () => {
    const { root } = await ensureFolders()
    const rec = await getSync<FileRecord>(REC_KEY)
    let remote: drive.RemoteFile | null = null
    if (rec?.fileId) {
      const m = await drive.getMeta(rec.fileId)
      if (m && !m.trashed) remote = m
    }
    if (!remote) {
      const found = await drive.findByName(CATEGORY_COLOR_FILE, root)
      if (found && !found.trashed) remote = found
    }
    const before = await readCategoryColors()
    let row = before
    let remoteEntries: CatColorMap | null = null
    if (remote && (remote.id !== rec?.fileId || remote.version !== rec?.version)) {
      remoteEntries = fromCatColorFile(await drive.download(remote.id)) ?? {}
      row = await storeMergedCategoryColors(remoteEntries)
    }
    const down = !sameCatColors(before.entries, row.entries)
    // 올릴 것: 이 기기에서 고친 것이 있거나, 합친 결과가 Drive 내용과 다르거나, Drive에 파일이 없는데 고른 색이 있다
    const needUp = row.pending || (remoteEntries !== null && !sameCatColors(row.entries, remoteEntries)) || (!remote && Object.keys(row.entries).length > 0)
    if (!needUp) {
      if (remote) await putSync(REC_KEY, { fileId: remote.id, version: remote.version } satisfies FileRecord)
      return { down, up: false }
    }
    const sent = row.entries
    const res = await drive.upload(toCatColorFile(sent), { name: CATEGORY_COLOR_FILE, mimeType: 'application/json', appProperties: { kind: 'catColors' } }, root, remote?.id)
    await putSync(REC_KEY, { fileId: res.id, version: res.version } satisfies FileRecord)
    await storeMergedCategoryColors(null, sent) // 올리는 사이에 또 고쳤으면 pending이 남는다
    return { down, up: true }
  }) as Promise<{ down: boolean; up: boolean }>
}

// ───────── 고치면 바로 올리기 (규칙 2) ─────────

let timer = 0
let flushing = false

/** 고쳐 둔 색을 올린다 — 동기화를 설정한 기기에서만(로그인하지 않은 기기는 네트워크를 쓰지 않는다) */
export async function flushCategoryColors(): Promise<boolean> {
  if (flushing || !navigator.onLine || !(await getSync('rootFolderId'))) return false
  if (!(await readCategoryColors()).pending) return false
  flushing = true
  try {
    return await tryUpload(
      'catColors',
      async () => void (await syncCategoryColors()),
      async () => '카테고리 색'
    )
  } finally {
    flushing = false
  }
}

/** App이 한 번 부른다 — 색을 고치면 잠깐 기다렸다가(연달아 바꿔도 한 번에) 올린다 */
export function installCategoryColorUpload(): () => void {
  const on = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void flushCategoryColors(), 700)
  }
  window.addEventListener(CATCOLORS_EVENT, on)
  return () => {
    window.clearTimeout(timer)
    window.removeEventListener(CATCOLORS_EVENT, on)
  }
}
