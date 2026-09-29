import { Hono } from 'hono'

// 동기화는 브라우저가 GitHub API를 직접 호출하므로 서버가 할 일이 거의 없다.
// 헬스 체크만 남긴다.
export interface AuthEnv {
  [key: string]: unknown
}

type AppEnv = { Bindings: AuthEnv }

const app = new Hono<AppEnv>().basePath('/api')

app.get('/health', (c) =>
  c.json({ ok: true, data: { service: 'inkpad-api', sync: 'github', time: Date.now() } })
)

app.notFound((c) => c.json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } }, 404))

export default app
