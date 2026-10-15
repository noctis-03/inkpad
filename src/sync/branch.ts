// 기기별 브랜치 + main — 순수 함수만 둔다(Drive·DB를 모른다, 테스트: npm run test:branch). 설계: docs/branch-merge.md
//
//  - main(docs/{docId}.json): 합쳐진 결과. 받기는 main을 받는다.
//  - 브랜치(branches/{docId}@{deviceId}.json): 기기 하나가 올린 그 노트의 상태. 그 기기만 쓴다.
//  - 올리기 = 내 브랜치를 올리고, main이 내 출발점 그대로면 main도 이 내용으로 바꾼다(fast-forward).
//    main이 그 사이 바뀌었으면 main은 건드리지 않는다 → 갈라짐(머지 관리에서 합친다).
//
// main의 신원은 세대 번호(gen)가 아니라 쓸 때마다 새로 뽑는 mid로 판정한다. 두 기기가 같은 세대에서
// 동시에 따라가면 둘 다 gen+1을 쓰므로 번호만으로는 덮인 것을 알 수 없다.
import type { Block, Element, ID, Page } from '../shared/model'
import type { DocFileV1 } from './pack'

// ───────── 파일 표식 ─────────

export interface MainMarker {
  gen: number
  /** 이 main을 쓸 때 새로 뽑은 신원 — 출발점 비교에 쓴다 */
  mid: string
  /** 이 main에 반영된 브랜치 — 기기별로 몇 번째 업로드(seq)까지 들어 있는가 */
  merged: Record<string, number>
  /** 이 세대를 만든 동작 */
  made: { kind: 'ff' | 'merge' | 'restore'; deviceId: string; device: string; at: number }
}

export interface BranchMarker {
  deviceId: string
  device: string
  /** 이 기기가 이 노트 브랜치를 올린 횟수 (1, 2, 3 …) */
  seq: number
  /** 출발점 main 세대·신원 (모르면 null — 출발점 없이 올린 브랜치) */
  baseGen: number
  baseMid: string | null
  /** 출발점 대비 내용을 바꾼 것 → 바꾸기 전 내용의 해시 (computeModified) */
  modified: Record<string, string>
}

export type MainFile = DocFileV1 & { main?: MainMarker }
export type BranchFile = DocFileV1 & { branch: BranchMarker }

export const mainFileName = (docId: ID) => `docs/${docId}.json`
export const branchFileName = (docId: ID, deviceId: string) => `branches/${docId}@${deviceId}.json`

/** 이 기기의 그 노트 브랜치 상태 (syncState `br:{docId}`, 기기 로컬 전용) */
export interface BranchState {
  /** 내 브랜치 파일 */
  fileId?: string
  /** 마지막으로 올린 seq (0 = 아직 없음) */
  seq: number
  /** 이 기기 출발점(base 스냅샷)이 어느 main인가 — 모르면 null */
  baseMid: string | null
  baseGen: number
  /** 이 seq까지는 버렸다(클라우드에 맞추기) — 머지할 것으로 보지 않는다 */
  resolved?: number
}

// ───────── 신원·해시 ─────────

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz'
function randomId(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  let s = ''
  for (const b of bytes) s += B36[b % 36]
  return s
}

/** 기기 ID — appProperties 키(`m.{id}`)에 들어가므로 짧게 */
export const newDeviceId = () => randomId(10)
/** main 신원 */
export const newMid = () => randomId(12)

/** 짧은 내용 해시 (FNV-1a 두 벌 → 16자). 같은 내용인지 가리는 용도라 암호 강도는 필요 없다 */
export function shortHash(s: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193 ^ s.length
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x5bd1e995)
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

// ───────── 비교용 직렬화 (sync/merge.ts와 같은 기준) ─────────

const j = (v: unknown) => JSON.stringify(v)
/** 획의 위치(pageId·청크 key)도 내용의 일부 — 다른 페이지로 옮긴 것도 '고침'이다 */
export const elementSig = (pageId: ID, key: string, el: Element) => j([pageId, key, el])
/** 저장할 때마다 다시 찍히는 updatedAt·version은 내용이 아니다 */
export const pageSig = (p: Page) => j({ ...p, updatedAt: 0, version: 0 })
export const blockSig = (b: Block) => j(b)

const DOC_FIELDS = ['title', 'category', 'mode', 'pageOrder'] as const

