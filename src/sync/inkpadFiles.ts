// HTML 앱의 파일 선택에서 "Inkpad에서 고르기"를 담당한다.
// OAuth 범위가 drive.file(파일 단위 접근)이라 "내 드라이브 전체"를 나열할 수는 없다.
// 대신 Inkpad가 스스로 만든 것(HTML 앱 + 가져온 PDF·이미지 원본)은 로컬 DB가 곧 그 목록이라
// 오프라인에서도 목록을 만들 수 있고, 원본이 이 기기에 없으면 고를 때 클라우드에서 받아온다.
import type { ID } from '../shared/model'
import { db } from '../storage/db'
import { ensureAssetLocal } from './assets'
import { getApp, listApps } from './apps'
import { ensureFileLocal, fileToBlob, getFile as getStoredFile, listFiles as listStoredFiles } from './files'

export type InkpadFile = {
  key: string
  name: string
  mime: string
  size: number
  /** 이 기기에 원본이 있으면 true — 없으면 고를 때 클라우드에서 받아온다 */
  local: boolean
  updatedAt: number
} & ({ kind: 'app'; appId: ID } | { kind: 'file'; fileId: ID } | { kind: 'asset'; assetId: ID })

const EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg'
}

/** 고를 수 있는 Inkpad 파일 목록 — HTML 앱 → 파일 → 노트 원본(PDF·이미지) */
export async function listInkpadFiles(): Promise<InkpadFile[]> {
  const out: InkpadFile[] = []
  for (const a of await listApps()) {
    out.push({
      kind: 'app',
      appId: a.id,
      key: `app:${a.id}`,
      name: `${a.title}.html`,
      mime: 'text/html',
      size: a.size,
      local: true,
      updatedAt: a.updatedAt
    })
  }
  // "파일 추가"로 올린 일반 파일 — 텍스트·이미지·PDF·기타 무엇이든
  for (const f of await listStoredFiles()) {
    out.push({
      kind: 'file',
      fileId: f.id,
      key: `file:${f.id}`,
      name: f.name,
      mime: f.mime,
      size: f.size,
      local: f.text !== undefined || !!f.blob,
      updatedAt: f.updatedAt
    })
  }
  for (const r of await db.assets.toArray()) {
    if (r.kind !== 'pdf' && r.kind !== 'image') continue
    out.push({
      kind: 'asset',
      assetId: r.id,
      key: `asset:${r.id}`,
      name: r.name || `원본-${r.sha256.slice(0, 8)}.${EXT[r.mime] ?? 'bin'}`,
      mime: r.mime,
      size: r.size,
      local: !!r.blob,
      updatedAt: r.createdAt
    })
  }
  const order = (k: InkpadFile['kind']) => (k === 'app' ? 0 : k === 'file' ? 1 : 2)
  return out.sort((a, b) => (order(a.kind) === order(b.kind) ? a.name.localeCompare(b.name, 'ko') : order(a.kind) - order(b.kind)))
}

/** 고른 항목을 앱에 넘길 File로 만든다. 원본이 이 기기에 없으면 클라우드에서 받아온다. */
export async function readInkpadFile(f: InkpadFile): Promise<File> {
  if (f.kind === 'app') {
    const a = await getApp(f.appId)
    if (!a) throw new Error('그 HTML 앱을 찾을 수 없습니다.')
    return new File([a.html], `${a.title}.html`, { type: 'text/html' })
  }
  try {
    if (f.kind === 'file') {
      const row = await ensureFileLocal(f.fileId)
      return new File([await fileToBlob(row)], row.name, { type: row.mime || 'application/octet-stream' })
    }
    const blob = await ensureAssetLocal(f.assetId)
    return new File([blob], f.name, { type: f.mime || 'application/octet-stream' })
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : '원본을 받지 못했습니다.')
  }
}

/** 뷰어가 열 파일이 남아 있는지 (다른 곳에서 지운 경우 대비) */
export async function inkpadFileExists(kind: InkpadFile['kind'], id: ID): Promise<boolean> {
  if (kind === 'app') return !!(await getApp(id))
  if (kind === 'file') return !!(await getStoredFile(id))
  return !!(await db.assets.get(id))
}
