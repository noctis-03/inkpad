// 큰 파일 전송 전 확인 (명세 5장).
// iPad Safari/PWA는 셀룰러·와이파이 여부를 알 수 없으므로(navigator.connection 미지원) 크기로 묻는다.
import { confirmDialog } from '../app/dialogs'
import { useUI } from '../app/store'
import { formatBytes } from '../shared/util'

const THRESHOLDS: Record<'off' | '10' | '50', number> = {
  off: 0,
  '10': 10 * 1024 * 1024,
  '50': 50 * 1024 * 1024
}

/** 설정의 기준 이상이면 다운로드/업로드 전에 확인 창을 띄운다. 기준 미만이거나 끄기면 묻지 않는다 */
export async function confirmTransfer(direction: 'down' | 'up', bytes: number, count = 1): Promise<boolean> {
  const mode = useUI.getState().settings.largeFileConfirm
  if (mode === 'off') return true
  const threshold = THRESHOLDS[mode]
  if (bytes < threshold) return true
  const size = formatBytes(bytes)
  const message = (count > 1 ? `파일 ${count}개, ` : '') + '셀룰러 데이터를 사용 중이라면 그만큼 데이터가 사용됩니다.'
  const note = `${formatBytes(threshold)} 이상일 때만 묻습니다 · 설정에서 바꿀 수 있습니다`
  return confirmDialog(direction === 'down' ? `${size}를 다운로드합니다` : `${size}를 업로드합니다`, {
    message,
    note,
    ok: direction === 'down' ? '다운로드' : '업로드'
  })
}
