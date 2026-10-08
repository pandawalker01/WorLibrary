import { AiGatewayError } from './explanation'

export type OcrResult = { text: string; provider: string; confidence?: number; requestId: string }

function requestId() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function toDataUrl(image: Blob) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('无法读取当前页图片'))
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取当前页图片'))
    reader.readAsDataURL(image)
  })
}

export async function recognizePage(image: Blob, options: { language?: string; requestId?: string } = {}): Promise<OcrResult> {
  if (!image.type.startsWith('image/')) throw new AiGatewayError('invalid_request', '当前页图片无效，请重新打开后再试')
  const endpoint = import.meta.env.VITE_OCR_ENDPOINT || '/api/ocr/page'
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: await toDataUrl(image), language: options.language || 'auto', requestId: options.requestId || requestId() }) })
  let payload: unknown
  try { payload = await response.json() } catch { throw new AiGatewayError('invalid_response', '文字识别服务返回了无效结果') }
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; retryable?: boolean } }).error
    throw new AiGatewayError(error?.code || 'gateway_error', error?.message || '文字识别失败，请稍后重试', error?.retryable || false)
  }
  const result = payload as Partial<OcrResult>
  if (!result.text || !result.requestId) throw new AiGatewayError('invalid_response', '文字识别服务返回了空结果')
  return { text: result.text, provider: result.provider || 'ocr-gateway', confidence: result.confidence, requestId: result.requestId }
}
