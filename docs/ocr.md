# OCR 扫描页识别

扫描 PDF 的识别入口位于 PDF 阅读器工具栏的“识别当前页”。它只将当前渲染页压缩为 JPEG 后发送至 `POST /api/ocr/page`；不会上传整本书，也不会把平台密钥放入浏览器。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `OCR_PROVIDER` | `mock`（仅开发）或实际供应商名称 |
| `OCR_ENV` | 生产环境必须为 `production` |
| `OCR_BASE_URL` | 实际供应商的服务器端 API 根地址 |
| `OCR_API_KEY` | 服务端 Secret，绝不能使用 `VITE_` 前缀 |
| `OCR_TIMEOUT_MS` | 单页请求超时，默认 20 秒，最大 120 秒 |

开发环境的 `OCR_PROVIDER=mock` 返回确定性模拟文本，不访问网络。生产环境会拒绝 mock 或缺少 provider 配置，并返回 `provider_unavailable`。接口错误格式为 `{ error: { code, message, retryable } }`，超时固定为 `provider_timeout`。

实际 provider 需实现 `POST {OCR_BASE_URL}/ocr`，接受 `{ image, mimeType, language }`，返回 `{ text, confidence? }`。密钥只在网关环境中读取；日志仅记录请求状态、provider 和 request id，不记录图片或识别正文。
