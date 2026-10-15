// 조각 저장소 — 노트를 통째로 올리지 않고, 바뀐 청크(페이지 노트는 페이지 하나 = 청크 하나)만 올린다 (git의 객체처럼).
//
//   - 조각: 청크 요소 배열을 gzip한 파일 `Inkpad/objects/{해시}.gz`. 해시는 요소 JSON의 sha256 — 내용이 같으면 같은 이름
//   - 매니페스트: main·브랜치 파일 본문. 청크 대신 조각 목록 {pageId, key, h(해시), f(파일 id), n(요소 수), s(바이트)}만 싣는다.
//     kind가 'inkpad-doc-m'이라 옛 앱은 이 파일을 노트로 읽지 않는다(건너뛴다 — 청크 없는 노트로 덮는 일이 없다)
//   - 올리기: 이 기기가 알고 있는 조각(마지막으로 본 main·내 브랜치의 조각)은 다시 올리지 않는다.
//     브랜치를 올린 뒤 main을 따라갈 때는 방금 올린 조각을 그대로 가리킨다 — 바뀐 페이지 하나만 한 번 올라간다
//   - 받기: 이 기기 기준본·현재 노트에 같은 해시의 청크가 있으면 받지 않는다. 받은 조각은 해시를 확인한다
//   - 옛 전체 파일(kind 'inkpad-doc')도 그대로 읽는다 — 옛 리비전·머지 백업·옛 앱이 올린 main
//
// 안 쓰는 조각은 보관함 관리가 정리한다(archive.ts). 그래서 '알고 있는 조각'은 최근(14일)에 확인한 것만 다시 쓴다 —
// 정리는 45일 넘게 아무 파일도 가리키지 않은 조각만 휴지통으로 보내므로, 다시 가리키는 순간 지워진 조각일 수 없다.
import type { Element, ID } from '../shared/model'
import { sha256Hex } from '../shared/util'
import { gunzipJson, gzipJson } from '../storage/compress'
import { db } from '../storage/db'
import { loadDocument } from '../storage/repo'
import { loadBase } from './base'
import * as drive from './drive'
import { ensureStoreFolder, getSync, putSync } from './folders'
import type { DocFileV1 } from './pack'

export const MANIFEST_KIND = 'inkpad-doc-m'
export const OBJECT_PREFIX = 'objects/'

/** 매니페스트의 조각 하나 */
export interface ObjRef {
  pageId: ID
  key: string
  /** 요소 JSON의 sha256 (앞 40자) */
  h: string
  /** 조각 파일 id */
  f: string
  /** 요소 수 */
  n: number
  /** 조각 파일 바이트(gzip) */
  s: number
}

/** Drive에 저장된 매니페스트 — 노트 파일에서 chunks 대신 objs */
export type ManifestFile<X = object> = Omit<DocFileV1, 'kind' | 'chunks'> & X & { kind: typeof MANIFEST_KIND; objs: ObjRef[] }

/** Drive에서 읽은 노트 파일 — 옛 전체 파일이거나 매니페스트 */
export type StoredNote<X = object> = (DocFileV1 & X) | ManifestFile<X>

export const isNoteFile = (f: unknown): f is StoredNote => {
  const k = (f as { kind?: unknown } | null)?.kind
  return k === 'inkpad-doc' || k === MANIFEST_KIND
}
export const isManifest = <X>(f: StoredNote<X>): f is ManifestFile<X> => f.kind === MANIFEST_KIND

/** 다시 가리켜도 되는 '알고 있는 조각'의 유효 기간 — 정리(archive.ts)의 유예 45일보다 충분히 짧게 */
export const KNOWN_REF_TTL_MS = 14 * 24 * 3600_000
/** 정리가 조각을 휴지통으로 보내기 전, 아무도 가리키지 않은 채로 지나야 하는 기간 */
export const OBJECT_GRACE_MS = 45 * 24 * 3600_000

const objectName = (h: string) => `${OBJECT_PREFIX}${h}.gz`

export const ensureObjectsFolder = () =>
  ensureStoreFolder('objects', 'objectsFolderId', async () => {
    // 조각 폴더가 통째로 사라졌다 — 알고 있는 조각은 더 이상 없다. 다음 올리기가 모두 새로 올린다
    const keys = (await db.syncState.toArray()).map((k) => k.key).filter((k) => k.startsWith('objs:'))
    await db.syncState.bulkDelete(keys)
  })

