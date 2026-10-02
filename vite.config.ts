// 클라이언트(PWA) 빌드: index.html → dist/
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { cpSync, readdirSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'

/** pdf.js 보조 리소스(CMap, 표준 폰트, wasm)를 dist/pdfjs 로 복사 */
function pdfjsAssets(): Plugin {
  return {
    name: 'inkpad-pdfjs-assets',
    apply: 'build',
    writeBundle(opts) {
      const out = opts.dir ?? 'dist'
      const src = 'node_modules/pdfjs-dist'
      for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
        if (existsSync(join(src, d))) cpSync(join(src, d), join(out, 'pdfjs', d), { recursive: true })
      }
    }
  }
}

/**
 * Service Worker 프리캐시 목록 생성 (NFR-06).
 * 빌드 결과물을 sw.js의 self.__PRECACHE에 주입하고, 내용 해시로 캐시 버전을 바꾼다.
 * pdf.js CMap 등 큰 보조 리소스는 처음 쓸 때 캐시한다 (런타임 캐시).
 */
function precacheManifest(): Plugin {
  return {
    name: 'inkpad-precache',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      const out = 'dist'
      const files: string[] = []
      const walk = (dir: string) => {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f)
          const rel = '/' + relative(out, p).replace(/\\/g, '/')
          if (statSync(p).isDirectory()) {
            if (rel === '/pdfjs') continue
            walk(p)
          } else if (!/(_worker\.js|_routes\.json|sw\.js|\.map)$/.test(rel)) files.push(rel)
        }
      }
      walk(out)
      const hash = createHash('sha256')
      for (const f of files.sort()) hash.update(f).update(readFileSync(join(out, f)))
      const version = hash.digest('hex').slice(0, 12)
      const swPath = join(out, 'sw.js')
      const sw = readFileSync(swPath, 'utf8')
      const urls = files.map((f) => (f === '/index.html' ? '/' : f))
      writeFileSync(swPath, `self.__PRECACHE = ${JSON.stringify(urls)};\nself.__VERSION = '${version}';\n` + sw)
    }
  }
}

export default defineConfig({
  plugins: [react(), pdfjsAssets(), precacheManifest()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'safari16',
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/pdf-lib')) return 'pdf-lib'
          if (id.includes('node_modules/react')) return 'react'
        }
      }
    }
  },
  worker: { format: 'es' },
  server: { host: '0.0.0.0', port: 5173 }
})
