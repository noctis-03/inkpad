// 설계 문서 7.3 상수 + Phase 0 렌더링 상수
export const CHUNK_SIZE = 4096 // 무한 캔버스 청크 크기 (월드 단위)
export const MAX_HISTORY = 200
export const MIN_ZOOM = 0.1 // 10%
export const MAX_ZOOM = 20 // 2000%
export const TAP_MAX_MS = 300 // 두/세 손가락 탭 판정 시간
export const TAP_SLOP_PX = 10 // 탭/팬 시작 판정 이동 거리 (CSS px)
export const GESTURE_SETTLE_MS = 120 // 팬/줌이 멈춘 뒤 고해상도로 다시 그리기까지 대기
export const MAX_CANVAS_PIXELS = 6_000_000 // 캔버스 1장당 픽셀 상한 (Safari 메모리 보호)
export const AUTO_REDRAW_BUDGET_MS = 8 // auto 모드: 전체 다시 그리기가 이보다 빠르면 제스처 중에도 매 프레임 다시 그림
