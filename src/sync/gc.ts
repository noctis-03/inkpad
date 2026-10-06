// 에셋 GC — 기기별 참조 보고 방식 (구현.md).
//
// 규칙:
//  - 앱은 에셋을 절대 삭제하지 않는다. 후보는 Drive의 Inkpad/garbage 폴더로 옮기기(격리)만 하고,
//    참조 중인 에셋을 garbage에서 발견하면 즉시 assets 폴더로 되돌린다. 최종 삭제는 사용자가 Drive에서 직접 한다.
//  - 판단은 항상 sha256 단위로 한다 — assetId는 기기마다 다를 수 있다.
//  - 모르는 것(이름 파싱 실패·형식 불일치·받기 실패)은 보호한다 — 절대 후보로 취급하지 않는다.
//  - 보고(reportRefs)는 SYNC_LOCK 안에서 동기화(pushNow/pullNow) 끝에 불린다. 실패해도 동기화를 실패시키지 않는다.
//
// 순환 import를 피하려고 sync.ts를 import하지 않는다 — folders·drive·token·refs·db만 쓴다.
// 분석과 실행(analyzeGc·runGc)은 gcRun.ts에 있다.
import { sha256Hex } from '../shared/util'
import { db } from '../storage/db'
import * as drive from './drive'
import { ensureFolders, getSync, putSync, type FileRecord } from './folders'
import { collectLocalShaRefs } from './refs'
import { getAccessToken, getDeviceId, getDeviceName } from './token'

/** GC 프로토콜 버전 — 복구 경로를 갖춘 앱만 보고서를 올린다 (보고 자체가 복구 경로의 증명이다) */
export const GC_PROTOCOL = 1

/** 보고서를 다시 올리는 주기 — 해시가 같아도 하루에 한 번은 시각을 새로 고친다 */
const REPORT_REFRESH_MS = 24 * 60 * 60 * 1000

/** 기기 보고서 gc/devices/{deviceId}.json (평문 JSON) */
export interface GcDeviceReport {
  kind: 'inkpad-gc-report'
  protocol: number
  deviceId: string
  deviceName: string
  reportedAt: number
  refs: string[] // 참조 sha256 (정렬, 중복 제거)
  unresolved: number // assetId는 있는데 db.assets 행이 없어 sha를 모르는 참조 수
}

/** GC 실행 기록 gc/runs/{runId}.json (평문 JSON) — 감사 로그 겸 다른 기기 통지 */
export interface GcRun {
  kind: 'inkpad-gc-run'
  protocol: number
  runId: string
  deviceId: string
  deviceName: string
  startedAt: number
  finishedAt?: number
  status: 'running' | 'done' | 'aborted'
  excludedDevices: { deviceId: string; deviceName: string; reportedAt: number }[]
  planned: { sha256: string; name: string; size: number; fileId: string }[]
  moved: string[] // 실제로 옮긴 sha256
}

/** GC 전용 Drive 폴더 — syncState.gcFolders에 캐시한다 */
export interface GcFolders {
  gc: string
  devices: string
  runs: string
  garbage: string
}

async function findOrCreate(name: string, parentId: string, cachedId?: string): Promise<string> {
  if (cachedId) {
    const m = await drive.getMeta(cachedId).catch(() => null)
    if (m && !m.trashed) return cachedId
  }
  return (await drive.findFolder(name, parentId)) ?? (await drive.createFolder(name, parentId))
}

/**
 * GC 전용 폴더(garbage·gc·gc/devices·gc/runs)를 확보한다 — ensureFolders를 고치지 않고
 * 별도 함수로 둔다. 동기화 핫패스 비용을 늘리지 않기 위해서다 (구현.md 6.3).
 * garbage 폴더가 사라졌으면 새로 만들기만 한다 — 기록 재갱신(resetRemoteRecords)은 하지 않는다.
 */
export async function ensureGcFolders(rootId?: string): Promise<GcFolders> {
  const root = rootId ?? (await ensureFolders()).root
  const cached = await getSync<GcFolders>('gcFolders')
  const [gc, garbage] = await Promise.all([findOrCreate('gc', root, cached?.gc), findOrCreate('garbage', root, cached?.garbage)])
  const [devices, runs] = await Promise.all([findOrCreate('devices', gc, cached?.devices), findOrCreate('runs', gc, cached?.runs)])
  const next: GcFolders = { gc, devices, runs, garbage }
  if (!cached || cached.gc !== gc || cached.devices !== devices || cached.runs !== runs || cached.garbage !== garbage) {
    await putSync('gcFolders', next)
  }
  return next
}

/**
 * garbage에서 이름으로 찾아, 있으면 assets로 되돌리고 FileRecord를 돌려준다 (구현.md 6.6).
 * 참조 중인 에셋을 garbage에서 발견하면 그 즉시 되돌리는 것이 원칙이다.
 * 폴더 이동은 부모만 바꾸므로 fileId·내용·이름은 그대로다.
 */
