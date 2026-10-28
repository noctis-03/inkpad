// 이미지로 보내기 — 페이지(또는 올가미로 고른 영역)를 읽기 좋은 해상도로 다시 그려 복사·공유한다.
// 화면 분할로 옆에 띄운 Claude 같은 AI 앱에 붙여넣어 묻는 용도. 이 기기 안에서만 만들고 어디에도 올리지 않는다(네트워크 0).
//  - 담을 것: 글씨만 / 글씨 + PDF / PDF만(필기 없이 PDF·속지만). 올가미는 기본 글씨만, 페이지는 기본 글씨 + PDF —
//    고른 값은 이 기기에 기억한다
//  - 문구는 이미지 위쪽 띠에 글자로 넣는다 (공유·붙여넣기로 문구가 따로 가는지는 받는 앱마다 달라서)
//  - Claude로 바로 보내기는 따로 'AI로 보내기'(AiSendSheet) — 추천 문구를 골라 claude.ai를 연다
import { useEffect, useMemo, useState } from 'react'
import { useUI, type SendImageTarget } from '../../app/store'
import type { Engine } from '../../engine/engine'
import { saveFile } from '../../io/download'
import { Icon } from '../Icon'
import { Segmented } from '../Segmented'
import { useEscClose } from '../sheetParts'

type ShareNav = Navigator & { canShare?: (d: ShareData) => boolean }

/** 클립보드에 이미지를 쓸 수 있는가 (iPadOS Safari 13.4+, 크롬) */
export const canCopyImage = () => typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write

/** claude.ai 새 대화 — ?q= 로 입력창에 문구를 채운다(Claude 앱이 있으면 기기 설정에 따라 앱으로 열린다) */
const CLAUDE_NEW = 'https://claude.ai/new'
export const claudeUrl = (q: string) => (q ? `${CLAUDE_NEW}?q=${encodeURIComponent(q)}` : CLAUDE_NEW)

const LS = 'inkpad.sendImage.v1'
/** 이미지에 담을 것 — 글씨만 / 글씨 + PDF·속지 / PDF·속지만 */
export type Layers = 'ink' | 'both' | 'bg'
export const LAYERS: [Layers, string][] = [
  ['ink', '글씨만'],
  ['both', '글씨 + PDF'],
  ['bg', 'PDF만']
]
interface Prefs {
  /** 올가미·페이지 각각 담을 것 */
  sel: Layers
  page: Layers
  /** 이미지에 문구 넣기 */
  caption: boolean
}
function loadPrefs(): Prefs {
  const def: Prefs = { sel: 'ink', page: 'both', caption: true }
  try {
    const raw = JSON.parse(localStorage.getItem(LS) ?? '{}') as Partial<Prefs> & { selBg?: boolean; pageBg?: boolean }
    // 예전 'PDF·속지 포함' 체크(selBg·pageBg)는 글씨 + PDF / 글씨만으로 옮긴다
    const old = (v: boolean | undefined): Layers | undefined => (v === undefined ? undefined : v ? 'both' : 'ink')
    return { sel: raw.sel ?? old(raw.selBg) ?? def.sel, page: raw.page ?? old(raw.pageBg) ?? def.page, caption: raw.caption ?? def.caption }
  } catch {
    return def
  }
}
function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(LS, JSON.stringify(p))
  } catch {
    /* 저장 공간 부족 등 */
  }
}

/** 기본 요청 문구 — 글씨만이면 손글씨 받아쓰기, PDF까지면 쉽게 풀이 */
export const defaultCaption = (bg: boolean) => (bg ? '사진 속 내용을 쉽게 풀이해줘.' : '이 손글씨를 그대로 텍스트로 다시 적어줘.')

/**
 * 이미지 위에 요청 문구 띠를 붙인다. 좁은 이미지(작은 올가미)도 문구가 너무 잘게 줄바꿈되지 않게
 * 폭은 최소 900px로 하고 이미지는 가운데에 둔다.
 */
export async function withCaption(img: Blob, text: string): Promise<Blob> {
  const bmp = await createImageBitmap(img)
  const W = Math.max(bmp.width, 900)
  const fs = Math.round(Math.min(44, Math.max(26, W * 0.03)))
  const pad = Math.round(fs * 0.8)
  const lh = Math.round(fs * 1.4)
  const font = `600 ${fs}px -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif`
  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = font
  // 글자 단위로 줄바꿈 (한글은 띄어쓰기가 적어도 넘치지 않게)
  const lines: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const ch of para) {
      if (line && measure.measureText(line + ch).width > W - pad * 2) {
        lines.push(line)
        line = ch.trimStart()
      } else line += ch
    }
    lines.push(line)
  }
  const band = pad * 2 + lines.length * lh
  const c = document.createElement('canvas')
  c.width = W
  c.height = band + bmp.height
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.fillStyle = '#f2f1ee'
  ctx.fillRect(0, 0, W, band)
  ctx.fillStyle = '#d8d4cb'
  ctx.fillRect(0, band - 2, W, 2)
  ctx.fillStyle = '#1c1b19'
  ctx.font = font
  ctx.textBaseline = 'middle'
  lines.forEach((l, i) => ctx.fillText(l, pad, pad + i * lh + lh / 2))
  ctx.drawImage(bmp, Math.round((W - bmp.width) / 2), band)
  bmp.close()
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('이미지를 만들지 못했습니다.'))), 'image/png'))
}

