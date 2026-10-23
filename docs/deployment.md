# WorLibrary 部署指南

## 本轮内测 MVP 的部署边界

内测环境只需部署 React 应用壳、Cloudflare Worker 的目录/翻译路由、Supabase 邮箱登录和经过验收的元数据同步。同步仅保存书架元数据、进度、摘录和必要偏好；本地 EPUB/PDF、封面二进制与离线正文不上传。新设备看到这些本地书的远端元数据时必须显示“需重新导入原书”，并拒绝打开本地阅读器。

本轮不部署用户文件备份 bucket、恢复码或配额服务，不开放 Google/Apple 登录或匿名迁移，也不启用平台正文的运营发布、授权交付或下载。平台内容的 R2 binding、resolver、许可和运营流程仅在后续合规内容阶段启用，不能作为当前内测测试数据的替代品。

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
| staging | 每个 PR 的预览环境 | Cloudflare Workers Preview | 冒烟测试、关键流程手测 |
| production | 对外服务 | `main` 合并后人工批准的 Cloudflare Workers Production | 发布清单、回滚路径、监控 |

## Cloudflare Workers 部署基线

本项目不是纯静态网站：`dist/` 中的 React/Vite 应用壳、样式和图标是静态资源；同一个 Cloudflare Worker 同时处理 `/api/catalog`、`/api/health`、`/api/translate`、`/api/explain`、`/api/translation-status`、平台内容访问策略 `/api/reader/access` 和已授权平台正文的 `/api/reader/content`。静态资源可由边缘网络缓存；世界书库只缓存短期、无身份的公共书目查询。选区、登录、AI/OCR、同步、内容访问策略、正文、错误和健康响应不得被共享缓存。

首次接入需由项目所有者完成：创建 Cloudflare 账号与 Workers 项目、将 GitHub 仓库接入部署，先使用 `*.workers.dev` 验收，再绑定正式域名。不要在聊天、仓库或前端变量中提供或提交 Cloudflare API Token。CI 使用的 Token 应限制到该账号/项目的 Workers 编辑权限；生产部署应使用独立环境与审批。

本地安装依赖后可运行：

```sh
npm run cf:dev
```

该脚本会先执行生产构建，确保 Worker 挂载的是当前源码生成的 `dist/`；若改为直接运行 `wrangler dev`，必须先手动执行 `npm run build`。

发布命令为：

```sh
npm run build
npm run cf:deploy
```

在未登录 Cloudflare 或未配置项目名称前，这些命令不会完成真实部署；应先运行本地构建与 Worker 路由契约测试。`wrangler.jsonc` 的 `name` 必须在首次部署前改为账户内唯一的项目名。

生产和 staging 的平台密钥只放在部署平台的环境变量中，不提交 `.env`。AI/OCR 密钥只能由 API 网关使用；浏览器构建产物不得包含供应商密钥。

### Cloudflare 划词翻译配置

Worker 已实现真实的 OpenAI-compatible 翻译和解释路由。将以下值在 Cloudflare Dashboard 的 **Workers & Pages → worlibrary → Settings → Variables and Secrets** 中添加为 **Secret**（不要添加为 `VITE_*` 变量，也不要提交到 GitHub）：

```text
AI_API_KEY=<provider API key>
```

以下不是密钥，可按需作为普通 Worker variable 添加：

```text
AI_PROVIDER=openai
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=<your approved model>
AI_RATE_LIMIT=10
AI_TIMEOUT_MS=12000
```

设置后重新运行 GitHub Actions 的 `CI` 工作流并选择 `staging` 或 `production`，使新 Secret 生效。部署验证会访问不消耗模型额度的 `GET /api/translation-status`；它只会返回 `configured: true/false`，不会发送书籍文本或暴露配置值。真实验收必须由项目所有者使用无版权测试片段在阅读器中完成。

