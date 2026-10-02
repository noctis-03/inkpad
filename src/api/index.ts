import { Hono } from 'hono'

// Phase 2: Google Drive 동기화용 OAuth 서버 (SDF 가이드 3장).
// Access Token은 1시간이면 만료되므로 Refresh Token만 SESSION_SECRET으로
// AES-GCM 암호해 HttpOnly 쿠키에 보관하고, 앱은 /api/auth/token으로
// 새 Access Token을 받아 간다. 앱과 같은 도메인(_worker.js)에서 돌기 때문에
// 쿠키/CORS 문제가 없다.
export interface AuthEnv {
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  SESSION_SECRET?: string
  ALLOWED_EMAIL?: string // 지정하면 이 계정 외 로그인을 차단한다 (개인 앱용)
}

const SCOPES = 'openid email https://www.googleapis.com/auth/drive.file'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const RT_COOKIE = 'rt'
const MAX_AGE = 400 * 24 * 3600 // 브라우저 쿠키 최대 수명(400일). 토큰 요청 때마다 연장됨

type AppEnv = { Bindings: AuthEnv }

const app = new Hono<AppEnv>().basePath('/api')

app.get('/health', (c) =>
  c.json({ ok: true, data: { service: 'inkpad-api', phase: 2, time: Date.now() } })
)

const redirectUriOf = (url: string) => new URL(url).origin + '/api/auth/callback'

app.get('/auth/login', (c) => login(c.env, redirectUriOf(c.req.url)))
app.get('/auth/callback', (c) => callback(c.req.raw, c.env, redirectUriOf(c.req.url)))
app.get('/auth/token', (c) => token(c.req.raw, c.env))
app.post('/auth/logout', (c) => logout(c.req.raw, c.env))

app.notFound((c) => c.json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } }, 404))

// ---------- 핸들러 ----------

function configured(env: AuthEnv): env is AuthEnv & Required<Pick<AuthEnv, 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET' | 'SESSION_SECRET'>> {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET)
}

function login(env: AuthEnv, redirectUri: string): Response {
  if (!configured(env)) return json({ error: 'not_configured' }, 503)

  const state = crypto.randomUUID()
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  auth.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline', // refresh token 발급
    prompt: 'consent', // 매번 refresh token을 새로 받기 위해 필요
    state
  }).toString()

  const headers = new Headers({ Location: auth.toString() })
  headers.append('Set-Cookie', `oauth_state=${state}; Path=/api/auth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`)
  return new Response(null, { status: 302, headers })
}

async function callback(request: Request, env: AuthEnv, redirectUri: string): Promise<Response> {
  if (!configured(env)) return json({ error: 'not_configured' }, 503)

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state || state !== parseCookies(request)['oauth_state']) {
    return new Response('잘못된 요청 (state 불일치)', { status: 400 })
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  })
  const data = (await res.json()) as Record<string, string>
  if (!res.ok || !data.refresh_token) {
    return new Response('토큰 교환 실패: ' + JSON.stringify(data), { status: 400 })
  }

  if (env.ALLOWED_EMAIL) {
    // Google 토큰 엔드포인트에서 TLS로 직접 받은 id_token이므로 서명 검증은 생략
    try {
      const payload = JSON.parse(new TextDecoder().decode(fromB64url(data.id_token!.split('.')[1]))) as {
        email?: string
        email_verified?: boolean
      }
      if (payload.email !== env.ALLOWED_EMAIL || !payload.email_verified) {
        return new Response('허용되지 않은 계정입니다.', { status: 403 })
      }
    } catch {
      return new Response('id_token을 읽지 못했습니다.', { status: 400 })
    }
  }

  const headers = new Headers({ Location: '/' })
  headers.append('Set-Cookie', rtCookie(await encrypt(data.refresh_token, env.SESSION_SECRET)))
  headers.append('Set-Cookie', 'oauth_state=; Path=/api/auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax')
  return new Response(null, { status: 302, headers })
}

async function token(request: Request, env: AuthEnv): Promise<Response> {
  if (!configured(env)) return json({ error: 'not_configured' }, 503)

  const enc = parseCookies(request)[RT_COOKIE]
  if (!enc) return json({ error: 'no_session' }, 401)

  let refreshToken: string
  try {
    refreshToken = await decrypt(enc, env.SESSION_SECRET)
  } catch {
    return json({ error: 'bad_session' }, 401, clearRtCookie())
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  })
  const data = (await res.json()) as Record<string, string>
  if (!res.ok) {
    // invalid_grant: 사용자가 권한을 취소했거나 6개월 미사용 등으로 refresh token이 무효화된 경우
    if (data.error === 'invalid_grant') return json({ error: 'reauth' }, 401, clearRtCookie())
    return json({ error: data.error ?? 'google_error' }, 502)
  }
  // 쿠키 수명 연장(슬라이딩 방식)
  return json({ access_token: data.access_token, expires_in: data.expires_in }, 200, rtCookie(enc))
}

async function logout(request: Request, env: AuthEnv): Promise<Response> {
  const enc = parseCookies(request)[RT_COOKIE]
  if (enc && env.SESSION_SECRET) {
    try {
      const rt = await decrypt(enc, env.SESSION_SECRET)
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(rt)}`, { method: 'POST' })
    } catch {
      /* 무시 */
    }
  }
  return json({ ok: true }, 200, clearRtCookie())
}

// ---------- 유틸 ----------

const rtCookie = (v: string) => `${RT_COOKIE}=${v}; Path=/api/auth; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Strict`
const clearRtCookie = () => `${RT_COOKIE}=; Path=/api/auth; Max-Age=0; HttpOnly; Secure; SameSite=Strict`

function json(body: unknown, status: number, setCookie?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  if (setCookie) headers.append('Set-Cookie', setCookie)
  return new Response(JSON.stringify(body), { status, headers })
}

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {}
  ;(req.headers.get('Cookie') ?? '').split(';').forEach((p) => {
    const i = p.indexOf('=')
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim()
  })
  return out
}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0))

async function getKey(secret: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
async function encrypt(text: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(secret), new TextEncoder().encode(text))
  return `${b64url(iv)}.${b64url(new Uint8Array(ct))}`
}
async function decrypt(value: string, secret: string) {
  const [iv, ct] = value.split('.')
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv) }, await getKey(secret), fromB64url(ct))
  return new TextDecoder().decode(pt)
}

export default app
