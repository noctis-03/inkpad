/**
 * CSS 구조 검사 (의존성 없음)
 *
 * 실행:  node --experimental-strip-types --no-warnings tools/verify/css-check.ts
 *
 * 배경: styles.css에서 규칙 하나의 닫는 중괄호가 빠져, 그 뒤 약 200줄이 그 규칙 안의 '중첩 규칙'으로
 * 해석되어 작업보드 서랍 UI가 통째로 적용되지 않은 적이 있다(커밋 17d3fe2). 브라우저는 오류를 내지 않아
 * 눈으로 보기 전에는 몰랐다. 이 앱은 CSS 중첩을 쓰지 않으므로 다음을 검사한다:
 *  1. 중괄호·주석·문자열이 모두 닫혔는가
 *  2. 일반 규칙(선택자 { … }) 안에 또 다른 블록이 없는가 — @media·@supports·@container·@layer 안의 규칙과
 *     @keyframes의 단계(from·50% 등)만 블록을 품을 수 있다
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 문제 목록을 돌려준다 (없으면 빈 배열) */
export function checkCss(text: string): string[] {
  const problems: string[] = []
  // 블록 스택: 무엇이 연 블록인가 — 'group'(@media 등: 안에 규칙을 품음), 'keyframes', 'frame'(keyframes 단계), 'rule'(일반 규칙)
  const stack: { kind: 'group' | 'keyframes' | 'frame' | 'rule'; line: number; head: string }[] = []
  let line = 1
  let head = '' // 마지막 ; { } 뒤로 쌓인 글자 = 다음 블록의 머리(선택자·@규칙)
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\n') line++
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) {
        problems.push(`${line}행: 주석이 닫히지 않았다`)
        break
      }
      for (let k = i; k < end; k++) if (text[k] === '\n') line++
      i = end + 1
      continue
    }
    if (c === '"' || c === "'") {
      let k = i + 1
      while (k < text.length && text[k] !== c && text[k] !== '\n') k += text[k] === '\\' ? 2 : 1
      if (text[k] !== c) problems.push(`${line}행: 문자열이 닫히지 않았다`)
      head += text.slice(i, k + 1)
      i = k
      continue
    }
    if (c === '{') {
      const h = head.trim()
      const parent = stack[stack.length - 1]
      let kind: 'group' | 'keyframes' | 'frame' | 'rule'
      if (/^@(-webkit-)?keyframes\b/.test(h)) kind = 'keyframes'
      else if (/^@(media|supports|container|layer|document)\b/.test(h)) kind = 'group'
      else if (parent?.kind === 'keyframes') kind = 'frame'
      else kind = 'rule'
      if (parent && (parent.kind === 'rule' || parent.kind === 'frame'))
        problems.push(`${line}행: "${h.slice(0, 40)}" 블록이 ${parent.line}행 "${parent.head.slice(0, 40)}" 규칙 안에 있다 — 닫는 중괄호가 빠졌나?`)
      if (parent?.kind === 'keyframes' && kind !== 'frame') problems.push(`${line}행: @keyframes 안에 단계가 아닌 블록`)
      stack.push({ kind, line, head: h })
      head = ''
      continue
    }
    if (c === '}') {
      if (!stack.pop()) problems.push(`${line}행: 여는 중괄호 없이 닫혔다`)
      head = ''
      continue
    }
    if (c === ';') {
      head = ''
      continue
    }
    head += c
  }
  for (const open of stack) problems.push(`${open.line}행: "${open.head.slice(0, 40)}" 블록이 닫히지 않았다`)
  return problems
}

function cssFiles(dir: string): string[] {
  const out: string[] = []
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) out.push(...cssFiles(p))
    else if (f.endsWith('.css')) out.push(p)
  }
  return out
}

// 직접 실행할 때만 검사한다 (import해서 checkCss만 쓸 수도 있게)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let bad = 0
  // 검사기 자체가 옛 버그를 잡는지 먼저 확인한다
  const selfTest = checkCss('.a { color: red;\n.b { color: blue; }\n@keyframes k { from { opacity: 0 } to { opacity: 1 } }\n')
  if (!selfTest.some((p) => p.includes('규칙 안에 있다'))) {
    console.log('  ✗ 검사기 자체 시험 실패 — 닫히지 않은 규칙을 잡지 못했다')
    bad++
  }
  if (checkCss('@media (x) { .a { b: c } }\n@keyframes k { 0% { a: b } 100% { a: c } }\n.x { content: "{"; }').length) {
    console.log('  ✗ 검사기 자체 시험 실패 — 올바른 CSS를 문제로 봤다')
    bad++
  }
  const files = cssFiles(join(ROOT, 'src'))
  for (const f of files) {
    const problems = checkCss(readFileSync(f, 'utf8'))
    for (const p of problems) console.log(`  ✗ ${relative(ROOT, f)}: ${p}`)
    bad += problems.length
  }
  console.log(`\nCSS 구조: 파일 ${files.length}개, 문제 ${bad}개`)
  if (bad) process.exitCode = 1
  else console.log('모든 CSS 구조 검사 통과 ✓')
}