export async function hashElements(elements: readonly Element[]): Promise<string> {
  return (await sha256Hex(new TextEncoder().encode(JSON.stringify(elements)))).slice(0, 40)
}

// ───────── 알고 있는 조각 (노트별, 이 기기 기록) ─────────

/** main: 마지막으로 읽거나 쓴 main · mine: 마지막으로 올린 내 브랜치 */
type KnownSide = 'main' | 'mine'
interface KnownRecord {
  at: number
  refs: Record<string, { f: string; s: number }>
}
type KnownRecords = Partial<Record<KnownSide, KnownRecord>>

export type KnownRefs = Map<string, { f: string; s: number }>

/** 최근에 확인한 조각만 — 오래된 기록은 정리로 지워졌을 수 있다 */
export async function knownRefs(docId: ID): Promise<KnownRefs> {
  const rec = (await getSync<KnownRecords>(`objs:${docId}`)) ?? {}
  const out: KnownRefs = new Map()
  for (const side of ['main', 'mine'] as const) {
    const r = rec[side]
    if (!r || Date.now() - r.at > KNOWN_REF_TTL_MS) continue
    for (const [h, v] of Object.entries(r.refs)) out.set(h, v)
  }
  return out
}

/** 지금 살아 있는 main·내 브랜치가 가리키는 조각을 기록한다 (그 파일을 읽거나 쓴 직후) */
export async function rememberRefs(docId: ID, side: KnownSide, objs: readonly ObjRef[]): Promise<void> {
  const rec = (await getSync<KnownRecords>(`objs:${docId}`)) ?? {}
  const refs: KnownRecord['refs'] = {}
  for (const o of objs) refs[o.h] = { f: o.f, s: o.s }
  await putSync(`objs:${docId}`, { ...rec, [side]: { at: Date.now(), refs } })
}

export const forgetRefs = (docId: ID) => db.syncState.delete(`objs:${docId}`)

// ───────── 쓰기 ─────────

/** 휴지통의 조각 — 한 번의 올리기(브랜치 + main)가 두 번 묻지 않게 잠깐 기억한다. 정리를 한 적이 없으면 보통 비어 있다 */
let trashedCache: { at: number; ids: Set<string> } | null = null
async function trashedObjects(): Promise<Set<string>> {
  if (trashedCache && Date.now() - trashedCache.at < 60_000) return trashedCache.ids
  const folder = await getSync<string>('objectsFolderId')
  const ids = folder ? await drive.listTrashedIds(folder).catch(() => new Set<string>()) : new Set<string>()
  trashedCache = { at: Date.now(), ids }
  return ids
}
export const forgetTrashedObjects = () => void (trashedCache = null)

/** 한 번에 오가는 조각 요청 수 */
const PARALLEL = 4

async function pool<T>(items: T[], run: (t: T) => Promise<void>): Promise<void> {
  let i = 0
  const worker = async () => {
    while (i < items.length) await run(items[i++])
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker))
}

export interface WriteStats {
  /** 새로 올린 조각 수와 바이트 */
  uploaded: number
  uploadedBytes: number
  /** 노트 전체 조각 바이트(받는 쪽이 하나도 없을 때 받을 양) */
  totalBytes: number
}

/**
 * 노트 내용을 조각 + 매니페스트로 만든다 — 모르는 조각만 올린다. 매니페스트 본문은 돌려주고, 올리는 것은 부르는 쪽이 한다
 * (main·브랜치마다 이름·표식이 다르다). known에는 이번에 올린 조각이 더해진다(같은 올리기의 다음 파일이 다시 쓴다).
 */
