import { MAX_HISTORY, type Block, type ID, type Page } from '../shared/model'
import type { Entry, ImageEntry } from './scene'

export interface PageSnapshot {
  order: ID[]
  pages: Page[] // 이 명령으로 바뀌는 페이지들의 상태
}

/** 보조 용지(sheet 필드가 있는 Page) 한 장의 변경. before null = 추가, after null = 삭제 */
export interface SheetChange {
  before: Page | null
  after: Page | null
}

/** 블록 변경 한 건. null = 존재하지 않음 (생성은 before: null, 삭제는 after: null) */
export interface BlockChange {
  before: Block | null
  after: Block | null
}

/** 사진 변경 한 건. null = 없음 (넣기는 before: null, 지우기는 after: null). 옮기기·크기 조절은 같은 ID의 전후 */
export interface ImageChange {
  before: ImageEntry | null
  after: ImageEntry | null
}

/**
 * Command 기반 Undo/Redo.
 * 모든 편집을 "지운 획 / 추가한 획 (+ 페이지 구조 전후)"로 표현한다.
 *  - 그리기: added / 지우개: removed / 올가미 이동: removed + added
 *  - 페이지 삭제: 페이지 + 그 페이지의 획을 함께 복원하는 복합 명령
 *  - 블록: removed/added와 별개의 blocks 목록으로 표현한다 (Element 청크와 절대 섞지 않는다)
 */
export interface Command {
  removed: Entry[]
  added: Entry[]
  pagesBefore?: PageSnapshot
  pagesAfter?: PageSnapshot
  blocks?: BlockChange[]
  /** 사진 넣기·옮기기·지우기 (획과 같은 청크에 저장한다) */
  images?: ImageChange[]
  /** 보조 용지 추가·변경·삭제 (용지 위 획은 removed/added로 함께 담는다) */
  sheets?: SheetChange[]
  /** 적용·되돌리기 때 보던 자리(화면 가운데의 페이지 위 지점, 폭 맞춤 대비 배율)를 그대로 둔다 — 페이지 크기 맞추기 */
  keepView?: boolean
  label?: string
}

export class History {
  private undoStack: Command[] = []
  private redoStack: Command[] = []

  push(cmd: Command) {
    if (!cmd.removed.length && !cmd.added.length && !cmd.pagesAfter && !cmd.blocks?.length && !cmd.images?.length && !cmd.sheets?.length) return
    this.undoStack.push(cmd)
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift()
    this.redoStack.length = 0
  }

  popUndo() {
    const c = this.undoStack.pop()
    if (c) this.redoStack.push(c)
    return c
  }

  popRedo() {
    const c = this.redoStack.pop()
    if (c) this.undoStack.push(c)
    return c
  }

  get canUndo() {
    return this.undoStack.length > 0
  }

  get canRedo() {
    return this.redoStack.length > 0
  }

  clear() {
    this.undoStack.length = 0
    this.redoStack.length = 0
  }
}
