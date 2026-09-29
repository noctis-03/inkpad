# HandNote — 손글씨 필기 노트

펜으로 쓰는 손글씨 노트입니다. **외부 라이브러리 0개 · 단일 HTML 파일**(`public/index.html`, 약 140KB)로 동작하고, 필기는 브라우저(IndexedDB)에 먼저 저장한 뒤 **본인 구글 드라이브**로 동기화합니다. 서버에는 노트 내용이 저장되지 않습니다.

Cloudflare Workers에 올리고, 접근은 **Cloudflare Access**로 잠급니다.

---

## 1. 무엇이 들어있나

**필기**
- 압력 감지 펜 입력(`pointerdown/move/up` + `getCoalescedEvents`) — 펜을 세게 누르면 굵게, 살짝 누르면 가늘게
- 벡터 획 저장(점 + 압력) → 확대해도 뭉개지지 않고, 용량이 작고, 나중에 다시 그릴 수 있음
- 펜 / 형광펜(곱하기 합성) / 지우개(획 단위) / 올가미 선택(이동·복제·삭제)
- 손떨림 보정, 손바닥 무시(펜 사용 직후의 손 터치 차단), 손가락 필기 on/off
- 실행 취소·다시 실행(80단계, 쪽을 넘나들어도 동작), 페이지 간 이동/확대/축소, 두 손가락 제스처

**공책**
- 공책(notebook) → 쪽(page) 구조, 쪽 썸네일 트레이, 쪽 추가·복제·삭제
- 용지: 무지 / 모눈 / 도트 / 줄 (쪽마다 지정), 종이색 흰색·미색·먹지
- 표지 색, 이름 변경, 공책 복제

**내보내기**
- 현재 쪽 PNG, 모든 쪽 PNG, **이 공책 PDF**(직접 구현한 PDF writer — 외부 라이브러리 없음, A4 다중 페이지)
- 공책 JSON, 전체 백업 JSON, JSON 가져오기(드래그 앤 드롭 지원)

**동기화 · 저장**
- 로컬 우선: 필기 즉시 IndexedDB에 저장(디바운스), 오프라인에서도 전부 동작
- 구글 드라이브: 본인 계정의 `HandNote` 폴더에 공책별 JSON 업로드/다운로드, 양방향 동기화(`drive.file` 스코프 = 앱이 만든 파일만 접근)
- PWA 설치 가능(매니페스트 + 서비스 워커, 오프라인 셸)

---

## 2. 파일 구조

```
handnote/
├─ public/                     # 정적 자산 (Worker가 서빙)
│  ├─ index.html               # ★ 앱 전체 (HTML+CSS+JS 인라인, 단일 파일)
│  ├─ sw.js                    # 오프라인 셸 서비스 워커
│  ├─ manifest.webmanifest     # PWA 매니페스트
│  └─ assets/                  # 아이콘 (192/512/maskable/apple-touch)
├─ src/worker.js               # 정적 서빙 + /api/health, /api/me (+ 보안 헤더)
├─ build/                      # index.html 을 만들기 전의 소스 조각들
│  ├─ app1.js  app2.js  app3.js
│  └─ shell.html               # 마크업 + CSS (스크립트 삽입 지점까지)
├─ tools/build.js              # build/* → public/index.html 재조립
├─ wrangler.jsonc              # Workers 설정
├─ deploy.sh                   # 검증(dry-run) 후 배포
└─ package.json
```

`index.html`은 단독으로 열어도 동작합니다(`file://`로 열면 IndexedDB가 막힐 수 있어 임시 메모리 모드로 실행되고, 그 사실을 화면에 알려줍니다).

---

## 3. 로컬에서 실행

```bash
npm install          # wrangler 설치
npm run local        # http://localhost:8080  (정적 미리보기)
# 또는
npm run dev          # http://localhost:8787  (Worker + 자산, 실제 환경과 동일)
```

---

## 4. Cloudflare Workers 배포

```bash
export CLOUDFLARE_API_TOKEN="..."   # Workers Scripts:Edit 권한 토큰
export CLOUDFLARE_ACCOUNT_ID="..."
./deploy.sh
```

또는 대화형으로:

```bash
npx wrangler login
npx wrangler deploy
```

배포 후 `https://handnote.<your-subdomain>.workers.dev` 가 열립니다. 커스텀 도메인을 쓰려면 Cloudflare 대시보드 → Workers & Pages → 해당 워커 → Settings → Domains & Routes 에서 추가하세요.

### 보안 헤더

Worker가 모든 응답에 CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy` 를 붙입니다. CSP는 다음만 허용합니다.

| 지시문 | 허용 대상 |
|---|---|
| `script-src` | `'self'`, 인라인, `https://accounts.google.com` (구글 로그인) |
| `connect-src` | `'self'`, `https://www.googleapis.com`, `https://oauth2.googleapis.com` |
| `img-src` | `'self'`, `data:`, `blob:`, `https://*.googleusercontent.com` |

구글 드라이브 동기화를 끄면 `connect-src` 를 `'self'` 로 줄여도 됩니다.

---

## 5. Cloudflare Access 로 잠그기

Zero Trust 가 계정에 켜져 있어야 합니다(처음이면 Zero Trust 설정을 먼저 완료).

