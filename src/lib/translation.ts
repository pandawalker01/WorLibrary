export type TranslationResult = { translation: string; provider: string }

export async function translateSelection(text: string, targetLanguage: string): Promise<TranslationResult> {
  const endpoint = import.meta.env.VITE_TRANSLATION_ENDPOINT || '/api/translate'
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, targetLanguage }),
  })
  if (!response.ok) throw new Error(response.status === 404 ? '翻译服务尚未配置' : `翻译服务暂时不可用（${response.status}）`)
  const result = await response.json() as Partial<TranslationResult>
  if (!result.translation) throw new Error('翻译服务返回了空结果')
  return { translation: result.translation, provider: result.provider ?? 'translation-gateway' }
}
