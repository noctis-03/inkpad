// 공유 탭 바: Drive의 파일 하나(Inkpad/shared-tabs.json)를 기기끼리 돌려 쓴다.
// 올리기(↑)는 이 기기의 공유 탭으로 파일을 덮어쓰고, 불러오기(↓)는 파일의 탭으로 이 기기의 공유 탭을 바꾼다.
// 둘 다 사용자가 탭 바의 버튼을 눌렀을 때만 네트워크를 쓴다 (sync.ts 규칙 12). 합치기는 없다 — 나중에 올린 쪽이 이긴다.
// 담기는 것은 탭의 자리(노트·앱·파일 id와 순서)뿐이고, 내용은 각자의 동기화 경로로 오간다.
import { trackActivity } from '../shared/activity'
import { isTabValue, routeKey, useUI, type TabRoute } from '../app/store'
import { getDocument } from '../storage/repo'
import { getApp } from './apps'
import * as drive from './drive'
import { getFile } from './files'
import { ensureFolders, getSync, putSync } from './folders'

const FILE_NAME = 'shared-tabs.json'
const FILE_KEY = 'sharedTabsFileId'

interface SharedTabsFile {
  v: 1
  updatedAt: number
  tabs: TabRoute[]
}

async function liveFileId(root: string): Promise<string | undefined> {
  const id = await drive.liveFileIdFor(await getSync<string>(FILE_KEY), FILE_NAME, root)
  if (id) await putSync(FILE_KEY, id)
  return id
}

/** 이 기기의 공유 탭으로 Drive 파일을 덮어쓴다 */
export async function uploadSharedTabs(): Promise<number> {
  const tabs = useUI.getState().tabs.map(strip)
  return trackActivity(
    'upload',
    '공유 탭',
    async () => {
      const { root } = await ensureFolders()
      const payload: SharedTabsFile = { v: 1, updatedAt: Date.now(), tabs }
      const res = await drive.upload(
        new Blob([JSON.stringify(payload)], { type: 'application/json' }),
        { name: FILE_NAME, mimeType: 'application/json', appProperties: { count: String(tabs.length) } },
        root,
        await liveFileId(root)
      )
      await putSync(FILE_KEY, res.id)
      return tabs.length
    },
    (n) => `탭 ${n}개`
  )
}

/** Drive 파일의 탭으로 이 기기의 공유 탭을 바꾼다. 이 기기에 없는 항목은 뺀다(탭 바가 지워진 항목의 탭을 닫으므로) */
export async function downloadSharedTabs(): Promise<{ tabs: TabRoute[]; missing: number } | null> {
  return trackActivity(
    'download',
    '공유 탭',
    async () => {
      const { root } = await ensureFolders()
      const id = await liveFileId(root)
      if (!id) return null
      const file = await drive.download<Partial<SharedTabsFile>>(id)
      const seen = new Set<string>()
      const all = (Array.isArray(file.tabs) ? file.tabs : []).filter(isTabValue).map(strip).filter((t) => {
        const k = routeKey(t)
        return !seen.has(k) && (seen.add(k), true)
      })
      const tabs: TabRoute[] = []
      for (const t of all) if (await existsHere(t)) tabs.push(t)
      return { tabs, missing: all.length - tabs.length }
    },
    (r) => (r ? `탭 ${r.tabs.length}개` : '올린 공유 탭이 없습니다')
  )
}

/** 탭을 가리키는 데 필요한 것만 남긴다 */
function strip(t: TabRoute): TabRoute {
  return t.name === 'editor' ? { name: 'editor', docId: t.docId } : t.name === 'app' ? { name: 'app', appId: t.appId } : { name: 'file', fileId: t.fileId }
}

async function existsHere(t: TabRoute): Promise<boolean> {
  const row = t.name === 'editor' ? await getDocument(t.docId) : t.name === 'app' ? await getApp(t.appId) : await getFile(t.fileId)
  return !!row && !row.deletedAt
}
