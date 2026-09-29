// 간단한 ULID (시간순 정렬 가능한 26자 ID)
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
let lastTime = 0
let lastRand: number[] = []

export function ulid(now = Date.now()): string {
  let t = now
  let time = ''
  for (let i = 0; i < 10; i++) {
    time = ENC[t % 32] + time
    t = Math.floor(t / 32)
  }
  if (now === lastTime) {
    // 같은 ms 안에서는 단조 증가
    for (let i = lastRand.length - 1; i >= 0; i--) {
      if (lastRand[i] < 31) { lastRand[i]++; break }
      lastRand[i] = 0
    }
  } else {
    lastTime = now
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    lastRand = Array.from(bytes, (b) => b % 32)
  }
  return time + lastRand.map((r) => ENC[r]).join('')
}
