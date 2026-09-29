# Inkpad (가칭)

iPad + Apple Pencil용 개인 필기 웹앱 (PWA). 설계 문서 v0.1 기준으로 단계별 구현 중.

## 현재 단계: Phase 1 로컬 MVP + Phase 2 Google Drive 동기화 (완료)

### 완료된 기능
**필기 엔진 (Phase 0 + 1)**
- 펜/터치 분리, 필압, `getCoalescedEvents`, `getPredictedEvents`(펜 끝 예측), 팜 리젝션
- 두 손가락 팬/핀치 줌(10%~2000%), 한 손가락 스크롤 관성, 두 손가락 탭 = Undo, 세 손가락 탭 = Redo
- 확정 레이어 / 입력 레이어 / 페이지(속지·PDF) 레이어, R-tree로 화면에 보이는 획만 그리기, LOD, 캔버스 픽셀 상한
- 키보드 단축키: ⌘Z / ⇧⌘Z, P/H/E/L(도구), Delete(선택 삭제), Esc

**필압 지원 여부에 따른 옵션 (신규)**
| 방식 | 설명 |
|---|---|
| 자동 감지 (기본) | 한 획 안에서 필압이 변하면 "지원", 고정값(0.5/1.0 등)만 오는 획이 연속 2번이면 "미지원"으로 판정해 기기에 저장. 미지원이면 대체 방식으로 자동 전환하고 알림 |
| 필압 | 항상 필압 사용 (Apple Pencil) |
| 속도 | 필압 없는 펜·손가락용. 빠르게 그리면 가늘게 (perfect-freehand simulatePressure) |
| 일정한 굵기 | 굵기 변화 없음 |
- "필압이 없을 때" 대체 방식(속도/일정): 자동 감지 결과가 '없음'일 때, 그리고 손가락·정전식 터치펜·마우스 입력에 적용
- 굵기 변화 폭, 필압 곡선(감마), 최소 필압 조절
- 설정 안의 **필압 테스트 패드**: 그어 보면 pointerType, 필압 범위, 판정 결과를 보여주고 감지 결과를 갱신
- 획마다 외곽선 옵션을 저장하므로 설정을 바꿔도 이미 그린 획 모양은 그대로
- 정전식(고무팁) 터치펜은 브라우저에서 손가락과 구분되지 않으므로 "손가락·터치펜으로 그리기"를 켜서 사용

**도구**
- 펜(색 8 + 직접 선택, 굵기 6단계), 형광펜(반투명, 필기 아래 레이어), 프리셋 5개(탭 = 적용, 길게 누르기 = 현재 펜으로 저장)
- 지우개: 획 단위 / 부분(닿은 곳만 잘라내는 획 분할)
- 올가미: 선택 → 끌어서 이동, 삭제, 복제, 색 바꾸기 (문서형에서는 다른 페이지로 옮기면 해당 페이지 소속으로 바뀜)
- Undo/Redo 200단계 (페이지 삭제·복제·순서 변경·속지 변경 포함, 페이지 삭제 되돌리기 시 필기도 함께 복원)
- 빠른 전환 버튼(펜 ↔ 지우개, 끌어서 위치 이동)

**문서형 / 무한 캔버스**
- 문서형: A4 / Letter / A5 / 사용자 지정(mm), 세로·가로, 속지 5종(무지·줄·모눈·점·코넬), 세로 연속 스크롤
- 페이지 추가·삭제·복제·순서 변경(썸네일 길게 눌러 끌기 또는 메뉴), 썸네일 사이드바, 현재 페이지 표시
- 무한 캔버스: 청크(4096) 단위 저장, 점/격자/줄/무지 배경, 전체 보기, 원점 이동

