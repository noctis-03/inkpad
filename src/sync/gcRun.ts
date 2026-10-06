// 에셋 GC — 분석과 실행 (구현.md 7장). 사용자가 "분석하기"/"garbage로 옮기기"를 눌렀을 때만 돌고,
// 전체가 SYNC_LOCK 안에서 실행된다. 보고·복구·기록 처리는 gc.ts가 맡고, 여기서는 Drive를 넓게 훑는다:
// assets 목록·클라우드 노트·고정 리비전·기기 보고서를 모아 후보를 계산하고, 후보를 garbage로 옮긴다.
//
// 최우선 원칙은 "절대 데이터를 잃지 않는다"이다:
//  - 노트·리비전·보고서를 하나라도 받지 못했으면 분석·실행을 중단한다 (판단할 수 없으면 지우지 않는다).
//  - 실행 직전에 후보를 다시 확인해, 분석 이후 생긴 참조는 후보에서 뺀다.
import { ulid } from '../shared/ulid'
import { gunzipJson } from '../storage/compress'
import { db } from '../storage/db'
import * as drive from './drive'
import { GC_PROTOCOL, ensureGcFolders, reportRefs, type GcDeviceReport, type GcRun } from './gc'
import { ensureFolders, getSync, putSync, type FileRecord } from './folders'
import { collectLocalShaRefs } from './refs'
import { pushNow, SYNC_LOCK } from './sync'
import { getDeviceId, getDeviceName } from './token'
import type { DocFileV1 } from './pack'

/** 유예 기간 — pushDoc은 에셋을 먼저 올리고 노트 파일을 나중에 올린다. 그 사이의 참조 없는 에셋을 지키는 24시간 */
const GRACE_MS = 24 * 60 * 60 * 1000

/** 보고가 오래됐다고 본 기준 — 이보다 오래된 기기는 분석 정확도가 떨어진다 (UI 경고에도 쓴다) */
export const GC_STALE_MS = 7 * 24 * 60 * 60 * 1000

/** 진행 표시 — UI가 단계별 문구("클라우드 노트 확인 중 12/40")를 그린다 */
export type GcProgress =
  | { phase: 'sync' }
  | { phase: 'docs'; done: number; total: number }
  | { phase: 'revisions' }
  | { phase: 'devices' }
  | { phase: 'run'; done: number; total: number }

const progressListeners = new Set<(p: GcProgress) => void>()
export function onGcProgress(fn: (p: GcProgress) => void) {
  progressListeners.add(fn)
  return () => {
    progressListeners.delete(fn)
  }
}
const emitProgress = (p: GcProgress) => progressListeners.forEach((f) => f(p))

export interface GcAnalysis {
  computedAt: number
  /** fileId는 제외한 기기의 보고서를 실행 단계에서 정리(trash)할 때 쓴다 (구현.md 7.3) */
  devices: { deviceId: string; deviceName: string; reportedAt: number; refs: number; unresolved: number; isSelf: boolean; fileId?: string }[]
  candidates: { sha256: string; name: string; size: number; fileId: string }[]
  candidateBytes: number
  toRescue: { sha256: string; fileId: string; name: string }[]
  protectedCount: number
  scannedDocs: number
  warnings: string[]
}

export interface GcRunResult {
  /** 후보가 0이면 실행 기록 없이 끝난다 (null) */
  runId: string | null
  planned: number
  moved: string[]
  rescued: { sha256: string; fileId: string; name: string }[]
  failed: { sha256: string; error: string }[]
}

/** assets/{sha256}.{ext} 이름에서 sha를 파싱한다 — 실패하면 null (파싱 실패 파일은 절대 후보가 아니다) */
function shaFromName(name: string): string | null {
  const base = name.startsWith('assets/') ? name.slice('assets/'.length) : name
  const sha = base.replace(/\..*$/, '')
  return /^[0-9a-fA-F]{64}$/.test(sha) ? sha.toLowerCase() : null
}

/**
 * 클라우드 노트 한 개가 참조하는 sha 목록. 순서는 캐시 → base 스냅샷 → 내려받기다 (구현.md 7.1.3).
 * 받거나 해석하는 데 실패하면 예외를 던져 분석·실행을 중단시킨다 — 모르는 것은 보호한다.
 */
