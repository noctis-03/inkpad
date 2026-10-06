// 큰 파일 전송 전 확인 (명세 5장).
// iPad Safari/PWA는 셀룰러·와이파이 여부를 알 수 없으므로(navigator.connection 미지원) 크기로 묻는다.
import { confirmDialog, choiceDialog } from '../app/dialogs'
import { useUI } from '../app/store'
import { formatBytes } from '../shared/util'

const THRESHOLDS: Record<'always' | 'off' | '5' | '10' | '50', number> = {
  always: 0, // 무조건 확인 — 크기와 관계없이 모든 전송에서 묻는다
  off: 0,
  '5': 5 * 1024 * 1024,
  '10': 10 * 1024 * 1024,
  '50': 50 * 1024 * 1024
}

/** 현재 설정의 기준 크기(바이트). '끄기'면 0 */
export function largeFileThreshold(): number {
  return THRESHOLDS[useUI.getState().settings.largeFileConfirm]
}

/** 설정의 기준 이상이면 다운로드/업로드 전에 확인 창을 띄운다. 기준 미만이거나 끄기면 묻지 않는다 */
export async function confirmTransfer(direction: 'down' | 'up', bytes: number, count = 1): Promise<boolean> {
  const mode = useUI.getState().settings.largeFileConfirm
  if (mode === 'off') return true
  const threshold = THRESHOLDS[mode]
  if (bytes < threshold) return true
  const size = formatBytes(bytes)
  const message = (count > 1 ? `파일 ${count}개, ` : '') + '셀룰러 데이터를 사용 중이라면 그만큼 데이터가 사용됩니다.'
  const note = mode === 'always' ? '무조건 확인이 켜져 있습니다 · 설정에서 바꿀 수 있습니다' : `${formatBytes(threshold)} 이상일 때만 묻습니다 · 설정에서 바꿀 수 있습니다`
  return confirmDialog(direction === 'down' ? `${size}를 다운로드합니다` : `${size}를 업로드합니다`, {
    message,
    note,
    ok: direction === 'down' ? '다운로드' : '업로드'
  })
}

/**
 * 파일 추가 전 3버튼 확인 (명세 11.4). 기준 미만이거나 끄기면 묻지 않고 'upload'.
 * 취소면 추가하지 않고, 'local'이면 db에만 추가한다(업로드 안 함).
 */
export async function uploadChoice(bytes: number, count = 1): Promise<'cancel' | 'local' | 'upload'> {
  const mode = useUI.getState().settings.largeFileConfirm
  if (mode === 'off') return 'upload'
  const threshold = THRESHOLDS[mode]
  if (bytes < threshold) return 'upload'
  const size = formatBytes(bytes)
  const res = await choiceDialog(`${size}를 업로드합니다`, {
    message: (count > 1 ? `파일 ${count}개, ` : '') + '셀룰러 데이터를 사용 중이라면 그만큼 데이터가 사용됩니다.',
    note: mode === 'always' ? '무조건 확인이 켜져 있습니다 · 설정에서 바꿀 수 있습니다' : `${formatBytes(threshold)} 이상일 때만 묻습니다 · 설정에서 바꿀 수 있습니다`,
    options: [
      { key: 'cancel', label: '취소' },
      { key: 'local', label: '이 기기에만 추가' },
      { key: 'upload', label: '업로드', primary: true }
    ]
  })
  return res === 'local' || res === 'upload' ? res : 'cancel'
}
