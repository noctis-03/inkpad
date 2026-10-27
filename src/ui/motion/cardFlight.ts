// 노트 열기·닫기 '카드 이동' 모션 (설정 > 노트 열기 > 카드 이동, App Panes가 부른다).
// 카드 미리보기(첫 페이지 그림)가 편집 화면의 페이지 자리로 날아가 그 페이지가 되고, 닫으면 거꾸로 카드로 돌아간다.
// 고스트는 도착 자리 크기로 놓고 transform·clip-path만 움직인다 — 카드 비율(1:1.30)만큼 아래를 잘라 두었다가 페이지 전체로 편다.
// 바탕은 카드 미색(곱하기)에서 페이지 흰색으로 함께 바뀌어 양 끝이 아래 화면과 이어진다.
import { dur } from './motion'
import { pageRectNow } from './docPage'

const FLY_MS = 480
const BACK_MS = 440
const EASE = 'cubic-bezier(.2,.8,.2,1)'
/** 편집 화면이 페이지 자리를 알릴 때까지 기다리는 시간 — 넘으면 원형 리빌로 */
const PAGE_WAIT_MS = 700
/** 페이지 자리가 이만큼 연달아 같아야 내려앉을 자리로 본다 — 편집 화면이 막 열리면 페이지 목록 칸이 붙으며 페이지가 옆으로 옮겨 간다 */
const STABLE_FRAMES = 3

const same = (a: DOMRect | null, b: DOMRect | null) => !!a && !!b && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5

const cream = () => getComputedStyle(document.documentElement).getPropertyValue('--thumb-cream').trim() || '#fbf9f4'

function ghostAt(r: DOMRect, src: string | null) {
  const g = document.createElement('div')
  g.className = 'doc-fly'
  if (src) g.style.backgroundImage = `url("${src}")`
  Object.assign(g.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
  document.body.appendChild(g)
  return g
}

/** 페이지 자리(page)에 놓인 고스트가 카드 자리(card)에서 출발하는 모습 ↔ 제자리 */
function frames(card: DOMRect, page: DOMRect): [Keyframe, Keyframe] {
  const s = card.width / page.width
  const hidden = Math.max(0, page.height - card.height / s)
  const atCard = {
    transform: `translate(${card.left - page.left}px, ${card.top - page.top}px) scale(${s})`,
    clipPath: `inset(0px 0px ${hidden}px 0px round ${6 / s}px)`,
    backgroundColor: cream()
  }
  const atPage = { transform: 'none', clipPath: 'inset(0px 0px 0px 0px round 0px)', backgroundColor: '#ffffff' }
  return [atCard, atPage]
}

/** 카드 미리보기 그림 주소 (없으면 빈 종이) */
export const thumbSrcOf = (card: Element | null) => card?.querySelector<HTMLImageElement>('.doc-thumb img')?.src ?? null

/**
 * 열기 — 편집 화면 칸(pane)은 숨겨 두고, 카드에서 고스트가 페이지 자리로 날아간 뒤 그 페이지로 바뀐다(짧게 겹쳐 사라짐).
 * 편집 화면은 고스트가 나는 동안 주위(툴바·바탕)부터 드러난다. 페이지가 없는 노트면 noPage(원형 리빌)로.
 */
export function flyOpen(pane: HTMLElement, card: DOMRect, cardEl: Element | null, done: () => void, noPage: () => Animation): () => void {
  pane.style.opacity = '0'
  const ghost = ghostAt(card, thumbSrcOf(cardEl))
  ghost.style.backgroundColor = cream()
  cardEl?.classList.add('is-flying')
  const anims: Animation[] = []
  const t0 = performance.now()
  let raf = 0
  let quiet = 0
  let last: DOMRect | null = null
  let steady = 0
  const finish = () => {
    ghost.remove()
    done()
  }
  const go = () => {
    const now = pageRectNow()
    steady = same(now, last) ? steady + 1 : 0
    last = now
    // 편집 화면이 다 열렸는데 페이지가 없으면(문서·무한 캔버스) 기다리지 않는다
    const ready = !!pane.querySelector('.editor') && !pane.querySelector('.doc-skeleton')
    quiet = !now && ready ? quiet + 1 : 0
    const late = performance.now() - t0 >= dur(PAGE_WAIT_MS)
    if (!late && (now ? steady < STABLE_FRAMES : quiet < 3)) {
      raf = requestAnimationFrame(go)
      return
    }
    const page = now
    pane.style.opacity = ''
    if (!page) {
      ghost.remove()
      const a = noPage()
      anims.push(a)
      a.finished.then(done, done)
      return
    }
    Object.assign(ghost.style, { left: `${page.left}px`, top: `${page.top}px`, width: `${page.width}px`, height: `${page.height}px` })
    const fly = ghost.animate(frames(card, page), { duration: dur(FLY_MS), easing: EASE, fill: 'both' })
    anims.push(fly, pane.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur(300), delay: dur(140), easing: 'ease', fill: 'backwards' }))
    fly.finished.then(() => {
      const out = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur(140), easing: 'ease', fill: 'forwards' })
      anims.push(out)
      out.finished.then(finish, finish)
    }, finish)
  }
  raf = requestAnimationFrame(go)
  return () => {
    cancelAnimationFrame(raf)
    anims.forEach((a) => a.cancel())
    ghost.remove()
    pane.style.opacity = ''
  }
}

/** 닫기 — 남겨 둔 편집 화면(pane)은 흐려지고, 페이지 자리(page)에서 고스트가 카드로 돌아가 카드가 된다 */
export function flyClose(pane: HTMLElement, page: DOMRect, card: DOMRect, cardEl: Element | null, done: () => void): () => void {
  const ghost = ghostAt(page, thumbSrcOf(cardEl))
  cardEl?.classList.add('is-flying')
  const [atCard, atPage] = frames(card, page)
  const fly = ghost.animate([atPage, atCard], { duration: dur(BACK_MS), easing: EASE, fill: 'both' })
  const fade = pane.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur(200), easing: 'ease', fill: 'forwards' })
  const finish = () => {
    cardEl?.classList.remove('is-flying')
    ghost.remove()
    done()
  }
  fly.finished.then(finish, finish)
  return () => {
    fly.cancel()
    fade.cancel()
    ghost.remove()
    cardEl?.classList.remove('is-flying')
  }
}