async function docRefShas(remote: drive.RemoteFile): Promise<string[]> {
  // 1) 참조 캐시 — 원격 version이 같으면 그대로 쓴다
  const cached = await getSync<{ version: string; shas: string[] }>(`gcDocRefs:${remote.id}`)
  if (cached && cached.version === remote.version && Array.isArray(cached.shas)) return cached.shas

  // 2) 마지막 동기화 스냅샷(base) — 위치 기록의 version이 원격과 같으면 base가 그 시점의 내용이다
  const docId = remote.appProperties?.docId
  if (docId) {
    const rec = await getSync<FileRecord>(`doc:${docId}`)
    if (rec?.version === remote.version) {
      const baseRow = await getSync<{ blob: Blob }>(`base:${docId}`)
      if (baseRow?.blob) {
        try {
          const base = await gunzipJson<DocFileV1>(baseRow.blob)
          if (base?.kind === 'inkpad-doc') return base.assets.map((a) => a.sha256)
        } catch {
          // 깨진 스냅샷 — 내려받아 확인한다
        }
      }
    }
  }

  // 3) 내려받기 — 실패하면 예외 (분석 중단)
  const file = await drive.downloadJson<DocFileV1>(remote.id, remote.appProperties?.enc)
  if (file?.kind !== 'inkpad-doc') throw new Error(`클라우드 노트 ${remote.name}을(를) 해석하지 못했습니다. 정리를 계속할 수 없습니다.`)
  const shas = file.assets.map((a) => a.sha256)
  await putSync(`gcDocRefs:${remote.id}`, { version: remote.version, shas })
  return shas
}

/**
 * GC 분석 — 먼저 이 기기 동기화(pushNow)를 끝내고, 이어서 SYNC_LOCK 안에서
 * Drive 전체를 훑어 후보를 계산한다. 아무것도 옮기지 않는다 — 실행은 runGc가 맡는다.
 */
export async function analyzeGc(excludedDeviceIds: string[] = []): Promise<GcAnalysis> {
  if (!navigator.onLine) throw new Error('오프라인입니다. 연결한 뒤 다시 시도해 주세요.')
  emitProgress({ phase: 'sync' })
  // 먼저 이 기기 동기화 — pushNow가 자기 잠금(ifAvailable) 안에서 push·pull을 끝낸다
  await pushNow()
  return navigator.locks.request(SYNC_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('다른 동기화가 진행 중입니다. 잠시 후 다시 시도해 주세요.')
    return analyzeLocked(excludedDeviceIds)
  }) as Promise<GcAnalysis>
}

