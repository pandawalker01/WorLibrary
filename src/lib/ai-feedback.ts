import { AiGatewayError } from './explanation'

export type AiFeedback = {
  title: string
  detail: string
  retryable: boolean
}

/**
 * Converts gateway and browser failures into short, safe reader-facing guidance.
 * Never interpolate an upstream error: it can contain provider details or selected text.
 */
export function aiFeedbackFor(error: unknown): AiFeedback {
  if (error instanceof AiGatewayError) {
    switch (error.code) {
      case 'provider_unavailable':
        return { title: 'AI 服务暂不可用', detail: '请稍后重试；若持续出现，请检查部署配置。', retryable: true }
      case 'provider_timeout':
        return { title: 'AI 响应超时', detail: '服务响应较慢。请稍后重试，或缩短选中的文字。', retryable: true }
      case 'rate_limited':
      case 'provider_rate_limited':
        return { title: 'AI 服务繁忙', detail: '请求过于频繁或供应商繁忙，请稍后重试。', retryable: true }
      case 'quota_exceeded':
        return { title: '今日额度已用完', detail: '请明天再试，或联系管理员调整试用额度。', retryable: false }
      case 'unauthorized':
        return { title: '需要登录', detail: '登录后即可继续使用 AI 学习功能。', retryable: false }
      default:
        return { title: 'AI 服务暂不可用', detail: error.retryable ? '请稍后重试。' : '请检查设置后再试。', retryable: error.retryable }
    }
  }

  if (error instanceof TypeError) {
    return { title: '当前处于离线状态', detail: '请检查网络连接后重试；阅读和本地摘录仍可离线使用。', retryable: true }
  }

  return { title: 'AI 请求未完成', detail: '请稍后重试。', retryable: true }
}
