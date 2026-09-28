// PDF 비밀번호는 저장하지 않고 이 세션 메모리에만 둔다 (16.3)
const map = new Map<string, string>()
export const rememberPassword = (assetId: string, pw: string) => map.set(assetId, pw)
export const recallPassword = (assetId: string) => map.get(assetId)
