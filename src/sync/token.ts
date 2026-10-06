// Access token 캐시 및 자동 갱신 (SDF 가이드 4장)
// 만료 60초 전이면 /api/auth/token으로 새 토큰을 받는다.
// 동시에 여러 요청이 와도 갱신 요청은 한 번만 나간다.
import { ulid } from '../shared/ulid'
import { db } from '../storage/db'
export class AuthRequiredError extends Error {}
export class SyncNotConfiguredError extends Error {}

let cached: { token: string; exp: number } | null = null
let inflight: Promise<string> | null = null

/** 유효한 access token을 반환. 만료 60초 전이면 자동으로 새로 받음 */
export function getAccessToken(force = false): Promise<string> {
  if (!force && cached && cached.exp - 60_000 > Date.now()) return Promise.resolve(cached.token)
  if (inflight) return inflight

  inflight = (async () => {
    try {
      const res = await fetch('/api/auth/token', { credentials: 'same-origin', cache: 'no-store' })
      if (res.status === 401) {
        cached = null
        throw new AuthRequiredError('로그인 필요')
      }
      if (res.status === 503) throw new SyncNotConfiguredError('서버에 OAuth 설정이 없습니다')
      if (!res.ok) throw new Error(`token 요청 실패: ${res.status}`)
      const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in: number }
      cached = { token: access_token, exp: Date.now() + expires_in * 1000 }
      return access_token
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** 페이지 이동 방식이라 iOS/PWA에서도 안정적 */
export function login() {
  location.href = '/api/auth/login'
}

export async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
  } catch {
    /* 오프라인 등 */
  }
  cached = null
}

// ───────────────── 이 기기 ID (GC 보고서 파일 이름용) ─────────────────

/**
 * 이 기기의 안정적인 ID (ULID) — GC 보고서 파일(gc/devices/{deviceId}.json)의 이름에 쓴다 (sync/gc.ts).
 * 로컬 초기화(wipeLocalData) 뒤에는 새 ID가 생긴다. 의도된 동작이다 — 옛 보고서는
 * "오래된 기기"로 보이고 사용자가 제외하면 된다 (구현.md 6.2).
 */
export async function getDeviceId(): Promise<string> {
  const row = await db.syncState.get('deviceId')
  if (row?.value) return row.value as string
  const id = ulid()
  await db.syncState.put({ key: 'deviceId', value: id })
  return id
}

// ───────────────── 이 기기 이름 (커밋 메시지·버전 기록 표시용) ─────────────────

/** 이 기기를 구분하는 이름 — 커밋 메시지와 버전 기록에 들어간다 (git의 user.name 역할) */
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
