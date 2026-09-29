/**
 * HandNote — Cloudflare Worker
 * 정적 자산(public/)을 서빙하고 아주 작은 상태 API 를 제공합니다.
 * 노트 데이터는 서버에 저장되지 않습니다(브라우저 IndexedDB + 사용자 개인 Google Drive).
 * 접근 제어는 코드가 아니라 Cloudflare Access(Zero Trust)가 담당합니다.
 */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline' https://accounts.google.com",
    "connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com https://accounts.google.com",
    "frame-src https://accounts.google.com",
    "font-src 'self' data:",
    "base-uri 'self'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
};

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status: status || 200,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      SECURITY_HEADERS
    )
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return json({ ok: true, service: 'handnote', time: new Date().toISOString() });
    }

    // Cloudflare Access 가 붙어 있으면 인증된 사용자 정보를 돌려줍니다.
    if (url.pathname === '/api/me') {
      let identity = null;
      if (ctx && ctx.access && ctx.access.getIdentity) {
        try { identity = await ctx.access.getIdentity(); } catch (e) { identity = null; }
      }
      const email = (identity && identity.email) ||
        request.headers.get('cf-access-authenticated-user-email') || '';
      return json({
        access: !!(identity || request.headers.get('cf-access-jwt-assertion')),
        authenticated: !!email,
        email: email || null,
        note: email
          ? 'Cloudflare Access 로 보호되고 있습니다.'
          : 'Access 인증 정보가 없습니다. Zero Trust > Access 에 이 워커(또는 호스트 이름)가 등록되어 있는지 확인하세요.'
      });
    }

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    if (url.pathname === '/sw.js') out.headers.set('Cache-Control', 'no-cache');
    return out;
  }
};
