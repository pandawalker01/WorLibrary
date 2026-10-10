import { AiGatewayError } from './explanation'
import { aiResultCacheKey, createAiResultCache } from './ai-result-cache'

export type TranslationResult = { translation: string; provider: string; model?: string; cached: boolean }

const translationCache = createAiResultCache<TranslationResult>()

function requestId() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function retryAfterSeconds(response: Response) {
  const raw = response.headers.get('retry-after')
  if (!raw || !/^\d+$/.test(raw)) return undefined
  const seconds = Number(raw)
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined
}

export async function translateSelection(text: string, targetLanguage: string, options: { sourceLanguage?: string; context?: string; requestId?: string } = {}): Promise<TranslationResult> {
  const sourceLanguage = options.sourceLanguage || 'auto'
  const cacheKey = aiResultCacheKey('translation', text, targetLanguage, sourceLanguage, options.context)
  const { value, hit } = await translationCache.getOrCreate(cacheKey, async () => {
    const endpoint = import.meta.env?.VITE_TRANSLATION_ENDPOINT || '/api/translate'
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, targetLanguage, sourceLanguage, context: options.context, requestId: options.requestId || requestId() }),
    })
    let payload: unknown
    try { payload = await response.json() } catch { throw new AiGatewayError('invalid_response', '翻译服务返回了无效结果') }
    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string; retryable?: boolean } })?.error
      throw new AiGatewayError(error?.code || 'gateway_error', error?.message || '翻译服务暂时不可用', error?.retryable || false, retryAfterSeconds(response))
    }
    const result = payload as Partial<TranslationResult>
    if (!result.translation) throw new AiGatewayError('invalid_response', '翻译服务返回了空结果')
    return { translation: result.translation, provider: result.provider ?? 'translation-gateway', model: result.model, cached: result.cached === true }
  })
  return { ...value, cached: value.cached || hit }
}

export function clearTranslationResultCache() {
  translationCache.clear()
}