当前 Worker 的 `AI_RATE_LIMIT` 是单边缘实例、按 Cloudflare 提供的客户端 IP 做的短窗口保护，并非账户级额度系统。对外开放付费 AI 前，必须在 Cloudflare 配置 WAF/Rate Limiting 规则，并接入认证与持久化额度账本；在此之前仅可用于受控内测，不能把公开 URL 当作无限制翻译 API。

### 平台书籍访问策略契约

`GET /api/reader/access?editionId=<平台版本 ID>` 只回答某个平台版本的**访问策略**，不传输 EPUB/PDF 正文、不返回 R2 对象键、文件 URL、签名下载 URL、阅读令牌或任何 Secret。成功响应包含稳定的 `access_mode`：`download`、`stream`、`external_reader`、`preview` 或 `catalog_only`。当该版本已经配置私有 R2 对象、格式和绑定时，`delivery.available` 为 `true`，`delivery.mode` 为 `in_app_stream`，并给出可安全渲染的 `delivery.content_type`；否则它会明确返回不可交付原因。前端不得把访问策略误当作可下载文件或永久正文 URL。

当前受控内测的访问策略由 Worker Secret `PLATFORM_CONTENT_ACCESS_JSON` 提供，格式为 JSON 数组。含有 `r2ObjectKey` 的条目必须作为 Secret 保存，因为对象键属于内部内容定位信息，绝不能交给浏览器。它仅适用于尚未接入动态 resolver 的测试内容，不能作为运营发布的长期数据源：

```json
[
  {
    "editionId": "public-domain-example",
    "accessMode": "download",
    "requiresAuthorization": false,
    "rightsNotice": "Public domain."
  },
  {
    "editionId": "licensed-stream-example",
    "accessMode": "stream",
    "requiresAuthorization": true,
    "r2ObjectKey": "licensed/edition.epub",
    "contentType": "application/epub+zip",
    "rightsNotice": "Licensed for in-app streaming only."
  }
]
```

受限版本要求浏览器携带既有登录会话的 `Authorization` header。Worker 只会把该 header 转交给配置为 HTTPS 的内部授权服务 `READER_AUTHORIZATION_URL`，并向其发送版本 ID 与访问模式；授权服务只能返回 `{ "allowed": true | false }`。若缺少会话、授权服务、策略配置或授权被拒绝，Worker 分别以 `AUTH_REQUIRED`（401）、`AUTHORIZATION_UNAVAILABLE`（503）、`PLATFORM_ACCESS_UNCONFIGURED` / `ACCESS_POLICY_INVALID`（503）与 `ACCESS_DENIED`（403）失败关闭。不要把授权服务 URL、用户身份、会话 token 或内容交付信息回传给浏览器。

为启用 WorLibrary 内阅读，需要在 Workers Dashboard 以 **R2 bucket binding** 绑定私有桶，绑定名称固定为 `PLATFORM_CONTENT`；不要使用公开 R2 域名。`GET` / `HEAD` `/api/reader/content?editionId=<平台版本 ID>` 仅为 `stream` 或 `preview` 的已配置平台版本读取该桶，并在**每次请求**重新验证上述授权。它支持单段 `Range: bytes=start-end`，只返回 `application/epub+zip` 或 `application/pdf`，使用 `Cache-Control: private, no-store`，不会返回对象键、签名 URL、令牌或持久下载地址。未配置绑定/对象、错误范围或缺失/失败授权均失败关闭。该路由不支持 `download`，因此不会在第一阶段意外提供完整离线文件。

平台阅读器收到允许的媒体类型后，会用带 Authorization 的无缓存请求将正文临时读为内存 ArrayBuffer，再交给 EPUB.js 或 PDF.js；它不创建 File、对象 URL、IndexedDB/OPFS 记录、全文索引或下载入口，卸载时销毁渲染器资源。首次上线必须分别使用一个已授权 EPUB 与 PDF 验收翻页、撤销授权后的失败状态和关闭阅读页后的内存释放；此过程不替代权利审核。

### 已审核平台目录（仅引导期）

