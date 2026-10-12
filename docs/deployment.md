# WorLibrary 部署指南

## 离线应用壳

生产构建会注册一个轻量 Service Worker：它只缓存应用壳和已请求的带哈希静态资源。它明确**不会**缓存 API 响应、Supabase 路由、下载内容或 `.epub` / `.pdf` / `.mobi` / `.cbz` 文件；用户导入的书籍始终只保存在浏览器的 OPFS / IndexedDB。

- 只在安全的生产环境（HTTPS 或 localhost）注册；`npm run dev` 不注册。Manifest 提供 standalone 安装元数据与应用图标。
- 页面导航采用网络优先，离线时回退到最近缓存的应用壳。
- 新版本会等待读者点击“立即更新”，不会在阅读过程中强制刷新。
- 如需强制失效全部旧静态资源，递增 `public/sw.js` 内的 `CACHE_NAME`；不要通过清理 OPFS / IndexedDB 来解决应用壳缓存问题，否则会删除用户本地书籍。

## 环境

| 环境 | 用途 | 来源 | 必需检查 |
| --- | --- | --- | --- |
| local | 开发与离线阅读验证 | 本地 Vite | `npm run typecheck`、`npm run build` |
| staging | 每个 PR 的预览环境 | GitHub Actions + Vercel Preview | 冒烟测试、关键流程手测 |
| production | 对外服务 | `main` 合并后人工批准的 Vercel Production | 发布清单、回滚路径、监控 |

生产和 staging 的平台密钥只放在部署平台的环境变量中，不提交 `.env`。AI/OCR 密钥只能由 API 网关使用；浏览器构建产物不得包含供应商密钥。

### 环境变量契约

复制 `.env.example` 到部署平台的环境变量面板（不要提交 `.env`）。在构建前可执行：

```sh
npm run validate:env
```

生产发布前执行 `npm run validate:env -- --production`。它会检查 Supabase URL/anon key、AI/OCR 网关、精确 HTTPS CORS Origin、生产模式、鉴权开关和 URL 格式；它也会拒绝占位值、`mock` 供应商、通配 CORS 与任何意外使用 `VITE_` 前缀的密钥。`VITE_SUPABASE_ANON_KEY` 可以出现在浏览器构建中；`AI_API_KEY`、`OCR_API_KEY`、Supabase service-role key 和部署平台 token 绝不能出现。

### 首次生产配置：最小操作清单

1. 创建 Supabase 项目；在 SQL Editor 或 CLI 依序执行 `supabase/migrations/0001_initial_sync.sql`、`0002_production_hardening.sql`、`0003_ai_usage_ledger.sql`、`0004_ai_usage_quota_release.sql`，再按 `supabase/verify_rls.sql` 用两个真实测试用户验证隔离。
2. 在前端部署项目（Vercel/Cloudflare 等）配置 `VITE_SUPABASE_URL` 与 `VITE_SUPABASE_ANON_KEY`。它们是浏览器公开配置；不要放 service-role key。
3. 在 **AI/OCR 网关的服务端环境** 配置 `AI_*`、`OCR_*`、`SUPABASE_JWT_SECRET`、`SUPABASE_URL`、`SUPABASE_ANON_KEY` 与一个精确的 `ALLOWED_ORIGIN=https://你的域名`；两个 `*_ENV` 均为 `production`，`AI_REQUIRE_AUTH=true`。不要把这些 Secret 放入前端部署环境或仓库。
4. 依次执行 `0003_ai_usage_ledger.sql` 和 `0004_ai_usage_quota_release.sql`。网关会使用已验证用户的 JWT 调用 `consume_ai_quota`，并在供应商失败时调用 `release_ai_quota`；生产环境缺少 `SUPABASE_URL` / `SUPABASE_ANON_KEY` 会在调用供应商前拒绝请求。该账本只记录用户、请求 ID、操作种类与状态，不保存原书、正文、图像或模型输出。
5. 配置 GitHub `staging` / `production` environments 中的 Vercel 三项部署 Secret，并在 production environment 开启 required reviewers。随后在部署环境运行 `npm run validate:env -- --production` 与 `npm run test:production`。

完成第 1–3 步后，网页可以进行登录与同步；完成第 4 步对应的网关适配后，才可安全对外启用真实 AI/OCR。预检通过只说明变量格式正确，不替代真实 RLS、JWT、供应商与跨域连通性验收。

部署平台的健康探针使用 `GET /api/health`（也支持 `GET /health`）。响应只包含服务状态、AI provider 名称和是否已配置，不会返回密钥或用户数据；探针应要求 HTTP 200，并设置 10 秒以内的超时。每次请求的 `x-request-id` 会在响应和服务端结构化日志中保留，便于从前端错误追踪到网关日志。生产构建可用一条命令执行：

