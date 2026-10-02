// 같은 문서를 두 탭에서 열면 나중에 연 탭은 읽기 전용 (16.4)
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('inkpad-docs') : null
const tabId = Math.random().toString(36).slice(2)
const open = new Set<string>()

type Msg = { type: 'who-has'; doc: string; from: string } | { type: 'i-have'; doc: string; from: string; to: string }

channel?.addEventListener('message', (ev: MessageEvent<Msg>) => {
  const m = ev.data
  if (m.type === 'who-has' && open.has(m.doc) && m.from !== tabId) {
    channel.postMessage({ type: 'i-have', doc: m.doc, from: tabId, to: m.from } satisfies Msg)
  }
})

/** 다른 탭이 이미 열고 있으면 false */
export function acquireDocLock(doc: string, timeoutMs = 250): Promise<boolean> {
  if (!channel) {
    open.add(doc)
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let taken = false
    const onMsg = (ev: MessageEvent<Msg>) => {
      const m = ev.data
      if (m.type === 'i-have' && m.doc === doc && m.to === tabId) taken = true
    }
    channel.addEventListener('message', onMsg)
    channel.postMessage({ type: 'who-has', doc, from: tabId } satisfies Msg)
    setTimeout(() => {
      channel.removeEventListener('message', onMsg)
      if (!taken) open.add(doc)
      resolve(!taken)
    }, timeoutMs)
  })
}

export function releaseDocLock(doc: string) {
  open.delete(doc)
}
