// API(Worker) 빌드: src/api/index.ts → dist/_worker.js
// dist/_routes.json(public/에서 복사됨)에 따라 /api/* 만 Worker로 가고 나머지는 정적 파일로 서빙된다.
import build from '@hono/vite-build/cloudflare-pages'
import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: false, // 클라이언트 빌드가 이미 복사함 (sw.js 프리캐시 주입본을 덮어쓰지 않도록)
  plugins: [build({ entry: 'src/api/index.ts', emptyOutDir: false })]
})
