/**
 * 앱 스타일 전체를 빌드와 같은 순서로 이어 붙여 읽는다.
 * src/styles.css는 src/styles/*.css를 @import로 묶는 목차라서, 그 파일만 읽으면 규칙이 하나도 없다.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function readAppCss(root: string): string {
  return expand(join(root, 'src/styles.css'), new Set())
}

function expand(file: string, seen: Set<string>): string {
  if (seen.has(file)) return ''
  seen.add(file)
  const text = readFileSync(file, 'utf8')
  return text.replace(/@import\s+['"]([^'"]+)['"]\s*;/g, (_, rel: string) => expand(join(dirname(file), rel), seen))
}
