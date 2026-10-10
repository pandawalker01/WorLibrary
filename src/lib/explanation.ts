import { aiResultCacheKey, createAiResultCache } from './ai-result-cache'

export type ExplanationResult = {
  translation: string
  explanation: string
  provider: string
  model?: string
  cached: boolean
}

const explanationCache = createAiResultCache<ExplanationResult>()

export class AiGatewayError extends Error {
  readonly code: string
  readonly retryable: boolean
  /** A server-provided wait time. It is intentionally absent when unknown. */
  readonly retryAfterSeconds?: number

  constructor(code: string, message: string, retryable = false, retryAfterSeconds?: number) {
    super(message)
    this.name = 'AiGatewayError'
    this.code = code
    this.retryable = retryable
    this.retryAfterSeconds = retryAfterSeconds
  }
}

function requestId() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function retryAfterSeconds(response: Response) {
  const raw = response.headers.get('retry-after')
  if (!raw || !/^\d+$/.test(raw)) return undefined
  const seconds = Number(raw)
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined
}

export async function explainSelection(text: string, targetLanguage: string, options: { sourceLanguage?: string; context?: string; requestId?: string } = {}): Promise<ExplanationResult> {
  const sourceLanguage = options.sourceLanguage || 'auto'
  const cacheKey = aiResultCacheKey('explanation', text, targetLanguage, sourceLanguage, options.context)
  const { value, hit } = await explanationCache.getOrCreate(cacheKey, async () => {
    const endpoint = import.meta.env?.VITE_TRANSLATION_ENDPOINT || '/api/explain'
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, targetLanguage, sourceLanguage, context: options.context, requestId: options.requestId || requestId() }) })
    let payload: unknown
    try { payload = await response.json() } catch { throw new AiGatewayError('invalid_response', 'AI 服务返回了无效结果') }
    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string; retryable?: boolean } })?.error
      throw new AiGatewayError(error?.code || 'gateway_error', error?.message || 'AI 服务暂时不可用', error?.retryable || false, retryAfterSeconds(response))
    }
    const result = payload as Partial<ExplanationResult>
    if (!result.translation || !result.explanation) throw new AiGatewayError('invalid_response', 'AI 服务返回了空结果')
    return { translation: result.translation, explanation: result.explanation, provider: result.provider || 'translation-gateway', model: result.model, cached: result.cached === true }
  })
  return { ...value, cached: value.cached || hit }
}

export function clearExplanationResultCache() {
  explanationCache.clear()
}