가장 간단한 방법 — **워커 단위 보호**(workers.dev 주소, 커스텀 도메인, 프리뷰까지 한 번에 덮입니다):

1. Cloudflare 대시보드 → **Workers & Pages** → `handnote` 선택
2. **Access** 탭 → **Protect this Worker behind Access**
3. **All traffic** 선택 (프리뷰만 잠그려면 *Previews only*)
4. 인증 정책 선택 — 본인만 쓸 거라면 **이메일** 정책에 자기 이메일을 넣는 방식이 가장 간단합니다
5. **Apply Access**

특정 호스트 이름/경로만 잠그려면 **Zero Trust → Access → Applications → Create new application → Self-hosted** 로 만들고 Application domain 에 `handnote.<subdomain>.workers.dev` (또는 경로)를 넣습니다. 우선순위는 호스트 이름/경로 규칙 → 워커 규칙 → 계정 전체 규칙 순입니다.

로그인이 정상인지 확인: 배포된 주소에서 `…/api/me` 를 열면 인증된 이메일이 JSON으로 보입니다(`ctx.access` 또는 `cf-access-authenticated-user-email` 헤더 사용).

---

## 6. 구글 드라이브 동기화 설정

앱 자체는 설정 없이도 완전히 동작합니다(로컬 저장 + 파일 내보내기). 드라이브 동기화만 선택적으로 켭니다.

1. [Google Cloud Console](https://console.cloud.google.com/) 에서 프로젝트를 하나 만듭니다.
2. **API 및 서비스 → 라이브러리** 에서 **Google Drive API** 를 사용 설정합니다.
3. **API 및 서비스 → OAuth 동의 화면** 을 설정합니다(외부 / 테스트 사용자에 본인 계정 추가).
4. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID → 웹 애플리케이션**
   - **승인된 JavaScript 출처** 에 앱 주소를 추가: `https://handnote.<subdomain>.workers.dev` (로컬 테스트용 `http://localhost:8787`, `http://localhost:8080` 도 추가하면 편합니다)
   - 리디렉션 URI 는 필요 없습니다(토큰 클라이언트 방식).
5. 발급된 클라이언트 ID 를 앱의 **설정 → 구글 드라이브 동기화 → OAuth 클라이언트 ID** 에 붙여넣고 **연결** 을 누릅니다.

미리 채워 두려면 `public/index.html` 맨 아래 설정 블록을 고친 뒤 재조립하면 됩니다.

```js
window.HANDNOTE_CONFIG = {
  googleClientId: "1234567890-xxxxxxxx.apps.googleusercontent.com",
  driveFolderName: "HandNote"
};
```

**권한 범위**: `drive.file` + `userinfo.email`. 앱이 직접 만든 파일만 읽고 쓸 수 있으며, 드라이브 전체를 볼 수 없습니다. 저장 위치는 내 드라이브의 `HandNote` 폴더, 파일명 `<공책이름> (<id 앞 6자>).json` 입니다.

**동기화 규칙**: 양쪽의 수정 시각을 비교해 새 쪽을 이깁니다(2초 여유). 최초 연결 시에는 설정에서 **올리기** 또는 **가져오기** 로 방향을 직접 정하는 편이 안전합니다.

---

## 7. 키보드 단축키

| 키 | 동작 | 키 | 동작 |
|---|---|---|---|
| `P` `H` `E` `L` | 펜 / 형광펜 / 지우개 / 올가미 | `Ctrl+Z` | 실행 취소 |
| `[` `]` | 굵기 − / + | `Ctrl+Shift+Z` | 다시 실행 |
| `+` `-` `0` | 확대 / 축소 / 화면 맞춤 | `Ctrl+A` | 이 쪽 전체 선택 |
| `←` `→` | 이전 / 다음 쪽 | `Ctrl+D` | 선택 복제 |
| `N` | 새 쪽 | `Delete` | 선택 삭제 |
| `T` | 밝게/어둡게 | `Ctrl+S` | PDF 로 저장 |
| `B` | 쪽 목록 접기/펼치기 | `Esc` | 선택 해제 |

마우스: 휠 = 이동, `Ctrl`+휠 = 확대/축소, 가운데 버튼 또는 `Space`+드래그 = 이동. 태블릿: 두 손가락 = 이동/확대.

---

## 8. 개발 — index.html 재조립

`public/index.html` 은 손으로 고치지 말고 `build/` 조각을 고친 뒤 다시 조립하세요.

```bash
node tools/build.js      # build/shell.html + build/app1-3.js → public/index.html
```

---

## 9. 데이터와 프라이버시

- 필기 데이터는 **사용자 브라우저의 IndexedDB** 에만 저장됩니다. Worker는 파일만 서빙합니다.
- 드라이브 동기화를 켜면 사용자 **본인** 드라이브에 JSON으로 올라갑니다. Genspark·Cloudflare 서버는 노트 내용을 볼 수 없습니다.
- 브라우저 데이터를 지우면 로컬 노트가 사라집니다. **설정 → 전체 백업** 또는 드라이브 동기화를 주기적으로 사용하세요.
- 접근 제어는 Cloudflare Access 가 담당합니다. Access 를 켜지 않으면 URL을 아는 누구나 열 수 있습니다.