**PDF**
- 가져오기: 새 문서로 / 기존 문서에 페이지 삽입, SHA-256 중복 제거, 암호 PDF(비밀번호 입력, 저장 안 함), 손상 PDF 안내, 페이지별 크기·회전(/Rotate) 반영, 200MB 상한
- 렌더링: pdf.js(legacy 빌드, Web Worker), 줌 단계별 해상도 비트맵 + LRU(총 픽셀 상한), 화면 근처 페이지만 렌더링, 다음 페이지 미리 렌더링
- 내보내기: pdf-lib(Web Worker)로 **원본 PDF 페이지 위에 필기를 벡터로 합침**, 형광펜 투명도, 속지 무늬 벡터, 전체/현재/범위 지정, 암호 PDF는 원본을 이미지로 대체(필기는 벡터 유지)
- 무한 캔버스 → 필기 영역 전체를 PDF 1페이지로

**문서 관리 / 저장**
- 문서 목록(그리드/리스트, 썸네일, 수정일·만든 날·제목 정렬, 제목 검색), 중첩 폴더, 폴더로 이동, 복제, 이름 바꾸기
- 휴지통(30일 뒤 자동 영구 삭제, 복원, 비우기), 휴지통 이동 실행 취소
- IndexedDB(Dexie): 획이 끝나면 500ms 디바운스로 바뀐 청크만 gzip 압축 저장, 백그라운드 전환·종료 시 즉시 저장, 저장 실패 시 재시도·용량 부족 안내
- 모든 쓰기를 같은 트랜잭션에서 outbox에 기록 (Phase 2 동기화 준비), 같은 엔티티는 합침
- schemaVersion + 마이그레이션 틀(구버전은 원본 백업 후 변환, 신버전 데이터는 편집 차단)
- 같은 문서를 두 탭에서 열면 나중 탭은 읽기 전용 (BroadcastChannel)
- .inkpad 파일(zip: manifest + 문서 + 청크 + PDF 원본) 내보내기/가져오기, 전체 백업/복원(폴더 구조 포함, 새 사본으로 추가)
- 설정 > 저장소: 사용량, 문서·PDF 용량, 저장소 보존 상태, 동기화 대기 건수

**PWA**
- 빌드 시 프리캐시 목록 자동 생성(Service Worker), 첫 설치 후 오프라인 실행, 새 버전 알림
- 홈 화면 추가 안내, `navigator.storage.persist()` 요청

**클라우드 동기화 (Phase 2 — Google Drive, SDF 가이드)**
- 오프라인 우선: 모든 읽기/쓰기는 IndexedDB. **Drive 동기화는 설정 > 동기화의 "지금 동기화"를 눌렀을 때만** 실행(자동 백그라운드 동기화 없음 — 평소에는 기기에만 저장)
- 토큰 자동 갱신: Refresh Token을 Worker가 `SESSION_SECRET`(AES-GCM)으로 암호해 HttpOnly 쿠키에 보관하고, 앱은 `/api/auth/token`으로 Access Token을 받는다 → 기기마다 한 번만 로그인
- 권한은 `drive.file`: 이 앱이 만든 파일에만 접근(민감 scope 아님 → Google 심사 불필요)
- 문서 1개 = Drive JSON 파일 1개(`Inkpad/docs/{id}.json`), 폴더 트리는 `folders.json`, PDF·이미지 원본은 sha256 내용 주소 파일(`Inkpad/assets/`)
- outbox 기반 push → pull 순서, 업로드 중 재수정 시 outbox 유지, 충돌 시 "(충돌 사본)"으로 양쪽 보존, 삭제는 tombstone → Drive 휴지통, Drive 폴더가 사라지면 전체 재업로드
- **원본 지연 로딩**: "받기"는 문서·페이지·필기·에셋 정보(JSON)만 내려받는다. PDF·이미지 원본 바이트는 그 원본을 쓰는 문서를 **처음 열 때** 받아오고, 받은 뒤에는 이 기기에 남아 다시 받지 않는다. 기기 저장소가 비워진 폰에서도 목록이 즉시 뜨고, 설정 > 동기화에서 "이 기기에 없는 원본" 개수를 확인하거나 "원본 모두 받기"로 미리 받을 수 있다
- 다중 탭 동시 실행 방지(`navigator.locks`), 원격 변경 시 목록 자동 새로고침, 편집 화면에서는 "다시 불러오기" 안내
- 설정 > 동기화에서 상태 표시·로그인·즉시 동기화

