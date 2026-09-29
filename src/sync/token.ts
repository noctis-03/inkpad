// GitHub 연결 설정 — 토큰·저장소·브랜치·기기 이름을 IndexedDB(syncState)에 보관한다.
// 예전 Google OAuth 세션 서버(/api/auth/*)는 더 쓰지 않는다: 브라우저가 GitHub API를
// 직접 호출하므로 서버 설정이 필요 없다.
import { db } from '../storage/db'

/** 토큰이 무효·만료·권한 없음 → 설정 화면에서 다시 연결해야 한다 */
export class AuthRequiredError extends Error {}
/** 연결 설정 자체가 없음 */
export class SyncNotConfiguredError extends Error {}

export interface GhConfig {
  /** "owner/repo" */
  repo: string
  branch: string
  token: string
}

export async function getConfig(): Promise<GhConfig | undefined> {
  const row = await db.syncState.get('ghConfig')
  return row?.value as GhConfig | undefined
}

export async function saveConfig(cfg: GhConfig): Promise<void> {
  await db.syncState.put({ key: 'ghConfig', value: cfg })
}

export async function clearConfig(): Promise<void> {
  await db.syncState.delete('ghConfig')
}

/** 이 기기를 구분하는 이름 — 커밋 메시지에 들어간다 (git의 user.name 역할) */
export async function getDeviceName(): Promise<string> {
  const row = await db.syncState.get('deviceName')
  if (row?.value) return row.value as string
  const auto = guessDeviceName()
  await db.syncState.put({ key: 'deviceName', value: auto })
  return auto
}

export async function setDeviceName(name: string): Promise<void> {
  await db.syncState.put({ key: 'deviceName', value: name.trim() || guessDeviceName() })
}

function guessDeviceName(): string {
  const ua = navigator.userAgent
  const suffix = Math.random().toString(36).slice(2, 6)
  if (/iPad/.test(ua)) return `iPad-${suffix}`
  if (/iPhone/.test(ua)) return `iPhone-${suffix}`
  if (/Macintosh|Mac OS/.test(ua)) return `Mac-${suffix}`
  if (/Android/.test(ua)) return `Android-${suffix}`
  if (/Win/.test(ua)) return `PC-${suffix}`
  return `기기-${suffix}`
}
