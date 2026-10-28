// AI로 보내기 — 올가미로 고른 영역(또는 페이지)을 이미지로 만들고, 추천 문구를 골라 Claude로 바로 연다.
// 이미지는 클립보드에 복사하고 claude.ai 새 대화를 문구가 입력창에 들어간 채로 연다 — 이미지는 주소에 실을 수 없어
// 사용자가 입력창에 붙여넣는다(그 전에는 이미지가 어디에도 올라가지 않는다). 고른 문구·담을 것은 이 기기에 기억한다.
import { useEffect, useState } from 'react'
import { useUI, type SendImageTarget } from '../../app/store'
import type { Engine } from '../../engine/engine'
import { Icon } from '../Icon'
import { Segmented } from '../Segmented'
import { useEscClose } from '../sheetParts'
import { LAYERS, canCopyImage, claudeUrl, type Layers } from './SendImageSheet'

/** 추천 문구 — 공부 노트에서 자주 묻는 것 */
export const AI_PROMPTS: { label: string; text: string }[] = [
  { label: '손글씨 받아쓰기', text: '이 손글씨를 그대로 텍스트로 다시 적어줘.' },
  { label: '쉽게 풀이', text: '사진 속 내용을 쉽게 풀이해줘.' },
  { label: '단계별 풀이', text: '이 문제를 단계별로 풀어줘. 답만 말하지 말고 풀이 과정을 보여줘.' },
  { label: '핵심 요약', text: '핵심만 짧게 요약해줘.' },
  { label: '틀린 곳 찾기', text: '내가 쓴 풀이에서 틀린 부분이 있는지 확인하고 고쳐줘.' },
  { label: '비슷한 문제', text: '이 내용으로 비슷한 연습 문제를 3개 만들어줘. 답은 마지막에 따로 적어줘.' }
]

const LS = 'inkpad.aiSend.v1'
interface Prefs {
  /** 올가미·페이지 각각 담을 것 */
  sel: Layers
  page: Layers
  /** 마지막으로 고른 추천 문구 */
  pick: number
}
function loadPrefs(): Prefs {
  const def: Prefs = { sel: 'both', page: 'both', pick: 1 }
  try {
    const p = { ...def, ...JSON.parse(localStorage.getItem(LS) ?? '{}') } as Prefs
    return { ...p, pick: AI_PROMPTS[p.pick] ? p.pick : def.pick }
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

export function AiSendSheet({ engine, target, paged }: { engine: Engine; target: SendImageTarget; paged: boolean }) {
  const toast = useUI((s) => s.toast)
  const close = () => useUI.setState({ aiSend: null })
  const isSel = target === 'selection'
  const [prefs, setPrefs] = useState(loadPrefs)
  const layers: Layers = paged ? (isSel ? prefs.sel : prefs.page) : 'ink'
  // 고친 문구 — 추천 문구를 다시 고르면 버린다
  const [custom, setCustom] = useState<string | null>(null)
  const text = custom ?? AI_PROMPTS[prefs.pick].text
  const [blob, setBlob] = useState<Blob | null>(null)
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  const canCopy = canCopyImage()

  const update = (p: Partial<Prefs>) =>
    setPrefs((cur) => {
      const next = { ...cur, ...p }
      savePrefs(next)
      return next
    })

  useEffect(() => {
    let alive = true
    let u = ''
    setBlob(null)
    setFailed(false)
    void (async () => {
      try {
        const b = await engine.exportImage(target, { background: layers !== 'ink', ink: layers !== 'bg' })
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
  }, [engine, target, layers])

  useEscClose(close)

  // 복사와 새 창 열기를 누른 처리기 안에서 곧바로 둘 다 한다 — 하나를 기다리면 Safari가 다른 하나를 막는다
  const open = () => {
    if (!blob) return
    const wrote = navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    window.open(claudeUrl(text.trim()), '_blank', 'noopener')
    wrote.then(
      () => {
        toast('이미지를 복사했습니다 — Claude 입력창을 길게 눌러 붙여넣으세요.', 'success')
        close()
      },
      () => toast("이미지를 복사하지 못했습니다. '이미지로 보내기'에서 저장한 뒤 Claude에 올려 주세요.", 'error')
    )
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal send-image ai-send" role="dialog" aria-label="AI로 보내기">
        <h2 className="modal-title">AI로 보내기</h2>
        <div className="send-image-preview">
          {url && blob ? <img src={url} alt={isSel ? '고른 영역' : `${target.page + 1}쪽`} /> : failed ? <p>이미지를 만들지 못했습니다.</p> : <div className="spinner" />}
        </div>
        {paged && (
          <div className="send-layers">
            <span>담을 것</span>
            <Segmented value={layers} options={LAYERS} onChange={(v) => update(isSel ? { sel: v } : { page: v })} label="담을 것" />
          </div>
        )}
        <div className="ai-picks" role="radiogroup" aria-label="추천 문구">
          {AI_PROMPTS.map((p, i) => (
            <button
              key={p.label}
              role="radio"
              aria-checked={custom === null && prefs.pick === i}
              className={'ai-pick' + (custom === null && prefs.pick === i ? ' is-active' : '')}
              onClick={() => {
                setCustom(null)
                update({ pick: i })
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <textarea className="send-caption" rows={2} value={text} onChange={(e) => setCustom(e.target.value)} aria-label="보낼 문구" placeholder="Claude에게 물어볼 것" />
        <p className="modal-note">
          {canCopy
            ? '이미지를 복사하고 claude.ai 새 대화를 이 문구와 함께 엽니다 — Claude 입력창을 길게 눌러 이미지를 붙여넣으세요. 이미지는 붙여넣기 전에는 어디에도 올라가지 않습니다.'
            : "이 브라우저는 이미지를 복사할 수 없습니다 — '이미지로 보내기'에서 저장해 Claude에 올려 주세요."}
        </p>
        <div className="modal-actions">
          <button className="text-btn" onClick={close}>
            닫기
          </button>
          <button className="primary-btn" onClick={open} disabled={!blob || !canCopy || !text.trim()}>
            <Icon name="external" size={18} /> Claude에서 열기
          </button>
        </div>
      </div>
    </div>
  )
}