async function analyzeLocked(excludedDeviceIds: string[]): Promise<GcAnalysis> {
  const warnings: string[] = []
  const computedAt = Date.now()
  const f = await ensureFolders()
  const g = await ensureGcFolders(f.root)

  // 1. 내 보고를 강제로 올려 최신으로 만든다 (해시가 같아도) — 이미 SYNC_LOCK 안이다
  await reportRefs({ force: true, rootId: f.root })

  // 2. assets 폴더의 전체 에셋 — createdTime·size가 필요해 상세 목록을 쓴다
  const assetFiles = await drive.listFilesDetailed(f.assets)
  const bySha = new Map<string, { files: { fileId: string; name: string; size: number; createdMs: number }[] }>()
  for (const file of assetFiles) {
    const sha = file.appProperties?.sha256 || shaFromName(file.name)
    if (!sha) continue // 파싱 실패한 파일은 절대 후보에 넣지 않는다 (보호)
    const group = bySha.get(sha) ?? { files: [] }
    group.files.push({
      fileId: file.id,
      name: file.name,
      size: Number(file.size ?? 0),
      createdMs: Date.parse(file.createdTime ?? '') || Date.now()
    })
    bySha.set(sha, group)
  }

  // 3. 클라우드 노트의 참조 — 휴지통은 이미 목록에 없다(trashed=false). 하나라도 실패하면 분석 중단
  const docFiles = await drive.listFiles(f.docs)
  const cloudShas = new Set<string>()
  let scanned = 0
  for (const remote of docFiles) {
    emitProgress({ phase: 'docs', done: ++scanned, total: docFiles.length })
    for (const sha of await docRefShas(remote)) cloudShas.add(sha)
  }

  // 4. 고정 리비전(keepForever, 헤드 제외)의 참조 — 리비전은 불변이라 참조를 영구 캐시한다.
  //    내려받기 실패도 분석 중단이다. 병렬도는 3으로 둔다 (fetchRevisionTags 패턴)
  emitProgress({ phase: 'revisions' })
  const revShas = new Set<string>()
  const revTasks: { fileId: string; revId: string }[] = []
  for (const remote of docFiles) {
    const revs = await drive.listRevisions(remote.id)
    revs.forEach((r, i) => {
      if (r.keepForever && i !== revs.length - 1) revTasks.push({ fileId: remote.id, revId: r.id })
    })
  }
  let revIdx = 0
  const revWorker = async () => {
    while (revIdx < revTasks.length) {
      const t = revTasks[revIdx++]
      const key = `gcRevRefs:${t.fileId}:${t.revId}`
      const cached = await getSync<string[]>(key)
      if (cached && Array.isArray(cached)) {
        for (const s of cached) revShas.add(s)
        continue
      }
      const file = await drive.downloadRevision<DocFileV1>(t.fileId, t.revId) // 실패하면 분석 중단
      if (file?.kind !== 'inkpad-doc') throw new Error('버전 기록을 해석하지 못했습니다. 알 수 없는 상태에서는 정리하지 않습니다.')
      const shas = file.assets.map((a) => a.sha256)
      await putSync(key, shas) // 리비전은 불변 — 영구 캐시
      for (const s of shas) revShas.add(s)
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, revTasks.length) }, () => revWorker()))

  // 5. 이 기기의 로컬 참조 — 1단계 보고와 같은 값
  const local = await collectLocalShaRefs()

  // 6. 기기 보고서 — 형식이 틀리거나 프로토콜을 모르면 분석 중단 (알 수 없는 상태에서는 정리하지 않는다)
  emitProgress({ phase: 'devices' })
  const myDeviceId = await getDeviceId()
  const reports: (GcDeviceReport & { fileId: string })[] = []
  for (const rf of await drive.listFiles(g.devices)) {
    let rep: GcDeviceReport | null = null
    try {
      rep = await drive.downloadJson<GcDeviceReport>(rf.id)
    } catch {
      rep = null
    }
    if (
      !rep ||
      rep.kind !== 'inkpad-gc-report' ||
      rep.protocol !== GC_PROTOCOL ||
      typeof rep.deviceId !== 'string' ||
      typeof rep.reportedAt !== 'number' ||
      !Array.isArray(rep.refs) ||
      rep.refs.some((s) => typeof s !== 'string')
    ) {
      throw new Error('형식을 알 수 없는 기기 보고서가 있습니다. 알 수 없는 상태에서는 정리하지 않습니다.')
    }
    reports.push({ ...rep, fileId: rf.id })
  }

  // 7. 후보 계산 — 전체 에셋 − 보호 집합(노트·리비전·로컬·기기 보고) − 유예 기간(24시간)
  const protectedShas = new Set<string>([...cloudShas, ...revShas, ...local.shas])
  for (const rep of reports) {
    if (rep.deviceId === myDeviceId) continue // 내 보고서는 로컬 수집값으로 대체한다
    if (excludedDeviceIds.includes(rep.deviceId)) continue // 제외한 기기는 빼지 않는다 — 보호하지 않는다
    for (const s of rep.refs) protectedShas.add(s)
  }
  const nowMs = Date.now()
  const candidates: GcAnalysis['candidates'] = []
  let candidateBytes = 0
  let protectedCount = 0
  for (const [sha, group] of bySha) {
    if (protectedShas.has(sha)) {
      protectedCount += group.files.length // 같은 sha가 여러 파일이면 모두 보호한다
      continue
    }
    if (group.files.some((fi) => nowMs - fi.createdMs < GRACE_MS)) continue // 유예 — 방금 올린 에셋
    for (const fi of group.files) {
      candidates.push({ sha256: sha, name: fi.name, size: fi.size, fileId: fi.fileId })
      candidateBytes += fi.size
    }
  }

  // 8. garbage 자가 치유 — 보호 집합에 돌아간 에셋이 garbage에 남아 있으면 되돌린다.
  //    제외한 기기의 참조도 포함해 되돌린다 — 되돌리기는 항상 안전하다
  const allKnownShas = new Set<string>([...cloudShas, ...revShas, ...local.shas])
  for (const rep of reports) for (const s of rep.refs) allKnownShas.add(s)
  const toRescue: GcAnalysis['toRescue'] = []
  for (const gf of await drive.listFiles(g.garbage)) {
    const sha = gf.appProperties?.sha256 || shaFromName(gf.name)
    if (!sha || !allKnownShas.has(sha)) continue
    toRescue.push({ sha256: sha, fileId: gf.id, name: gf.name })
  }

  // 경고 — 오래된 보고, 확인되지 않은 참조
  for (const rep of reports) {
    if (rep.deviceId === myDeviceId) continue
    if (nowMs - rep.reportedAt > GC_STALE_MS) warnings.push(`${rep.deviceName}: 보고가 오래됐습니다 — 이 기기에서 동기화하면 더 정확해집니다`)
    if (rep.unresolved > 0) warnings.push(`${rep.deviceName}: 확인되지 않은 참조 ${rep.unresolved}개`)
  }

  return {
    computedAt,
    devices: reports.map((rep) => ({
      deviceId: rep.deviceId,
      deviceName: rep.deviceName,
      reportedAt: rep.reportedAt,
      refs: rep.refs.length,
      unresolved: rep.unresolved,
      isSelf: rep.deviceId === myDeviceId,
      fileId: rep.fileId
    })),
    candidates,
    candidateBytes,
    toRescue,
    protectedCount,
    scannedDocs: docFiles.length,
    warnings
  }
}

