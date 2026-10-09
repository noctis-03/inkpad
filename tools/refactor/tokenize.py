#!/usr/bin/env python3
"""styles.css 시맨틱 토큰 리팩터링 + 다크 모드 주입.

- 첫 :root 를 확장해 시맨틱 토큰을 정의하고 다크 블록(@media prefers-color-scheme)을 붙인다.
- 뒤쪽의 모션 토큰 :root 는 첫 :root 로 흡수하고 제거한다(소스 순서로 다크 값을 덮어쓰지 않게).
- 나머지 본문의 하드코딩 hex 를 토큰으로 치환한다. 일부는 속성 문맥을 본다
  (#ffffff: background → --surface / color → --on-ink).
- 종이(캔버스) 위 색(격자·줄·점, 선택 영역 점선)은 다크에서도 종이가 흰색이므로 건드리지 않는다.
"""
import re, sys

PATH = 'src/styles.css'
css = open(PATH, encoding='utf-8').read()

# ── 1. 첫 :root 확장 + 다크 블록 ──────────────────────────────────────
OLD_ROOT = """:root {
  --paper: #f8f7f4;
  --bg-pattern: #cfcac0;
  --ink: #1f2937;
  --muted: #6b7280;
  --line: #e5e1d8;
  --panel: #ffffffee;
  --accent: #2563eb;
  --accent-soft: #dbeafe;
  --danger: #dc2626;
  --ft-spring: cubic-bezier(.2, .9, .25, 1.05);
  --ft-ease: cubic-bezier(.2, .8, .2, 1);
  --toolbar-h: 52px;
  --safe-top: env(safe-area-inset-top, 0px);
  font-family: -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Pretendard', system-ui, sans-serif;
  color: var(--ink);
}"""

