// 웹 바로가기: 라이브러리 카드를 누르면 지정한 사이트를 바로 연다.
// 따로 저장소·동기화 경로를 만들지 않고 "HTML 앱 1개"로 저장한다 — 본문은 주소를 담은 작은 HTML이고
// <meta name="inkpad-shortcut" content="URL">로 바로가기임을 표시한다. 그래서 앱과 똑같이 Drive에 올라가고
// 다른 기기로 설치·업데이트되며, 바로가기를 모르는 예전 버전에서 실행해도 "열기" 링크가 있는 페이지로 보인다.
import { normalizeBlockUrl } from '../engine/blocks'
import type { HtmlApp } from './model'

const META = 'inkpad-shortcut'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 입력한 주소를 바로가기 주소로 — 스킴이 없으면 https://. 비었거나 위험한 스킴이면 null */
export function normalizeShortcutUrl(raw: string): string | null {
  const u = normalizeBlockUrl(raw)
  return u ? u : null
}

/** 주소에서 기본 이름 (example.com) */
export function shortcutHost(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname.replace(/^www\./, '') || url
  } catch {
    return url
  }
}

export function shortcutHtml(url: string, title: string): string {
  const u = esc(url)
  const t = esc(title)
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="${META}" content="${u}">
<title>${t}</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px system-ui,sans-serif;background:#f7f6f2;color:#222}
main{text-align:center;padding:24px}
a{display:inline-block;margin-top:12px;padding:12px 20px;border-radius:12px;background:#2f6fed;color:#fff;text-decoration:none}
p{color:#666;word-break:break-all}
</style>
</head>
<body>
<main>
<h1>${t}</h1>
<p>${u}</p>
<a href="${u}" target="_blank" rel="noopener noreferrer">사이트 열기</a>
</main>
</body>
</html>
`
}

/** 바로가기면 (다시 검증한) 주소, 아니면 null — 동기화로 들어온 본문도 이 검사를 거친다 */
export function shortcutUrlOf(app: Pick<HtmlApp, 'html'>): string | null {
  // 바로가기 본문은 작다 — 큰 앱 HTML을 통째로 훑지 않는다
  if (app.html.length > 4096 || !app.html.includes(META)) return null
  const m = new RegExp(`<meta\\s+name="${META}"\\s+content="([^"]*)"`, 'i').exec(app.html)
  if (!m) return null
  const raw = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  return normalizeShortcutUrl(raw)
}

/** 새 창(iPad 홈 화면 앱이면 앱 위의 Safari 화면)으로 연다 — 누른 순간에 불러야 팝업 차단에 걸리지 않는다 */
export function openShortcut(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}
