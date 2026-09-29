// 청크 JSON gzip 압축 (설계 7.2). CompressionStream이 없으면(구형 Safari) fflate로 대체.
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate'

const hasCS = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined'

export async function gzipJson(value: unknown): Promise<Blob> {
  const text = JSON.stringify(value)
  if (hasCS) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
    return new Response(stream).blob()
  }
  return new Blob([gzipSync(strToU8(text)) as BlobPart], { type: 'application/gzip' })
}

export async function gunzipJson<T>(blob: Blob): Promise<T> {
  if (hasCS) {
    const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'))
    return JSON.parse(await new Response(stream).text()) as T
  }
  return JSON.parse(strFromU8(gunzipSync(new Uint8Array(await blob.arrayBuffer())))) as T
}