export async function toManifest(file: DocFileV1 & Record<string, unknown>, known: KnownRefs): Promise<{ manifest: ManifestFile; stats: WriteStats }> {
  const { chunks, kind: _kind, ...rest } = file
  const objs: ObjRef[] = []
  const todo = new Map<string, Element[]>()
  const trashed = await trashedObjects()
  for (const c of chunks) {
    if (!c.elements.length) continue
    const h = await hashElements(c.elements)
    objs.push({ pageId: c.pageId, key: c.key, h, f: '', n: c.elements.length, s: 0 })
    const k = known.get(h)
    if (k && trashed.has(k.f)) known.delete(h) // 정리가 휴지통으로 보낸 조각 — 가리키지 않고 새로 올린다
    if (!known.has(h)) todo.set(h, c.elements)
  }
  const stats: WriteStats = { uploaded: 0, uploadedBytes: 0, totalBytes: 0 }
  if (todo.size) {
    const folder = await ensureObjectsFolder()
    await pool([...todo], async ([h, elements]) => {
      const blob = await gzipJson(elements)
      const res = await drive.upload(blob, { name: objectName(h), mimeType: 'application/gzip', appProperties: { kind: 'obj', h } }, folder)
      known.set(h, { f: res.id, s: blob.size })
      stats.uploaded++
      stats.uploadedBytes += blob.size
    })
  }
  for (const o of objs) {
    const k = known.get(o.h)!
    o.f = k.f
    o.s = k.s
    stats.totalBytes += k.s
  }
  return { manifest: { ...rest, kind: MANIFEST_KIND, objs } as ManifestFile, stats }
}

// ───────── 읽기 ─────────

/** 이 기기에 이미 있는 청크 — 기준본과 현재 노트. 해시 → 요소 */
async function localObjects(docId: ID | undefined): Promise<Map<string, Element[]>> {
  const out = new Map<string, Element[]>()
  if (!docId) return out
  const add = async (chunks: { elements: Element[] }[]) => {
    for (const c of chunks) if (c.elements.length) out.set(await hashElements(c.elements), c.elements)
  }
  const base = await loadBase(docId).catch(() => null)
  if (base) await add(base.chunks)
  if (await db.documents.get(docId)) await add((await loadDocument(docId).catch(() => null))?.chunks ?? [])
  return out
}

export class ObjectMissingError extends Error {
  constructor(what: string) {
    super(`클라우드의 노트 조각을 읽지 못했습니다(${what}). 그 노트를 올린 기기에서 다시 올려 주세요.`)
    this.name = 'ObjectMissingError'
  }
}

/**
 * 읽은 노트 파일을 온전한 노트로 — 매니페스트면 조각을 모은다(이 기기에 있는 것은 받지 않는다). 옛 전체 파일은 그대로.
 * docId를 주면 그 노트의 기준본·현재 내용에서 같은 조각을 찾는다.
 */
export async function resolveNote<X extends object>(raw: StoredNote<X>, docId?: ID): Promise<DocFileV1 & X> {
  if (!isManifest(raw)) return raw as DocFileV1 & X
  const { objs, kind: _kind, ...rest } = raw
  const have = await localObjects(docId ?? raw.doc?.id)
  const need = [...new Map(objs.filter((o) => !have.has(o.h)).map((o) => [o.h, o])).values()]
  await pool(need, async (o) => {
    let elements: Element[]
    try {
      elements = await gunzipJson<Element[]>(await drive.downloadBlob(o.f))
    } catch (e) {
      throw new ObjectMissingError(e instanceof Error ? e.message.slice(0, 80) : o.h.slice(0, 8))
    }
    if ((await hashElements(elements)) !== o.h) throw new ObjectMissingError('내용이 맞지 않음')
    have.set(o.h, elements)
  })
  const chunks = objs.map((o) => ({ pageId: o.pageId, key: o.key, elements: have.get(o.h)! }))
  return { ...rest, kind: 'inkpad-doc', chunks } as unknown as DocFileV1 & X
}

/** 내려받기 + 풀기 */
export async function downloadNote<X extends object>(
  fileId: string,
  enc: string | undefined,
  docId?: ID
): Promise<{ raw: StoredNote<X>; file: DocFileV1 & X } | null> {
  const raw = await drive.downloadJson<StoredNote<X>>(fileId, enc)
  if (!isNoteFile(raw)) return null
  return { raw, file: await resolveNote(raw, docId) }
}

/** 매니페스트의 조각 목록 (옛 전체 파일이면 빈 목록) */
export const objsOf = (raw: StoredNote<object>): ObjRef[] => (isManifest(raw) ? raw.objs : [])