```sh
npm run test:production
```

该命令只验证本地构建契约和网关逻辑，不代表真实 Supabase/RLS 或供应商凭据已连通。

### 可机读发布质量门禁

发布或 CI 可执行单一命令：

```sh
npm run quality
```

它会运行生产环境契约、类型检查、构建、前端包体预算、AI 网关测试和全部 Playwright 测试，并生成 `test-results/release-report.json`。报告中的 `classification: "configuration"` 表示缺少部署凭据或环境变量，门禁会以退出码 `2` 标记为 `blocked`；`classification: "code"` 的失败则以退出码 `1` 标记为 `failed`。如果测试服务器无法启动，报告会标记 `classification: "infrastructure"` 与 `blocked`，而不会误报为产品代码失败。这使测试 Agent 能区分“需要部署人员配置”“需要修复测试环境”与“需要开发修复”的问题。

构建后的包体预算可单独运行：

```sh
npm run build
npm run test:bundle
```

门禁要求应用入口、EPUB 阅读器、PDF 阅读器和 PDF worker 都拥有独立产物，并同时检查原始大小与 gzip 大小。当前预算分别为 `350/110 kB`、`400/120 kB`、`500/150 kB` 和 `1400/400 kB`（原始/gzip）；超出预算或丢失独立 chunk 均视为代码质量失败。调整预算必须同时说明测量结果、用户可感知收益和回退方案，不能仅通过提高 Vite 的警告阈值掩盖回归。

### Supabase 数据库迁移

使用 Supabase CLI 在目标项目执行迁移，不要直接把本地书籍文件上传到数据库：

```sh
npx supabase link --project-ref <project-ref>
npx supabase db push
```

`supabase/migrations/0001_initial_sync.sql` 创建用户资料、作品、版本、进度、摘录和设置表；`0002_production_hardening.sql` 增加索引、显式 authenticated 权限，并校验版本/进度/摘录只能引用同一用户的数据；`0003_ai_usage_ledger.sql` 创建仅能由受控 RPC 写入的按日 AI/OCR 用量账本；`0004_ai_usage_quota_release.sql` 在供应商失败时释放预扣额度。迁移使用 `if not exists` 或 `drop policy if exists`，可安全地在已执行 0001 的项目上继续执行。

上线前用一个测试账号验证：A 用户不能读取/修改 B 用户的版本、进度或摘录；匿名用户不能访问同步表；删除账号后级联删除其数据。没有真实 Supabase 凭据时，只能完成 SQL 静态检查和本地构建，不能声称 RLS 已在线验证。

## GitHub Actions

`.github/workflows/ci.yml` 对 Pull Request 和 `main` 推送执行类型检查、构建和 Playwright Chromium 冒烟测试。预览发布需要在 GitHub 的 `staging` environment 配置 `VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`；生产发布使用 `production` environment，并开启 required reviewers 作为人工确认。

CI 还会检查登录/匿名试用契约、IndexedDB 与远端同步合并、翻译成功/失败与缓存、CORS、双译本低置信度回退，以及 migration 的 RLS 策略。预览 job 会在部署前显式检查 staging 三个 Vercel secret；缺失时直接失败并给出变量名。

## 域名与安全头

将域名 DNS 指向托管平台并开启 HTTPS 强制跳转。`public/_headers` 为支持 `_headers` 的托管平台提供 CSP、禁止 iframe、严格 Referrer Policy 和 Permissions Policy；其他平台须在其响应头设置中复制同等策略。若接入 API 网关，将其 HTTPS origin 加入 `connect-src`，不要放宽为 `*`。

上线前验证：

```sh
curl -sI https://staging.example.com/
curl -sI https://app.example.com/
```

确认响应包含 `content-security-policy`、`strict-transport-security`、`x-content-type-options`、`x-frame-options` 和 `referrer-policy`。HSTS 由托管平台开启，不能只依赖 Vite 开发服务器。

## 发布流程

1. PR 通过 typecheck、build 和 Playwright smoke。
2. 在 staging 导入 EPUB/PDF，阅读、划线、备份恢复，并验证翻译失败提示。
3. 检查 Sentry 无新增高优先级错误，确认数据库 migration 已按版本执行。
4. 合并到 `main`，在 GitHub Actions 的 production environment 点批准。
5. 发布后执行 `docs/runbook.md` 的冒烟与回滚检查。

如果预览部署失败，先查看 Vercel deployment logs 和 staging secret 校验结果；不要把生产 secret 临时复制到 PR 环境。修复后重新运行同一个 PR 的 workflow，确认旧预览仍可访问再替换。