NEW_ROOT = """:root {
  color-scheme: light;

  /* ── 표면 (종이 · 카드 · 채움) ── */
  --paper: #f8f7f4;        /* 앱 바탕 */
  --paper-2: #faf9f6;      /* 사이드바·패널 바탕 */
  --surface: #ffffff;      /* 카드·시트 */
  --surface-2: #f3f4f6;    /* 옅은 채움(검색창·칩) */
  --surface-3: #eef0f3;    /* 한 단계 더 */
  --panel: #ffffffee;      /* 상단바·떠 있는 패널(반투명) */

  /* ── 경계 ── */
  --line: #e5e1d8;         /* 따뜻한 경계(종이 결) */
  --line-2: #e5e7eb;       /* 차가운 경계(중립) */

  /* ── 글자 ── */
  --ink: #1f2937;
  --ink-2: #374151;
  --muted: #5b6472;        /* AA 대비 확보를 위해 기존 #6b7280 에서 진하게 */
  --muted-2: #9ca3af;
  --on-ink: #ffffff;       /* 잉크색 면 위 글자 — 두 테마 공통 */

  /* ── 상호작용 ── */
  --press: #1f29370d;
  --hover: #0000000d;
  --focus-outline: #1f293759;
  --focus-ring: 0 0 0 4px #1f29370a;

  /* ── 강조 (잉크 블루) ── */
  --accent: #2563eb;
  --accent-ink: #1d4ed8;
  --accent-soft: #dbeafe;
  --accent-soft-2: #eff6ff;
  --accent-line: #bfdbfe;
  --accent-line-2: #93c5fd;

  /* ── 상태 ── */
  --success: #16a34a;
  --success-ink: #15803d;
  --success-soft: #f0fdf4;
  --success-line: #bbf7d0;
  --warn: #d97706;
  --warn-ink: #b45309;
  --warn-soft: #fffbeb;
  --warn-line: #fde68a;
  --danger: #dc2626;
  --danger-2: #f87171;
  --danger-ink: #b91c1c;
  --danger-soft: #fef2f2;
  --danger-line: #fecaca;
  --danger-line-2: #fca5a5;

  /* ── 개체 색 (앱 · 파일) ── */
  --app: #4f46e5;
  --app-2: #a855f7;
  --app-ink: #5b21b6;
  --app-soft: #ede9fe;
  --app-line: #c4b5fd;
  --file: #0f766e;

  /* ── 그림자 ── */
  --raise: 0 1px 2px #0000001a, 0 0 0 .5px #0000000f;
  --e1: 0 1px 3px #0000001a, 0 0 0 1px #0000000d;
  --e2: 0 8px 24px #0000001f;
  --e3: 0 24px 60px #0000004d;

  /* ── 곡률 ── */
  --r-sm: 8px;
  --r-md: 12px;
  --r-lg: 18px;

  /* ── 타이포 스케일 ── */
  --fs-xs: 11px;
  --fs-sm: 12px;
  --fs-md: 14px;
  --fs-lg: 16px;
  --fs-xl: 20px;
  --fs-2xl: 24px;

  /* ── 모션 ── */
  --tray: #efede7;
  --spring-pop: cubic-bezier(.34, 1.56, .64, 1);
  --ft-spring: cubic-bezier(.2, .9, .25, 1.05);
  --ft-ease: cubic-bezier(.2, .8, .2, 1);
  --dur-fast: 120ms;
  --dur-base: 280ms;
  --dur-slow: 520ms;

  /* ── 필기 캔버스(종이) — 테마와 무관하게 종이는 흰색이다 ── */
  --bg-pattern: #cfcac0;

  --toolbar-h: 52px;
  --safe-top: env(safe-area-inset-top, 0px);
  font-family: -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Pretendard', system-ui, sans-serif;
  color: var(--ink);
}

/* ── 다크 모드: 먹지(墨紙) — 화면은 어둡게, 종이는 그대로 흰색 ── */
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;

    --paper: #14161a;
    --paper-2: #191c21;
    --surface: #1e2228;
    --surface-2: #262b32;
    --surface-3: #2c323a;
    --panel: #1e2228ee;

    --line: #2e343c;
    --line-2: #343b44;

    --ink: #e8e6e1;
    --ink-2: #cbd2da;
    --muted: #9aa4b1;
    --muted-2: #6f7885;
    --on-ink: #ffffff;

    --press: #ffffff14;
    --hover: #ffffff0f;
    --focus-outline: #ffffff66;
    --focus-ring: 0 0 0 4px #ffffff1a;

    --accent: #6ea8ff;
    --accent-ink: #9cc4ff;
    --accent-soft: #1e3358;
    --accent-soft-2: #16243d;
    --accent-line: #2f4d7a;
    --accent-line-2: #3f6399;

    --success: #4ade80;
    --success-ink: #86efac;
    --success-soft: #14291f;
    --success-line: #245c3b;
    --warn: #fbbf24;
    --warn-ink: #fcd34d;
    --warn-soft: #2b2110;
    --warn-line: #5c4718;
    --danger: #f87171;
    --danger-2: #fca5a5;
    --danger-ink: #fca5a5;
    --danger-soft: #2c1618;
    --danger-line: #5c2a2e;
    --danger-line-2: #7a3538;

    --app: #a78bfa;
    --app-2: #c4b5fd;
    --app-ink: #c4b5fd;
    --app-soft: #241f3d;
    --app-line: #3f3663;
    --file: #5eead4;

    --raise: 0 1px 2px #00000073, 0 0 0 .5px #ffffff14;
    --e1: 0 1px 3px #00000080, 0 0 0 1px #ffffff12;
    --e2: 0 8px 24px #00000099;
    --e3: 0 24px 60px #000000b3;

    --tray: #262b32;
  }
}"""

if OLD_ROOT not in css:
    sys.exit('ERROR: 첫 :root 블록을 찾지 못했습니다')
css = css.replace(OLD_ROOT, NEW_ROOT, 1)

