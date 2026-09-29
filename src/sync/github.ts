// GitHub REST API 래퍼 — 동기화 허브.
// Git Data API(blob → tree → commit → ref)를 직접 다뤄 "여러 파일을 한 커밋으로"
// 올린다. 모든 읽기·쓰기는 사용자가 붙여넣은 PAT로 인증하고, api.github.com은
// CORS를 허용하므로 브라우저에서 바로 호출한다 (서버 불필요).
//
// 저장소 레이아웃 (브랜치 전체가 하나의 허브):
//   inkpad/folders.json       폴더 트리 전체 (gzip JSON)
//   inkpad/docs/<docId>.json  문서 1개 = 파일 1개 (gzip JSON)
//   inkpad/assets/<sha256>.<ext>  원본(PDF·이미지), sha256 내용 주소
import { gunzipJson } from '../storage/compress'
import { getConfig, AuthRequiredError, type GhConfig } from './token'

const API = 'https://api.github.com'
/** 저장소 안에서 InkPad 데이터가 들어가는 최상위 폴더 */
export const ROOT = 'inkpad'

export const docPath = (docId: string) => `${ROOT}/docs/${docId}.json`
export const foldersPath = () => `${ROOT}/folders.json`
export const assetsPrefix = () => `${ROOT}/assets/`

export interface TreeEntry {
  path: string
  sha: string
  size?: number
}

export interface Head {
  /** 커밋 SHA */
  sha: string
  /** 그 커밋의 트리 SHA */
  tree: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface GhOpts {
  raw?: boolean
  accept?: string
}

async function ghFetch(url: string, init: RequestInit = {}, opts: GhOpts = {}): Promise<Response> {
  const cfg = await getConfig()
  if (!cfg) throw new AuthRequiredError('GitHub 저장소가 연결되지 않았습니다.')
  let last = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        Authorization: `Bearer ${cfg.token}`,
        Accept: opts.accept ?? 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    if (res.status === 401) throw new AuthRequiredError('토큰이 만료되었거나 권한이 없습니다. 설정에서 다시 연결해 주세요.')
    // 2차 레이트 리밋(403 with retry-after)·429·5xx는 지수 백오프로 재시도
    if (res.status === 429 || res.status >= 500 || (res.status === 403 && res.headers.get('Retry-After'))) {
      const wait = Number(res.headers.get('Retry-After')) || 2 ** attempt * 500 + Math.random() * 300
      await sleep(wait)
      last = `${res.status}`
      continue
    }
    return res
  }
  throw new Error(`GitHub 요청 실패 (재시도 초과, 마지막 상태 ${last})`)
}

async function ok<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`GitHub ${what} 실패 ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

/** 소유자/이름만 뽑아낸다 */
export function parseRepo(repo: string): { owner: string; name: string } {
  const m = repo.trim().match(/^(?:[\w.-]+\/)?([\w.-]+)\/([\w.-]+)$/)
  if (!m) throw new Error('저장소는 "owner/repo" 형식으로 입력해 주세요.')
  return { owner: m[1], name: m[2] }
}

const repoUrl = (cfg: GhConfig) => {
  const { owner, name } = parseRepo(cfg.repo)
  return `${API}/repos/${owner}/${name}`
}

// ───────────────── 저장소 확인 / 생성 ─────────────────

/** 토큰·저장소·브랜치가 실제로 쓰는지 확인한다 */
export async function verify(): Promise<{ login: string; repo: string; branch: string; empty: boolean }> {
  const cfg = await getConfig()
  if (!cfg) throw new AuthRequiredError('설정이 없습니다.')
  const who = await ok<{ login: string }>(await ghFetch(`${API}/user`), '토큰 확인')
  const repoRes = await ghFetch(repoUrl(cfg))
  if (repoRes.status === 404) throw new Error(`저장소 ${cfg.repo} 를 찾을 수 없습니다. GitHub에서 만들거나 이름을 확인해 주세요. (토큰에 접근 권한이 있는지도 확인해 주세요)`)
  const repo = await ok<{ private: boolean; default_branch: string; size: number }>(repoRes, '저장소 확인')
  if (repo.private) throw new Error('비공개(private) 저장소에는 대용량 원본 업로드가 제한될 수 있습니다. 가능하면 공개 저장소를 써 주세요.')
  let empty = false
  const headRes = await ghFetch(`${repoUrl(cfg)}/git/ref/heads/${encodeURIComponent(cfg.branch)}`)
  if (headRes.status === 404) {
    // 브랜치가 없다: 완전히 빈 저장소이거나 다른 브랜치만 있는 경우
    const branches = await ok<{ name: string }[]>(await ghFetch(`${repoUrl(cfg)}/branches?per_page=100`), '브랜치 확인')
    empty = branches.length === 0
    if (!empty) throw new Error(`브랜치 "${cfg.branch}"가 없습니다. 브랜치 이름을 확인해 주세요.`)
  } else {
    await ok(headRes, '브랜치 확인')
  }
  return { login: who.login, repo: cfg.repo, branch: cfg.branch, empty }
}

/** 저장소가 없을 때 만든다 (fine-grained 토큰은 권한에 따라 실패할 수 있다) */
export async function createRepo(name: string, isPrivate = false): Promise<void> {
  const cfg = await getConfig()
  if (!cfg) throw new AuthRequiredError('설정이 없습니다.')
  await ok(
    await ghFetch(`${API}/user/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, private: isPrivate, auto_init: false })
    }),
    '저장소 생성'
  )
}

