import type { Engine } from '../../engine/engine'
import { prepareImage } from '../../engine/images'
import { useUI } from '../../app/store'
import { putAsset } from '../../storage/repo'

/** 한 번에 넣는 사진 수 상한 — 원본을 하나씩 줄여 저장하므로 너무 많이 고르면 오래 걸린다 */
const MAX_AT_ONCE = 10

/**
 * 고른·붙여 넣은 사진을 노트에 넣는다 — 줄여서 원본(에셋)으로 저장하고 화면 가운데에 놓는다.
 * 넣은 뒤에는 올가미로 바꿔 마지막 사진을 골라 둔다 — 바로 끌어 옮기고 모서리로 크기를 바꿀 수 있게
 */
export async function insertPhotos(engine: Engine, files: Iterable<File>): Promise<number> {
  const { toast, setTool } = useUI.getState()
  const list = [...files].filter((f) => f.type.startsWith('image/'))
  if (!list.length) return 0
  if (list.length > MAX_AT_ONCE) toast(`사진은 한 번에 ${MAX_AT_ONCE}장까지 넣습니다.`, 'info')
  let n = 0
  for (const file of list.slice(0, MAX_AT_ONCE)) {
    try {
      const img = await prepareImage(file)
      const row = await putAsset(img.blob, { kind: 'image', mime: img.mime, name: file.name || undefined })
      if (n === 0) {
        setTool('lasso')
        engine.setTool('lasso') // 상태 구독(effect)보다 먼저 — 넣은 사진을 바로 골라 두려고
      }
      if (engine.insertImage(row.id, { w: img.w, h: img.h }, img.bmp, n)) n++
    } catch (e) {
      console.warn('[photo] 사진을 넣지 못했습니다.', e)
      toast(e instanceof DOMException && e.name === 'QuotaExceededError' ? '기기 저장 공간이 부족해 사진을 넣지 못했습니다.' : '이 사진을 읽지 못했습니다.', 'error')
    }
  }
  return n
}