export async function rescueFromGarbage(name: string): Promise<FileRecord | null> {
  const g = await ensureGcFolders()
  const found = await drive.findByName(name, g.garbage)
  if (!found) return null
  const { assets } = await ensureFolders()
  const moved = await drive.moveFile(found.id, g.garbage, assets)
  console.info('[gc] garbage에서 에셋을 되돌렸습니다:', name)
  return { fileId: moved.id, version: moved.version }
}

/**
 * 동기화 끝에 내 참조 sha 목록을 gc/devices/{deviceId}.json에 올린다 (구현.md 6.5).
 * 업로드 조건: refs 해시가 달라졌거나 마지막 보고가 24시간 넘었을 때.
 * 이어서 다른 기기의 GC 실행 기록을 처리한다(consumeGcRuns). 실패해도 동기화를 실패시키지 않는다.
 */
export async function reportRefs(opts: { force?: boolean; rootId?: string } = {}): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return // 오프라인 — 조용히 건너뛴다
    try {
      await getAccessToken()
    } catch {
      return // 로그인 전·서버 미설정 — 조용히 건너뛴다
    }
    const g = await ensureGcFolders(opts.rootId)
    try {
      const deviceId = await getDeviceId()
      const deviceName = await getDeviceName()
      const { shas, unresolved } = await collectLocalShaRefs()
      const refs = [...shas].sort()
      const hash = await sha256Hex(new TextEncoder().encode(refs.join('\n')))
      const lastHash = await getSync<string>('gcReportHash')
      const lastAt = (await getSync<number>('gcReportAt')) ?? 0
      if (!opts.force && hash === lastHash && Date.now() - lastAt < REPORT_REFRESH_MS) return

      const report: GcDeviceReport = {
        kind: 'inkpad-gc-report',
        protocol: GC_PROTOCOL,
        deviceId,
        deviceName,
        reportedAt: Date.now(),
        refs,
        unresolved
      }
      const name = `${deviceId}.json`
      // 덮어쓸 파일을 고른다 — 기록(gcReportFile) → Drive 이름 검색 순서. 404면 새로 만든다
      let fileId: string | undefined
      const saved = await getSync<FileRecord>('gcReportFile')
      if (saved?.fileId) {
        const m = await drive.getMeta(saved.fileId).catch(() => null)
        if (m && !m.trashed) fileId = m.id
      }
      if (!fileId) {
        const found = await drive.findByName(name, g.devices)
        if (found) fileId = found.id
      }
      const res = await drive.upload(
        report,
        { name, mimeType: 'application/json', appProperties: { gcReport: '1', deviceId } },
        g.devices,
        fileId
      )
      await putSync('gcReportFile', { fileId: res.id, version: res.version })
      await putSync('gcReportHash', hash)
      await putSync('gcReportAt', Date.now())
    } finally {
      // 보고를 올리든 올리지 않든, 다른 기기의 GC 실행 기록은 처리한다 (구현.md 6.7)
      await consumeGcRuns(g)
    }
  } catch (e) {
    console.warn('[gc] 참조 보고·실행 기록 처리 실패 — 동기화는 계속됩니다:', e)
  }
}

/**
 * 다른 기기가 남긴 GC 실행 기록(gc/runs)을 처리한다 (구현.md 6.7). reportRefs 끝에 불린다.
 *  - planned 중 이 기기가 참조하는 sha는 경쟁 상황으로 잘못 격리된 것 — 즉시 garbage에서 되돌린다.
 *  - 나머지는 로컬 asset: 위치 기록을 지운다 — 다시 필요해지면 복구 경로(rescueFromGarbage)가 찾아 되돌린다.
 *  - status가 running인 기록은 seen 처리하지 않는다 — done이 되면 한 번 더 처리한다(멱등).
 */
export async function consumeGcRuns(g?: GcFolders): Promise<void> {
  const folders = g ?? (await ensureGcFolders())
  const runs = await drive.listFiles(folders.runs)
  for (const rf of runs) {
    const runId = rf.name.replace(/\.json$/, '')
    if (await getSync<number>(`gcRunSeen:${runId}`)) continue
    let run: GcRun | null = null
    try {
      run = await drive.downloadJson<GcRun>(rf.id)
    } catch (e) {
      console.warn('[gc] 실행 기록을 받지 못했습니다:', runId, e)
      continue
    }
    if (!run || run.kind !== 'inkpad-gc-run' || !Array.isArray(run.planned)) continue

    const { shas } = await collectLocalShaRefs()
    for (const p of run.planned) {
      if (!p?.sha256) continue
      if (shas.has(p.sha256)) {
        // 이 기기가 참조 중 — 즉시 되돌린다. 아직 옮겨지지 않았으면 garbage에 없을 뿐, 기록은 남는다
        try {
          await rescueFromGarbage(p.name)
        } catch (e) {
          console.warn('[gc] 격리된 에셋 되돌리기 실패:', p.sha256, e)
        }
      } else {
        await db.syncState.delete(`asset:${p.sha256}`)
      }
    }
    if (run.status !== 'running') await putSync(`gcRunSeen:${runId}`, Date.now())
  }
}