// ───────────────── 커밋 읽기 ─────────────────

/** 브랜치 헤드. 빈 저장소면 null */
export async function getHead(): Promise<Head | null> {
  const cfg = await getConfig()
  if (!cfg) throw new AuthRequiredError('설정이 없습니다.')
  const res = await ghFetch(`${repoUrl(cfg)}/git/ref/heads/${encodeURIComponent(cfg.branch)}`)
  if (res.status === 404) return null
  const ref = await ok<{ object: { sha: string } }>(res, '헤드 조회')
  const commit = await ok<{ tree: { sha: string } }>(
    await ghFetch(`${repoUrl(cfg)}/git/commits/${ref.object.sha}`),
    '커밋 조회'
  )
  return { sha: ref.object.sha, tree: commit.tree.sha }
}

/** 커밋 아래 전체 파일 목록 (recursive) */
export async function listTree(head: Head): Promise<TreeEntry[]> {
  const cfg = await getConfig()
  if (!cfg) throw new AuthRequiredError('설정이 없습니다.')
  const t = await ok<{ tree: ({ path: string; sha: string; size?: number; type: string } | { path: string; sha: null; type: string })[]; truncated?: boolean }>(
    await ghFetch(`${repoUrl(cfg)}/git/trees/${head.tree}?recursive=1`),
    '트리 조회'
  )
  if (t.truncated) throw new Error('저장소 파일이 너무 많아 목록이 잘렸습니다. 저장소를 정리해 주세요.')
  return t.tree.filter((e): e is { path: string; sha: string; size?: number; type: string } => e.type === 'blob' && e.sha !== null).map((e) => ({ path: e.path, sha: e.sha, size: e.size }))
}

/** blob SHA로 파일 바이트를 내려받는다 (raw 미디어 타입, 스트리밍 진행률) */
export async function downloadRaw(sha: string, onProgress?: (p: { loaded: number; total: number | null }) => void): Promise<Blob> {
  const cfg = await getConfig()
  if (!cfg) throw new AuthRequiredError('설정이 없습니다.')
  const res = await ghFetch(`${repoUrl(cfg)}/git/blobs/${sha}`, {}, { raw: true, accept: 'application/vnd.github.raw' })
  if (!res.ok) throw new Error(`GitHub blob 실패 ${res.status}: ${await res.text()}`)
  if (!res.body) return res.blob()
  const header = res.headers.get('Content-Length')
  const total = header ? Number(header) || null : null
  const type = res.headers.get('Content-Type') ?? 'application/octet-stream'
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    parts.push(value)
    loaded += value.byteLength
    onProgress?.({ loaded, total })
  }
  return new Blob(parts as unknown as BlobPart[], { type })
}

/** blob SHA → gzip JSON 파싱 (gzip 표식은 파일 내용 앞 마법 부호로 판정) */
export async function readGzipJson<T>(sha: string): Promise<T> {
  const blob = await downloadRaw(sha)
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer())
  if (head[0] === 0x1f && head[1] === 0x8b) return gunzipJson<T>(blob)
  return JSON.parse(await blob.text()) as T
}