# ── 2. 뒤쪽 모션 토큰 :root 제거(첫 :root 로 흡수) ─────────────────────
OLD_MOTION_ROOT = """/* 3장 · 디자인 토큰 */
:root {
  --tray: #efede7;
  --press: #1f29370d;
  --spring-pop: cubic-bezier(.34, 1.56, .64, 1);
  --raise: 0 1px 2px #0000001a, 0 0 0 .5px #0000000f;
  --focus-ring: 0 0 0 4px #1f29370a;
  --dur-fast: 120ms;
  --dur-base: 280ms;
  --dur-slow: 520ms;
}"""
NEW_MOTION_ROOT = """/* 3장 · 디자인 토큰 — 모션 토큰은 파일 상단 :root 로 옮겼다(다크 모드와 한 곳에서 관리) */"""
if OLD_MOTION_ROOT not in css:
    sys.exit('ERROR: 모션 토큰 :root 블록을 찾지 못했습니다')
css = css.replace(OLD_MOTION_ROOT, NEW_MOTION_ROOT, 1)

# ── 3. 토큰 정의 구역 보호 ─────────────────────────────────────────────
head_end = css.index('/* 모션 끄기')  # 다크 블록까지 포함한 토큰 구역의 끝
head, body = css[:head_end], css[head_end:]

# ── 4. 치환 표 ────────────────────────────────────────────────────────
MAP = {
    '#fffffff2': 'var(--panel)', '#ffffffee': 'var(--panel)',
    '#ffffffe6': 'var(--panel)', '#fffffff5': 'var(--panel)',
    '#f8f7f4': 'var(--paper)',
    '#faf9f6': 'var(--paper-2)', '#fbfaf7': 'var(--paper-2)',
    '#f4f2ee': 'var(--paper-2)', '#ece9e2': 'var(--paper-2)',
    '#f3f4f6': 'var(--surface-2)', '#f1efea': 'var(--surface-2)',
    '#f1f5f9': 'var(--surface-2)', '#f8fafc': 'var(--surface-2)',
    '#e9e7e2': 'var(--surface-2)', '#f9fafb': 'var(--surface-2)',
    '#eef0f3': 'var(--surface-3)', '#eef2f7': 'var(--surface-3)',
    '#e2e5ea': 'var(--surface-3)', '#f1f1f1': 'var(--surface-3)',
    '#e5e7eb': 'var(--line-2)', '#e2e8f0': 'var(--line-2)',
    '#ece8df': 'var(--line)', '#e9e5dc': 'var(--line)',
    '#cbd5e1': 'var(--muted-2)', '#d1d5db': 'var(--muted-2)',
    '#9ca3af': 'var(--muted-2)', '#a8a29e': 'var(--muted-2)',
    '#6b7280': 'var(--muted)', '#b8b2a7': 'var(--muted)',
    '#4b5563': 'var(--ink-2)', '#374151': 'var(--ink-2)',
    '#475569': 'var(--ink-2)', '#111827': 'var(--ink)', '#1f2937': 'var(--ink)',
    '#1f293759': 'var(--focus-outline)',
    # 강조
    '#2563eb': 'var(--accent)', '#1d4ed8': 'var(--accent-ink)', '#1e3a8a': 'var(--accent-ink)',
    '#3b82f6': 'var(--accent)',
    '#dbeafe': 'var(--accent-soft)', '#eff6ff': 'var(--accent-soft-2)',
    '#f5f9ff': 'var(--accent-soft-2)', '#eef4ff': 'var(--accent-soft-2)',
    '#bfdbfe': 'var(--accent-line)', '#93c5fd': 'var(--accent-line-2)',
    # 성공
    '#16a34a': 'var(--success)', '#22c55e': 'var(--success)', '#4ade80': 'var(--success)',
    '#15803d': 'var(--success-ink)', '#047857': 'var(--success-ink)', '#166534': 'var(--success-ink)',
    '#f0fdf4': 'var(--success-soft)', '#ecfdf5': 'var(--success-soft)', '#dcfce7': 'var(--success-soft)',
    '#bbf7d0': 'var(--success-line)', '#6ee7b7': 'var(--success-line)',
    # 경고
    '#d97706': 'var(--warn)', '#f59e0b': 'var(--warn)', '#facc15': 'var(--warn)',
    '#b45309': 'var(--warn-ink)', '#92400e': 'var(--warn-ink)', '#9a3412': 'var(--warn-ink)',
    '#fffbeb': 'var(--warn-soft)', '#fef3c7': 'var(--warn-soft)', '#fff7ed': 'var(--warn-soft)',
    '#fde68a': 'var(--warn-line)', '#fcd34d': 'var(--warn-line)',
    # 위험
    '#dc2626': 'var(--danger)', '#ef4444': 'var(--danger)', '#ef4444cc': 'var(--danger)',
    '#b91c1c': 'var(--danger-ink)', '#991b1b': 'var(--danger-ink)',
    '#fef2f2': 'var(--danger-soft)', '#fee2e2': 'var(--danger-soft)',
    '#fecaca': 'var(--danger-line)', '#fca5a5': 'var(--danger-line-2)',
    '#f87171': 'var(--danger-2)',
    # 앱 · 파일
    '#4f46e5': 'var(--app)', '#7c3aed': 'var(--app)', '#5b21b6': 'var(--app-ink)',
    '#a855f7': 'var(--app-2)', '#c4b5fd': 'var(--app-line)',
    '#ede9fe': 'var(--app-soft)', '#f5f3ff': 'var(--app-soft)',
    '#0f766e': 'var(--file)',
}

