// 편집 화면 고르기 — 노트·무한 캔버스는 필기 편집기(Editor), 문서(text)는 블록 문서 편집기(TextEditor)
import { useEffect, useState } from 'react'
import { db } from '../../storage/db'
import type { DocMode, ID } from '../../shared/model'
import { Editor } from './Editor'
import { TextEditor } from '../textdoc/TextEditor'

export function DocEditor({ docId }: { docId: ID }) {
  const [mode, setMode] = useState<{ id: ID; mode: DocMode } | null>(null)
  useEffect(() => {
    let alive = true
    // 문서가 없으면 Editor가 '찾을 수 없음'을 보여 준다
    void db.documents.get(docId).then((d) => alive && setMode({ id: docId, mode: d?.mode ?? 'paged' }))
    return () => {
      alive = false
    }
  }, [docId])
  if (!mode || mode.id !== docId) return <div className="editor" aria-busy="true" />
  return mode.mode === 'text' ? <TextEditor key={docId} docId={docId} /> : <Editor key={docId} docId={docId} />
}