/** GC 실행 — 분석 결과의 후보를 garbage로 옮긴다. 역시 SYNC_LOCK 안에서 실행한다 */
export async function runGc(analysis: GcAnalysis, excludedDeviceIds: string[] = []): Promise<GcRunResult> {
  if (!navigator.onLine) throw new Error('오프라인입니다. 연결한 뒤 다시 시도해 주세요.')
  return navigator.locks.request(SYNC_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('다른 동기화가 진행 중입니다. 잠시 후 다시 시도해 주세요.')
    return runLocked(analysis, excludedDeviceIds)
  }) as Promise<GcRunResult>
}

async function runLocked(analysis: GcAnalysis, excludedDeviceIds: string[]): Promise<GcRunResult> {
  const f = await ensureFolders()
  const g = await ensureGcFolders(f.root)
  const myDeviceId = await getDeviceId()
  const deviceName = await getDeviceName()

  // 1. 실행 직전 재확인 — 분석 이후 바뀐 것은 후보에서 뺀다 (판단이 애매하면 지우지 않는다)
  const protectedNow = new Set<string>()
  for (const s of (await collectLocalShaRefs()).shas) protectedNow.add(s)
  // 클라우드 노트 참조 — 노트·리비전 캐시 덕에 대부분 즉시 끝난다. 받기에 실패하면 실행을 중단한다
  for (const remote of await drive.listFiles(f.docs)) {
    for (const sha of await docRefShas(remote)) protectedNow.add(sha)
  }
  // 기기 보고서 재확인 — 분석 뒤 새로 올라온 보고의 참조도 뺀다
  const known = new Map<string, GcAnalysis['devices'][number]>(
    analysis.devices.map((d) => [d.fileId ?? '', d] as [string, GcAnalysis['devices'][number]])
  )
  for (const rf of await drive.listFiles(g.devices)) {
    const k = known.get(rf.id)
    // 분석 때 반영했고 그 뒤 갱신되지 않은 보고서는 다시 받지 않는다
    if (k && k.deviceId !== myDeviceId && !excludedDeviceIds.includes(k.deviceId) && k.reportedAt <= analysis.computedAt) continue
    let rep: GcDeviceReport | null = null
    try {
      rep = await drive.downloadJson<GcDeviceReport>(rf.id)
    } catch {
      throw new Error('기기 보고서를 확인하지 못했습니다. 알 수 없는 상태에서는 정리하지 않습니다.')
    }
    if (!rep || rep.kind !== 'inkpad-gc-report' || rep.protocol !== GC_PROTOCOL || !Array.isArray(rep.refs)) {
      throw new Error('형식을 알 수 없는 기기 보고서가 있습니다. 알 수 없는 상태에서는 정리하지 않습니다.')
    }
    if (rep.deviceId === myDeviceId || excludedDeviceIds.includes(rep.deviceId)) continue
    for (const s of rep.refs) protectedNow.add(s)
  }

  const planned = analysis.candidates.filter((c) => !protectedNow.has(c.sha256))
  // 2. 후보가 0이면 실행 기록 없이 끝낸다
  if (!planned.length) return { runId: null, planned: 0, moved: [], rescued: [], failed: [] }

  // 3. 실행 기록을 먼저 올린다 — 중간에 죽어도 다른 기기는 planned 기준으로 처리한다.
  //    아직 안 옮겨진 sha의 asset: 기록을 지워도 assets에서 다시 찾으므로 무해하다
  const runId = ulid()
  const run: GcRun = {
    kind: 'inkpad-gc-run',
    protocol: GC_PROTOCOL,
    runId,
    deviceId: myDeviceId,
    deviceName,
    startedAt: Date.now(),
    status: 'running',
    excludedDevices: analysis.devices
      .filter((d) => excludedDeviceIds.includes(d.deviceId))
      .map((d) => ({ deviceId: d.deviceId, deviceName: d.deviceName, reportedAt: d.reportedAt })),
    planned,
    moved: []
  }
  const runFile = await drive.upload(
    run,
    { name: `${runId}.json`, mimeType: 'application/json', appProperties: { gcRun: '1', runId } },
    g.runs
  )

  // 4. 옮기기 — 앱은 삭제하지 않고 garbage 폴더로 격리만 한다 (부모만 바꾸므로 fileId는 유지된다)
  const moved: string[] = []
  const failed: GcRunResult['failed'] = []
  let n = 0
  for (const c of planned) {
    emitProgress({ phase: 'run', done: ++n, total: planned.length })
    try {
      await drive.moveFile(c.fileId, f.assets, g.garbage)
      await db.syncState.delete(`asset:${c.sha256}`) // 위치 기록을 지워 복구 경로가 garbage를 찾게 한다
      moved.push(c.sha256)
    } catch (e) {
      if (/\b404\b/.test(String(e))) continue // 이미 없어짐 — 무시한다
      failed.push({ sha256: c.sha256, error: String(e) }) // 다른 실패는 기록하고 계속 진행한다
    }
  }

  // 5. 자가 치유 — 보호 집합으로 돌아온 에셋을 garbage에서 assets로 되돌린다
  const rescued: GcRunResult['rescued'] = []
  for (const r of analysis.toRescue) {
    try {
      await drive.moveFile(r.fileId, g.garbage, f.assets)
      rescued.push(r)
    } catch (e) {
      if (!/\b404\b/.test(String(e))) failed.push({ sha256: r.sha256, error: String(e) })
    }
  }

  // 6. 제외한 기기의 보고서는 휴지통으로 — 그 기기가 다시 동기화하면 자동으로 다시 생긴다 (구현.md 7.3)
  for (const ex of run.excludedDevices) {
    try {
      const rf = await drive.findByName(`${ex.deviceId}.json`, g.devices)
      if (rf) await drive.trash(rf.id)
    } catch (e) {
      console.warn('[gc] 제외 기기 보고서 정리 실패:', e)
    }
  }

  // 7. 실행 기록을 done으로 갱신하고 내 처리 표식을 남긴다
  const finished: GcRun = { ...run, status: 'done', moved, finishedAt: Date.now() }
  try {
    await drive.upload(
      finished,
      { name: `${runId}.json`, mimeType: 'application/json', appProperties: { gcRun: '1', runId } },
      g.runs,
      runFile.id
    )
  } catch (e) {
    console.warn('[gc] 실행 기록 갱신 실패 — 실행 자체는 끝났습니다:', e)
  }
  await putSync(`gcRunSeen:${runId}`, Date.now())
  return { runId, planned: planned.length, moved, rescued, failed }
}