世界书库可以合并一个由运营方维护的 `PLATFORM_CATALOG_JSON` 目录。它只包含安全的书目投影（`editionId`、标题、作者、语言、主题、封面 URL 与来源/许可证说明页），不能包含对象键、文件 URL、签名 URL、正文、用户数据或任何 Secret。Worker 会对每条记录要求一个同 `editionId` 的 `PLATFORM_CONTENT_ACCESS_JSON` 策略；没有匹配策略、格式错误或未经审核的记录都会被静默排除。因而，第三方来源的“免费”“公共领域”标签本身永远不会生成 WorLibrary 内阅读或下载入口。

示例仅说明字段形状，真实条目必须先完成来源、许可证、地区和哈希审核：

```json
[
  {
    "editionId": "reviewed-open-edition",
    "title": "Reviewed Open Edition",
    "author": "Verified rights holder",
    "languages": ["eng", "fra"],
    "subjects": ["world literature"],
    "sourceUrl": "https://rights-holder.example/edition"
  }
]
```

`PLATFORM_CATALOG_JSON` 不含内部定位信息，可作为普通 Worker Variable；但在动态 resolver 投产后应由服务端发布目录替代，而不是长期手工维护。`PLATFORM_CONTENT_ACCESS_JSON` 仍应作为 Secret。首先把来源内容存入**平台私有** R2、记录来源与许可证、验证 SHA-256、经受控发布流程生成版本和策略，才可把该版本加入目录。用户自导入文件走完全独立的个人私有云书库流程，不能放进这个目录或用于平台分发。

这不是 DRM：浏览器显示正文仍无法绝对阻止截图或有能力的网络抓取。它的边界是：不提供原始文件下载入口、不把完整文件写入应用的本地书库，并由短生命周期登录会话、每次访问重验授权、地区/版权期限、审计和下架策略共同约束。不得代理或镜像第三方未授权正文。

### 本地完整翻译验收

不要用 `npm run dev` 验证真实翻译：它只启动 Vite，不能提供 Worker 的 `/api/translate` 路由。请在仓库根目录创建本机专用的 `.dev.vars` 文件；它已被 Git 忽略，绝不能提交或截图。文件内容示例为：

```text
AI_API_KEY=<your provider key>
AI_MODEL=<your approved model>
```

`AI_PROVIDER` 和 `AI_BASE_URL` 可不填，会使用 Worker 的 OpenAI 默认值。随后依序运行：

```sh
npm run build
npm run cf:dev
```

`npm run cf:dev` 会重新构建 `dist/`，随后 Wrangler 读取 `.dev.vars` 并启动本地 Worker 与当前静态应用壳；终端会显示本地 URL（通常为 `http://localhost:8787`）。在该地址导入测试 EPUB/PDF、选中少量无版权文字并点击翻译，即可验收完整本地链路。停止开发服务器后，本地配置仍只保留在 `.dev.vars`，不会上传 Cloudflare 或 GitHub。

### 环境变量契约

复制 `.env.example` 到部署平台的环境变量面板（不要提交 `.env`）。预检只读取当前进程环境，不联网、不打印变量值或密钥；可用 JSON 输出让 CI/QA 精确识别缺失项：

```sh
# 本地优先的书架预览：云能力可不配，结果会给出明确 warnings。
npm run validate:env -- --staging --json

# Cloudflare Worker 路由契约（不需要真实账号或密钥）。
npm run test:worker

# 完整生产云服务：认证、同步、AI 与 OCR 均必须安全配置。
npm run validate:env -- --production --json
```

`--staging` 的 Supabase、AI、OCR 都是独立的可选能力：完全未配置时，应用仍可部署并提供本地导入和离线阅读，JSON 的 `capabilities` 会标为 `disabled`，同时给出用户可读的 `warnings`。一旦填了其中任一变量，该能力会转为 `enabled`，预检会要求它的完整安全依赖，避免“页面看似已启用、实际半配置”的状态。AI 或 OCR 启用时，必须同时配置服务端 `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_JWT_SECRET`、精确 HTTPS `ALLOWED_ORIGIN`、`*_ENV=production` 与 `*_REQUIRE_AUTH=true`。

