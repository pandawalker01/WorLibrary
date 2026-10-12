# AI 翻译网关配置

浏览器只调用 `/api/translate` 和 `/api/explain`，供应商密钥只允许存在于部署网关的服务端环境变量中。不要在 `VITE_*` 变量、前端代码、测试快照或提交记录中放置 API key。

## 生产环境

网关当前使用 OpenAI 兼容的 Chat Completions 接口。部署平台为函数或 Worker 时，将以下值配置为服务端 Secret：

| 变量 | 作用 | 生产建议 |
| --- | --- | --- |
| `AI_PROVIDER` | 供应商类型 | `openai` 或兼容实现；不要设为 `mock` |
| `AI_API_KEY` | 供应商密钥 | 必填，服务端 Secret |
| `AI_BASE_URL` | API 根地址 | `https://…/v1`，默认 OpenAI 地址 |
| `AI_MODEL` | 模型名 | 按供应商可用模型设置 |
| `AI_ENV` | 网关运行环境 | `production` |
| `AI_REQUIRE_AUTH` | 是否强制 Bearer 鉴权 | 生产设为 `true` |
| `SUPABASE_JWT_SECRET` | Supabase Auth 的 HS256 JWT secret | 生产必填，只保存在网关 Secret 中 |
| `SUPABASE_JWT_ISSUER` | JWT `iss` 的精确值 | 建议设为 `https://<project-ref>.supabase.co/auth/v1` |
| `SUPABASE_JWT_AUDIENCE` | JWT `aud` 的精确值 | 通常为 `authenticated` |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | 用于调用受控额度 RPC | 生产必填；仅服务端网关使用 |
| `ALLOWED_ORIGIN` | 浏览器来源 | 生产站点的精确 HTTPS Origin |

可选的保护参数：`AI_TIMEOUT_MS`（每次上游请求，默认 12000，最大 120000）、`AI_RETRY_ATTEMPTS`（默认 2，最大 3）、`AI_RETRY_DELAY_MS`（默认 1，最大 2000）、`AI_RATE_LIMIT`（每用户每分钟，默认 10）、`AI_DAILY_QUOTA`（默认 20）和 `AI_CACHE_TTL_MS`（默认 24 小时）。无效或过大的数值会回退/限制在安全范围内。

错误契约固定为 `{ error: { code, message, retryable } }`。上游 429 映射为 `provider_rate_limited`；上游 5xx/无效响应映射为 `provider_error`；超时映射为 `provider_timeout`。网关仅重试 `provider_error` 与 `provider_rate_limited`，不会重试鉴权或配置错误。

## Supabase JWT 鉴权

AI 与 OCR 网关会从 `Authorization: Bearer <access-token>` 提取 Supabase access token，并使用服务端 `SUPABASE_JWT_SECRET` 对 HS256 签名、`exp`、`nbf`、`sub` 进行校验；配置后还会校验 `iss` 与 `aud`。无 token、签名不正确、过期、或声明不匹配都会按统一错误契约返回 `unauthorized`，不会调用供应商，也不会回退为匿名身份。

生产环境无条件要求该验证，即使误把 `AI_REQUIRE_AUTH` / `OCR_REQUIRE_AUTH` 配为 `false` 也不会放行。开发环境只有在显式关闭对应 `*_REQUIRE_AUTH` 时，才允许本地 mock 使用匿名请求。不要把浏览器的 anon key、service-role key 或任意自造 Bearer 字符串当作 JWT secret；JWT secret 仅应存于网关的 Secret 配置中。

## 本地开发 mock

本地联调可仅在服务端设置：

```text
AI_PROVIDER=mock
AI_ENV=development
```

mock 返回带目标语言前缀的确定性文本，不访问外网，也不需要任何密钥。`AI_PROVIDER=mock` 在 `AI_ENV=production` 下会被拒绝并返回 `provider_unavailable`，避免把模拟结果发布给用户。

真实供应商联调时，将 `AI_PROVIDER` 留为 `openai`，并在本地网关进程的私有环境中设置 `AI_API_KEY`；不要把它写入 `.env` 后提交。前端如需改变网关地址，只可使用 `VITE_TRANSLATION_ENDPOINT`，它只能保存公开的网关 URL，不是密钥。

## 发布前检查

```bash
npm run test:gateway
npx playwright test tests/contracts.spec.ts
```

确认生产部署中已配置精确的 `ALLOWED_ORIGIN`、鉴权验证器和 `SUPABASE_URL` / `SUPABASE_ANON_KEY`。网关使用已验证用户的 Bearer JWT 调用 `consume_ai_quota`；供应商失败时会调用 `release_ai_quota` 释放本次预扣额度。只发送 request id、操作种类与额度，不发送划词正文、图像或密钥。生产环境缺少持久化适配会在调用供应商前安全拒绝；进程内 Map 仅适用于本地开发或单实例演示。