export function SendImageSheet({ engine, title, target, paged }: { engine: Engine; title: string; target: SendImageTarget; paged: boolean }) {
  const toast = useUI((s) => s.toast)
  const close = () => useUI.setState({ sendImage: null })
  const isSel = target === 'selection'
  const [prefs, setPrefs] = useState(loadPrefs)
  // 페이지가 없는 무한 캔버스는 PDF·속지가 없으므로 늘 글씨만
  const layers: Layers = paged ? (isSel ? prefs.sel : prefs.page) : 'ink'
  const bg = layers !== 'ink'
  const ink = layers !== 'bg'
  // 고치지 않았으면 PDF 포함을 바꿀 때 기본 문구도 따라 바뀐다
  const [custom, setCustom] = useState<string | null>(null)
  const text = custom ?? defaultCaption(bg)
  const [typed, setTyped] = useState(text) // 입력 중에는 미리보기를 매번 다시 그리지 않는다
  const [blob, setBlob] = useState<Blob | null>(null)
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  const name = `${title || '노트'} ${isSel ? '부분' : `${target.page + 1}쪽`}.png`
  const caption = prefs.caption ? text.trim() : ''

  const update = (p: Partial<Prefs>) =>
    setPrefs((cur) => {
      const next = { ...cur, ...p }
      savePrefs(next)
      return next
    })

  useEffect(() => setTyped(text), [text])
  useEffect(() => {
    if (typed === text) return
    const t = window.setTimeout(() => setCustom(typed), 350)
    return () => window.clearTimeout(t)
  }, [typed, text])

  useEffect(() => {
    let alive = true
    let u = ''
    setBlob(null)
    setFailed(false)
    void (async () => {
      try {
        let b = await engine.exportImage(target, { background: bg, ink })
        if (b && caption) b = await withCaption(b, caption)
        if (!alive) return
        if (!b) return setFailed(true)
        u = URL.createObjectURL(b)
        setBlob(b)
        setUrl(u)
      } catch {
        if (alive) setFailed(true)
      }
    })()
    return () => {
      alive = false
      if (u) URL.revokeObjectURL(u)
    }
  }, [engine, target, bg, ink, caption])

  useEscClose(close)

  const file = useMemo(() => (blob ? new File([blob], name, { type: 'image/png' }) : null), [blob, name])
  const canShare = !!file && !!(navigator as ShareNav).canShare?.({ files: [file] })
  const ready = !!blob && typed === text // 입력한 문구가 미리보기에 들어간 뒤에만

  // 복사·공유는 누른 처리기 안에서 바로 부른다 — Safari는 사용자 탭 밖의 클립보드 쓰기·공유를 막는다
  const copy = () => {
    if (!blob) return
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(
      () => {
        toast('이미지를 복사했습니다 — AI 앱 입력창을 길게 눌러 붙여넣으세요.', 'success')
        close()
      },
      () => toast(canShare ? '복사하지 못했습니다. 공유로 보내 보세요.' : '복사하지 못했습니다. 저장해서 보내 보세요.', 'error')
    )
  }
  const share = () => {
    if (!file) return
    navigator.share({ files: [file], title: name }).then(close, (e) => {
      if ((e as DOMException)?.name !== 'AbortError') toast('공유하지 못했습니다.', 'error')
    })
  }
  const save = () => {
    if (!blob) return
    void saveFile(blob, name, false).then(close)
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal send-image" role="dialog" aria-label="이미지로 보내기">
        <h2 className="modal-title">이미지로 보내기</h2>
        <div className="send-image-preview">
          {url && blob ? <img src={url} alt={isSel ? '고른 영역' : `${target.page + 1}쪽`} /> : failed ? <p>이미지를 만들지 못했습니다.</p> : <div className="spinner" />}
        </div>
        <div className="send-image-opts">
          {paged && (
            <div className="send-layers">
              <span>담을 것</span>
              <Segmented value={layers} options={LAYERS} onChange={(v) => update(isSel ? { sel: v } : { page: v })} label="담을 것" />
            </div>
          )}
          <label className="send-opt">
            <input type="checkbox" checked={prefs.caption} onChange={(e) => update({ caption: e.target.checked })} />
            이미지에 문구 넣기
          </label>
          {prefs.caption && (
            <textarea
              className="send-caption"
              rows={2}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label="이미지에 넣을 문구"
              placeholder={defaultCaption(bg)}
            />
          )}
        </div>
        <p className="modal-note">
          AI 앱을 옆에 띄우고(화면 분할) 붙여넣으세요 — 문구는 이미지 위쪽에 글자로 들어갑니다. Claude로 바로 보내려면 'AI로 보내기'를 쓰세요. 이 기기에서만 만들고 어디에도 올리지 않습니다. 메모·할 일 블록은 담기지 않습니다.
        </p>
        <div className="modal-actions wrap">
          <button className="text-btn" onClick={close}>
            닫기
          </button>
          {canShare ? (
            <button className="text-btn" onClick={share} disabled={!ready}>
              <Icon name="share" size={18} /> 공유
            </button>
          ) : (
            <button className="text-btn" onClick={save} disabled={!ready}>
              <Icon name="download" size={18} /> 저장
            </button>
          )}
          {canCopyImage() && (
            <button className="primary-btn" onClick={copy} disabled={!ready}>
              <Icon name="copy" size={18} /> 복사
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