在 staging 与 production 中，`VITE_SUPABASE_URL`、`SUPABASE_URL`、`AI_BASE_URL` 与 `OCR_BASE_URL` 必须使用 HTTPS；HTTP 仅可用于本地开发。预检会拒绝不安全端点，避免浏览器混合内容、登录/同步不可用或服务端密钥走明文链路。

`--production` 用于公开完整云服务，强制要求浏览器 Supabase 配置、AI/OCR 网关、精确 HTTPS CORS Origin、生产模式、鉴权开关和 URL 格式。它拒绝占位值、`mock` 供应商、通配 CORS 与任何意外使用 `VITE_` 前缀的密钥。`VITE_SUPABASE_ANON_KEY` 可以出现在浏览器构建中；`AI_API_KEY`、`OCR_API_KEY`、`SUPABASE_JWT_SECRET`、Supabase service-role key 和 Cloudflare API Token 绝不能出现。旧的 `--deployment` 预检只服务于历史 Vercel 流程，不应用于 Cloudflare；Cloudflare 部署凭据由 GitHub Environment Secret 与 Wrangler 在发布时校验。

### 首次生产配置：最小操作清单

1. 创建 Supabase 项目；在 SQL Editor 或 CLI 按编号顺序执行已有 migration（当前至少包括 `0001_initial_sync.sql` 至 `0012_private_highlight_sync_rpc.sql`），再按 `supabase/verify_rls.sql` 用两个真实测试用户验证隔离。`0008`/`0009` 提供受控元数据同步底座，`0012` 增加只允许本人活跃设备提交摘录文本、位置、笔记与颜色的专用 RPC，`0011` 只提供账户资料与私有头像桶基础；执行 migration 本身不等于客户端已完成同步或头像上传。只有准备接入平台自有/获授权正文时，才继续完成 `0006`/`0007` 对应的受控运营流程和下方“首个合规内容来源接入清单”；不要为试用书目搜索虚构许可或内容资产。
2. 在 Cloudflare Worker 项目配置 `VITE_SUPABASE_URL` 与 `VITE_SUPABASE_ANON_KEY`。它们是浏览器公开配置；不要放 service-role key。
3. 在 **AI/OCR 网关的服务端环境** 配置 `AI_*`、`OCR_*`、`SUPABASE_JWT_SECRET`、`SUPABASE_URL`、`SUPABASE_ANON_KEY` 与一个精确的 `ALLOWED_ORIGIN=https://你的域名`；两个 `*_ENV` 均为 `production`，`AI_REQUIRE_AUTH=true`、`OCR_REQUIRE_AUTH=true`。不要把这些 Secret 放入前端部署环境或仓库。
4. 依次执行 `0003_ai_usage_ledger.sql` 和 `0004_ai_usage_quota_release.sql`。网关会使用已验证用户的 JWT 调用 `consume_ai_quota`，并在供应商失败时调用 `release_ai_quota`；生产环境缺少 `SUPABASE_URL` / `SUPABASE_ANON_KEY` 会在调用供应商前拒绝请求。该账本只记录用户、请求 ID、操作种类与状态，不保存原书、正文、图像或模型输出。
5. 在 GitHub `staging` / `production` environments 中分别配置 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`，并在 production environment 开启 required reviewers。Token 只授予该账号内 Workers 的编辑权限。通过 `workflow_dispatch` 选择环境后才会部署；完整云服务再运行 `npm run validate:env -- --production` 与 `npm run test:production`。

完成第 1–3 步后，网页可以进行登录；只有客户端页面写入已接入账户隔离 outbox、顺序 flush 与 revision pull，并在两个独立浏览器 profile 通过 RLS、幂等、墓碑、断网重放和账户切换验收后，才可启用内测元数据同步。完成第 4 步对应的网关适配后，才可安全对外启用真实 AI/OCR。预检通过只说明变量格式正确，不替代真实 RLS、JWT、供应商与跨域连通性验收。

部署平台的健康探针使用 `GET /api/health`（也支持 `GET /health`）。Cloudflare Worker 当前提供健康与世界书库目录路由；AI/OCR 网关迁移完成前不得把它们标记为已由 Worker 托管。不要在前端构建变量中放置服务端密钥。响应只包含服务状态与公开的运行时能力，不会返回密钥或用户数据；探针应要求 HTTP 200，并设置 10 秒以内的超时。每次请求的 `x-request-id` 会在响应和服务端结构化日志中保留，便于从前端错误追踪到网关日志。健康、翻译与解释的成功和错误响应均会带 `Cache-Control: no-store`：这不是性能缓存开关，而是防止用户划词内容、认证错误或供应商错误经过浏览器与 CDN 的共享 HTTP 缓存。

```sh
npm run test:production
```

该命令只验证本地构建契约和网关逻辑，不代表真实 Supabase/RLS 或供应商凭据已连通。

部署完成后，发布人员使用 Cloudflare Worker 的 `workers.dev` 或自定义域名执行 `npm run verify:deployment`。该检查要求 HTTPS、`/api/health` 返回带回显 `x-request-id` 和 `cache-control: no-store` 的 Worker 健康 JSON；还会读取不消耗 AI 用量的 `/api/translation-status`，确认其私有缓存策略、请求 ID 回显和无敏感字段；同时会真实请求 `/api/catalog?q=world%20classics&language=eng`，验证世界书库代理能返回来源与书目数组、短期公共缓存头和请求 ID，并要求首页带 CSP、HSTS、反 MIME 嗅探、反 iframe 与 Referrer Policy。GitHub 的手动 Cloudflare 部署会自动提取 Wrangler 输出的 `workers.dev` 地址并执行该验证，因此不依赖发布者本地网络是否能访问该测试域名。也可在发布人员本机手动运行：

```sh
npm run verify:deployment -- https://app.example.com
```

它只读取公开响应头与健康响应，不发送认证信息、书籍内容或密钥；失败时应保留终端中的 request id 并按 `docs/runbook.md` 排查，而不是跳过检查。

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

`supabase/migrations/0001_initial_sync.sql` 创建用户资料、作品、版本、进度、摘录和设置表；`0002_production_hardening.sql` 增加索引、显式 authenticated 权限，并校验版本/进度/摘录只能引用同一用户的数据；`0003_ai_usage_ledger.sql` 创建仅能由受控 RPC 写入的按日 AI/OCR 用量账本；`0004_ai_usage_quota_release.sql` 在供应商失败时释放预扣额度；`0005_platform_catalog_and_library.sql` 将平台目录、私有内容资产、地区访问策略、用户书库项目和服务端管理的权益分离。`content_assets` 的 R2/外部对象键永不授予浏览器读取权限；平台目录仅可读，权益不能由客户端创建或修改。迁移使用 `if not exists` 或 `drop policy if exists`，可安全地在已执行 0001 的项目上继续执行。

`0006_platform_content_operations.sql` 补充内容许可、来源记录和不可由浏览器读取或写入的运营审计日志。`0007_platform_delivery_resolution_and_staff_roles.sql` 增加仅服务端可见的运营角色表和 `resolve_platform_reader_delivery`：它即时检查已发布版本、私有 R2 主资产、来源 SHA-256、许可有效期、地区策略及所需的用户权益。`0008_metadata_sync_foundation.sql` 为用户阅读元数据同步增加设备注册、键级设置、变更日志、删除墓碑与阅读统计事件；`0009_controlled_metadata_sync_rpc.sql` 则只向 authenticated 的自有未撤销设备开放受限 metadata mutation/pull RPC，服务器分配 revision、保存幂等操作与墓碑，并拒绝文件字节、对象键、签名 URL 与正文定位字段。`0010_server_owned_account_roles.sql` 把产品账户的提升角色独立为仅服务端可读写的 `account_role_assignments`：普通用户没有角色记录，只有 `community_moderator`、`support_agent` 与 `platform_admin` 可通过 service-role-only 的 `set_server_account_role` 授予/撤销，并同时写入不可由浏览器读取的审计日志。不要把这些角色写入 `profiles`、`user_settings`、前端状态或 JWT claims；后台应在每次敏感请求时查询活跃服务端角色，从而让撤销立即生效。`0011_account_profile_and_avatar_foundation.sql` 为已有 `profiles` 增加昵称、简介、头像引用和默认关闭的 `is_public`，并建立私有 `profile-avatars` 桶：只允许本人 UUID 路径、JPEG/PNG/WebP、最大 5 MiB，保存头像引用前会校验该对象归属。认证邮箱不复制进资料表，员工角色也不写入其中。当前浏览器只把昵称和简介写入账户资料；头像选择仍是本机草稿，后续受控上传接入并完成真实双账号 RLS/对象策略验收前，不得承诺头像跨设备同步或公开主页。同步 migration 都不上传 EPUB/PDF，且旧浏览器全表 REST 同步仍关闭；在真实两设备 RLS 验收和账户隔离 outbox 上线前，不得把这些 migration 表示为可用跨设备恢复。平台版本发布必须经受控服务端调用 `publish_platform_catalog_edition`：它要求已核验的来源记录、与来源记录一致的 SHA-256、有效许可及至少一条对应许可的有效地区访问策略，并同步使该策略进入可解析状态。下架与许可撤销同样只可由受控服务端调用 `withdraw_platform_catalog_edition` 或 `revoke_platform_content_license`；撤销会立即收回对应访问策略。函数执行权仅授予 Supabase `service_role`，前端 anon/authenticated 会话没有目录、资产、许可、地区策略、员工角色或权益的写入权。

动态发布需要额外部署一个**不公开路由**的内容 resolver Worker，并通过 Cloudflare Service Binding 供主 Worker 调用。resolver 持有 `SUPABASE_URL`、`SUPABASE_ANON_KEY` 与 `SUPABASE_SERVICE_ROLE_KEY`，验证用户会话后以 service role 调用 `resolve_platform_reader_delivery`；主 Worker 只获得临时的内部对象键并使用自己的私有 `PLATFORM_CONTENT` R2 binding 读取正文。对象键不得进入响应、日志、KV、Cache 或异常文本。Service Binding、resolver 和生产切换尚未在仓库部署完成；在此之前，不能将 SQL 发布/下架操作用于真实线上正文。

### 首个合规内容来源接入清单

此清单仅建立受控的入库记录与私有对象引用，**不**允许在仓库、浏览器、CI 日志或测试中下载、上传或提交第三方正文。

1. 取得并归档可核验的许可或公共领域依据：记录许可方、协议/条款编号、允许的访问模式、有效期、地区范围和下架联系人；证据文件放入受限的私有存储，数据库仅保存不可公开的 `evidence_object_key`。
2. 建立 `content_licenses` 与 `content_source_records`：来源 URL 必须为 HTTPS，记录上游唯一 ID、获取时间、条款引用及**预期** SHA-256。先保持 `pending`，不得发布目录或交付正文。
3. 在隔离的运营环境验证来源身份、地域与许可条件，并复算文件 SHA-256；只有人工审核者确认后才将来源标为 `verified`、许可设为 `active`。审核者标识和时间必须留在记录中。
4. 将经核验的文件放入 Cloudflare R2 私有 bucket；使用随机/不可猜测对象键，阻止 public bucket、静态 URL、浏览器 CORS 直读和缓存。把对象键、媒体类型、字节数、实际 SHA-256、`source_record_id` 与 `license_id` 写入 `content_assets`。对象键、签名 URL 和许可证据永不进入目录 API、客户端日志或 Supabase 浏览器查询。
5. 对每一个可服务地区和访问模式建立 `access_policies`，将其 `license_id` 指向同一有效许可，并核对起止日期。没有适用地区策略时只可保留 `catalog_only`，不能开启正文交付。
6. 由受控后台以 service-role 调用 `publish_platform_catalog_edition`，而不是直接从浏览器或 SQL 控制台修改 `published_at`。检查 `platform_content_audit_log` 中的发布记录；失败应修正来源、哈希、许可或地区策略，而不是绕过校验。
7. 做 staging 验收：匿名/普通 authenticated 客户端不能查询对象键、许可证据、运营审计或创建权益；已撤销地区返回拒绝且不会暴露存储位置。确认 Worker 每次交付前重新做地区、许可有效期与权益判断。
8. 下架演练：调用 `withdraw_platform_catalog_edition`，验证目录与访问策略立即失效、审计记录含原因和操作者；许可整体失效时调用 `revoke_platform_content_license`。保留审计、工单和最小必要元数据，按许可条款删除或隔离私有对象。

上线前用一个测试账号验证：A 用户不能读取/修改 B 用户的版本、进度或摘录；匿名用户不能访问同步表；删除账号后级联删除其数据。没有真实 Supabase 凭据时，只能完成 SQL 静态检查和本地构建，不能声称 RLS 已在线验证。

## GitHub Actions

`.github/workflows/ci.yml` 对 Pull Request 和 `main` 推送执行类型检查、构建、Cloudflare Worker 契约与 Playwright Chromium 冒烟测试。CI 与发布 job 固定使用 Node.js 24；本项目的 PDF 与 Cloudflare 依赖已不支持 Node.js 20，不能为了消除提示降级运行时。提交的 `package-lock.json` 必须解析到公开可访问的 npm registry，不能写入个人或组织内部镜像域名，否则 GitHub Runner 会在 `npm ci` 阶段失败。Cloudflare 发布不在每次 push 时自动进行：项目所有者在 GitHub Actions 中通过 `workflow_dispatch` 选择 `staging` 或 `production`，并由对应 Environment 的 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 完成发布；production 应开启 required reviewers。

CI 还会检查登录/匿名试用契约、IndexedDB 与远端同步合并、翻译成功/失败与缓存、CORS、双译本低置信度回退，以及 migration 的 RLS 策略。质量 job 使用仅用于契约测试的假值，不连接真实 Supabase、AI 或 OCR 服务；Worker 部署由 Wrangler 在实际发布时校验 Cloudflare 凭据，工作流不输出 Token 值。

## 域名与安全头

将域名 DNS 指向 Cloudflare Worker 并开启 HTTPS 强制跳转。`worker/index.mjs` 为页面和 API 设定 CSP、禁止 iframe、严格 Referrer Policy 和 Permissions Policy；历史 `vercel.json` 不再是生产发布入口。若接入 API 网关，将其 HTTPS origin 加入 `connect-src`，不要放宽为 `*`。

上线前验证：

```sh
curl -sI https://staging.example.com/
curl -sI https://app.example.com/
```

确认响应包含 `content-security-policy`、`strict-transport-security`、`x-content-type-options`、`x-frame-options` 和 `referrer-policy`。HSTS 由托管平台开启，不能只依赖 Vite 开发服务器。

## 发布流程

1. 功能分支提交 PR；由主 Agent 审核公共契约、迁移、测试和文档后合并。不得把一般功能直接推送到 `main`。
2. PR 通过 typecheck、build 和 Playwright smoke。
3. 在 staging 导入 EPUB/PDF，阅读、划线、备份恢复，并验证翻译失败提示。
4. 检查 Sentry 无新增高优先级错误，确认数据库 migration 已按版本执行。
5. 合并到 `main`，在 GitHub Actions 的 production environment 点批准。
6. 发布后执行 `docs/runbook.md` 的冒烟与回滚检查；满足质量门槛后由主 Agent 创建版本标签与 GitHub Release，而不是仅以一次部署作为正式版本。

如果部署失败，先查看 Cloudflare Worker deployment logs 与对应 Environment 的权限范围；不要把 production Token 临时复制到 staging。修复后重新运行相同环境的手动发布，确认上一版本仍可访问再替换。