/**
 * 출발점(base) 대비 이 기기가 내용을 바꾼 것 — 키: 'el:{id}' | 'page:{id}' | 'block:{id}' | 'doc:{필드}'.
 * 값은 바꾸기 전(base) 내용의 해시다. 머지하는 기기는 main의 그 항목 해시와 비교해
 * "브랜치만 고침 / 양쪽 고침"을 가린다 — 옛 main 리비전을 내려받지 않아도 된다.
 * 새로 그린 것·지운 것은 싣지 않는다: 머지에는 삭제가 없어(모두 살리기) 있다/없다만 보면 된다.
 */
export function computeModified(base: DocFileV1, local: DocFileV1): Record<string, string> {
  const out: Record<string, string> = {}
  const baseEls = new Map<ID, string>()
  for (const c of base.chunks) for (const el of c.elements) baseEls.set(el.id, elementSig(c.pageId, c.key, el))
  for (const c of local.chunks) {
    for (const el of c.elements) {
      const b = baseEls.get(el.id)
      if (b !== undefined && b !== elementSig(c.pageId, c.key, el)) out['el:' + el.id] = shortHash(b)
    }
  }
  const basePages = new Map(base.pages.map((p) => [p.id, pageSig(p)]))
  for (const p of local.pages) {
    const b = basePages.get(p.id)
    if (b !== undefined && b !== pageSig(p)) out['page:' + p.id] = shortHash(b)
  }
  const baseBlocks = new Map((base.blocks ?? []).map((b) => [b.id, blockSig(b)]))
  for (const blk of local.blocks ?? []) {
    const b = baseBlocks.get(blk.id)
    if (b !== undefined && b !== blockSig(blk)) out['block:' + blk.id] = shortHash(b)
  }
  for (const f of DOC_FIELDS) {
    const b = j(base.doc[f] ?? null)
    if (b !== j(local.doc[f] ?? null)) out['doc:' + f] = shortHash(b)
  }
  return out
}

// ───────── main 표식 (appProperties) ─────────
// 목록(메타)만으로 상태를 판정할 수 있게 본문과 같은 값을 appProperties에도 단다.
//   gen · mid · midU(mid를 쓸 때의 updatedAt) · m.{deviceId}=seq
// midU가 있는 까닭: 옛 앱은 appProperties를 덮어쓰며 mid를 모른다. Drive는 PATCH에 없는 키를 남기므로
// 옛 앱이 올린 뒤에도 낡은 mid가 그대로 보인다 — updatedAt이 midU와 다르면 옛 앱이 쓴 것으로 보고
// 'legacy:{updatedAt}'을 신원으로 쓴다(옛 앱도 올릴 때마다 updatedAt을 새로 단다).

export const MERGED_PREFIX = 'm.'

type Props = Record<string, string> | undefined

export function mainMidOf(props: Props): string {
  const p = props ?? {}
  if (p.mid && p.midU && p.midU === p.updatedAt) return p.mid
  return `legacy:${p.updatedAt ?? '0'}`
}

/** 내려받은 main 본문의 신원 — 목록 표식과 같은 규칙 (본문에 main 표식이 없으면 옛 앱이 쓴 것) */
export function midOfFile(file: MainFile): string {
  return file.main?.mid ?? `legacy:${file.doc.updatedAt}`
}

export function genOf(props: Props): number {
  const g = Number(props?.gen)
  return Number.isFinite(g) && g > 0 ? g : 0
}

export function mergedOf(props: Props): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(props ?? {})) {
    if (!k.startsWith(MERGED_PREFIX)) continue
    const n = Number(v)
    if (Number.isFinite(n)) out[k.slice(MERGED_PREFIX.length)] = n
  }
  return out
}

export function mainProps(m: { gen: number; mid: string; merged: Record<string, number>; updatedAt: number }): Record<string, string> {
  const out: Record<string, string> = { gen: String(m.gen), mid: m.mid, midU: String(m.updatedAt) }
  for (const [dev, seq] of Object.entries(m.merged)) out[MERGED_PREFIX + dev] = String(seq)
  return out
}

/** 내 브랜치에 main에 아직 들어가지 않은(버리지도 않은) 내용이 있는가 */
export function isUnmerged(st: BranchState | undefined, merged: Record<string, number>, deviceId: string): boolean {
  if (!st?.seq) return false
  return st.seq > Math.max(merged[deviceId] ?? 0, st.resolved ?? 0)
}
