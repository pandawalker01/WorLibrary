# OCR 扫描页识别

扫描 PDF 的识别入口位于 PDF 阅读器工具栏的“识别当前页”。它只将当前渲染页压缩为 JPEG 后发送至 `POST /api/ocr/page`；不会上传整本书，也不会把平台密钥放入浏览器。

生产环境的 OCR 请求和 AI 请求一样必须携带经过 Supabase JWT 验证的 `Authorization: Bearer <access-token>`。网关验证失败会返回统一的 `unauthorized` 错误，不会把页面图片传给 OCR 供应商。JWT 的服务端变量和声明检查见 `docs/ai-gateway.md`。

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

## 本地校正流程

识别成功后，PDF 阅读器会同时展示“已确认文字”和可编辑的“校正识别文字”输入区。初始识别结果已经可以选取使用；用户修改输入区后，必须点击“确认校正”，才会替换后续选取、翻译和保存摘录使用的文字。这样在编辑中途不会误把未确认草稿发给 AI 或写入摘录。

校正文本只存在当前打开的 PDF 页面和当前浏览器会话中：翻页、刷新或重新打开后不保留未保存草稿。用户通过“保存选中”写入的摘录则是正常本地数据，会按既有摘录规则在刷新后恢复；OCR 图片和整本 PDF 不会因为校正流程额外上传或同步。