/** 특정 커밋 시점의 파일 (버전 되돌리기용) */
export async function readGzipJsonAt<T>(path: string, ref: string): Promise<T> {
  const cfg = await getConfig()
  if (!cfg) throw new AuthRequiredError('설정이 없습니다.')
  const res = await ghFetch(`${repoUrl(cfg)}/contents/${path}?ref=${encodeURIComponent(ref)}`, {}, { accept: 'application/vnd.github.raw' })
  if (!res.ok) throw new Error(`GitHub 파일 읽기 실패 ${res.status}`)
  const blob = await res.blob()
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer())
  if (head[0] === 0x1f && head[1] === 0x8b) return gunzipJson<T>(blob)
  return JSON.parse(await blob.text()) as T
}

export interface PathCommit {
  sha: string
  date: string
  message: string
  author: string
}

/** 한 파일의 커밋 이력 (최신 → 과거) */
export async function listPathCommits(path: string, limit = 100): Promise<PathCommit[]> {
  const cfg = await getConfig()
  if (!cfg) throw new AuthRequiredError('설정이 없습니다.')
  const res = await ghFetch(`${repoUrl(cfg)}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(cfg.branch)}&per_page=${limit}`)
  const list = await ok<{ sha: string; commit: { message: string; author: { name: string; date: string } } }[]>(res, '이력 조회')
  return list.map((c) => ({ sha: c.sha, date: c.commit.author?.date ?? c.commit.author?.name ?? '', message: c.commit.message.split('\n')[0], author: c.commit.author?.name ?? '' }))
}

// ───────────────── 커밋 쓰기 ─────────────────

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode(...buf.subarray(i, i + CH))
  return btoa(s)
}

export interface BlobOut {
  sha: string
}

/** 파일 하나를 blob으로 올린다 (아직 커밋에 속하지 않는다) */
export async function createBlob(content: Blob): Promise<string> {
  const cfg = await getConfig()
  if (!cfg) throw new AuthRequiredError('설정이 없습니다.')
  const b = await ok<BlobOut>(
    await ghFetch(`${repoUrl(cfg)}/git/blobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: await blobToBase64(content), encoding: 'base64' })
    }),
    'blob 생성'
  )
  return b.sha
}

export interface TreeItem {
  path: string
  /** 삭제면 null */
  sha: string | null
}

export async function createTree(baseTree: string | null, items: TreeItem[]): Promise<string> {
  const cfg = await getConfig()
  if (!cfg) throw new AuthRequiredError('설정이 없습니다.')
  const t = await ok<{ sha: string }>(
    await ghFetch(`${repoUrl(cfg)}/git/trees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_tree: baseTree, tree: items.map((i) => ({ path: i.path, mode: '100644', type: 'blob', sha: i.sha })) })
    }),
    '트리 생성'
  )
  return t.sha
}

export async function createCommit(message: string, treeSha: string, parents: string[]): Promise<string> {
  const cfg = await getConfig()
  if (!cfg) throw new AuthRequiredError('설정이 없습니다.')
  const c = await ok<{ sha: string }>(
    await ghFetch(`${repoUrl(cfg)}/git/commits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, tree: treeSha, parents })
    }),
    '커밋 생성'
  )
  return c.sha
}

/** 브랜치를 newSha로 이동. 누군가 먼저 올렸으면 RemoteAheadError */
export async function updateRef(newSha: string): Promise<void> {
  const cfg = await getConfig()
  if (!cfg) throw new AuthRequiredError('설정이 없습니다.')
  const res = await ghFetch(`${repoUrl(cfg)}/git/refs/heads/${encodeURIComponent(cfg.branch)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: newSha, force: false })
  })
  if (res.status === 409 || res.status === 422) throw new RemoteAheadError()
  if (!res.ok) throw new Error(`브랜치 갱신 실패 ${res.status}: ${await res.text()}`)
}

/** 빈 저장소의 첫 커밋용: 브랜치 자체를 만든다 */
export async function createBranchRef(commitSha: string): Promise<void> {
  const cfg = await getConfig()
  if (!cfg) throw new AuthRequiredError('설정이 없습니다.')
  await ok(
    await ghFetch(`${repoUrl(cfg)}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${cfg.branch}`, sha: commitSha })
    }),
    '브랜치 생성'
  )
}

export class RemoteAheadError extends Error {
  constructor() {
    super('다른 기기가 먼저 올렸습니다. 받기로 머지한 뒤 다시 시도해 주세요.')
  }
}