COLOR_PROPS = ('color', 'fill', 'stroke', 'caret-color')
DARK_OVERLAY = {'#0000000d', '#00000008', '#0000000a', '#1f293705'}

hits = {}
def sub_decl(m):
    prop, val = m.group(1), m.group(2)
    p = prop.strip().lower()
    # 속성 문맥을 보는 특수 케이스
    if p in COLOR_PROPS:
        if re.search(r'#(?:fff|ffffff)\b', val, re.I):
            hits['#ffffff(color)'] = hits.get('#ffffff(color)', 0) + 1
            val = re.sub(r'#(?:fff|ffffff)\b', 'var(--on-ink)', val, flags=re.I)
    elif p in ('background', 'background-color'):
        if re.search(r'#(?:fff|ffffff)\b', val, re.I):
            hits['#ffffff(bg)'] = hits.get('#ffffff(bg)', 0) + 1
            val = re.sub(r'#(?:fff|ffffff)\b', 'var(--surface)', val, flags=re.I)
        for hx in DARK_OVERLAY:
            if hx in val.lower():
                hits[hx + '(bg)'] = hits.get(hx + '(bg)', 0) + 1
                val = re.sub(re.escape(hx), 'var(--hover)', val, flags=re.I)
    # 일반 치환
    for hx, tok in MAP.items():
        if hx in val.lower():
            n = val.lower().count(hx)
            hits[hx] = hits.get(hx, 0) + n
            val = re.sub(re.escape(hx), tok, val, flags=re.I)
    return f'{prop}:{val}'

body = re.sub(r'([-a-zA-Z]+)\s*:\s*([^;{}]+)', sub_decl, body)

open(PATH, 'w', encoding='utf-8').write(head + body)

# ── 5. 리포트 ─────────────────────────────────────────────────────────
print(f'치환 {sum(hits.values())}건 / {len(hits)}종')
left = re.findall(r'#[0-9a-fA-F]{3,8}\b', head + body)
from collections import Counter
c = Counter(h.lower() for h in left)
print(f'남은 hex {len(left)}개 / 고유 {len(c)}개')
print('상위 남은 색:', c.most_common(12))