### 기능 진입점
| 경로 | 설명 |
|---|---|
| `/#/` | 문서 목록 |
| `/#/doc/{documentId}` | 편집 화면 |
| `/api/health` | 상태 확인 JSON |

### 아직 구현하지 않은 것
- Phase 3: 올가미 크기 조절·복사/붙여넣기, 도형 인식, 텍스트·이미지, 태그, PNG/SVG 내보내기, 페이지 넘김 모드, 미니맵
- Phase 4: 필기 OCR, 오디오 녹음 등

## 구조
```
src/
  shared/    model.ts(데이터 모델·상수), ulid, util
  engine/    engine(입력·제스처·Command·저장 예약), layout(페이지 배치·청크), scene(R-tree), render(레이어),
             pressure(필압 방식·자동 감지), geometry(외곽선·부분 지우개·올가미), background(속지), history,
             pdf/(pdf.js 로더, 비트맵 LRU 캐시)
  storage/   db(Dexie 스키마), repo(문서·페이지·청크·에셋·outbox), compress(gzip), migrate, tabLock
   io/        pdfImport, pdfExport + exportWorker(pdf-lib), inkpadFormat(.inkpad/백업), download
   sync/      token(access token 갱신), drive(Drive API 래퍼), pack(문서↔파일), folders(Drive 위치·폴더 확보),
              assets(원본 지연 로딩·인덱싱), sync(엔진)
   ui/        library/(목록·새 문서·설정), editor/(툴바·사이드바·선택·페이지·내보내기), SettingsPanel, SyncSection, Hud
   app/       App, store(zustand: UI 상태만), dialogs
   api/       Hono Worker (/api/*: health + Drive OAuth login/callback/token/logout)
public/      manifest, sw.js, icons, _routes.json
```

## 데이터 (IndexedDB `inkpad`)
`folders`, `documents`, `pages`, `chunks`([pageId+key], gzip Blob), `assets`(PDF 원본, sha256 unique), `thumbnails`, `outbox`, `syncState`, `settings`, `backups`

## 개발
```bash
npm run build                    # vite build(클라이언트+SW 프리캐시) + vite build -c vite.server.config.ts(Worker)
pm2 start ecosystem.config.cjs   # wrangler dev :3000 (정적 에셋 + Worker 함께)
npm run typecheck
```

### 동기화 설정 (Google Drive, SDF 가이드 1장)
1. Google Cloud Console에서 **Google Drive API** 사용 설정, OAuth 동의 화면(외부) — scope `openid email .../auth/drive.file`
2. **게시 상태를 "프로덕션"으로 변경** (테스트 상태는 refresh token이 7일 뒤 만료됨. 민감 scope가 없어 심사 없이 게시 가능)
3. OAuth 클라이언트(웹 애플리케이션) 생성 — 승인된 리디렉션 URI에 등록:
   - `https://<앱>.pages.dev/api/auth/callback`
   - `http://localhost:8788/api/auth/callback` (로컬)
4. Cloudflare Pages → Settings → Variables and Secrets에 등록 (로컬은 `.dev.vars`, `.dev.vars.example` 참고 — 커밋 금지):

| 이름 | 값 |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | OAuth 클라이언트 보안 비밀 |
| `SESSION_SECRET` | `openssl rand -base64 32` |
| `ALLOWED_EMAIL` | 내 Gmail (선택 — 다른 계정 차단) |

> 주의: iOS 홈 화면(PWA)은 Safari와 쿠키 저장소가 분리되어 PWA 안에서 한 번 따로 로그인해야 한다. `SESSION_SECRET`을 바꾸면 모든 기기에서 재로그인이 필요하다.

## 저장소
- **GitHub**: https://github.com/noctis-03/inkpad

## 배포
- 플랫폼: Cloudflare Workers (정적 에셋 + Worker, `npx wrangler deploy`) — Drive 동기화는 앱과 같은 도메인의 `_worker.js`에서 처리 (제3자 쿠키 차단 회피)
- 상태: 샌드박스 미리보기만 (프로덕션 미배포)
- 마지막 업데이트: 2026-09-29
