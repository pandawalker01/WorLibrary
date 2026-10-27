# WorLibrary 发布与故障处理手册

## 本轮内测 MVP 的发布模式

本轮只启用本地阅读、合规目录搜索、邮箱魔法链接、Worker 翻译和经过真实验收的**元数据**同步。它不启用用户原书云备份、恢复码、Google/Apple 登录、匿名迁移、平台自有正文的运营交付、下载、支付或原生客户端。未启用的平台内容变量、私有用户备份桶和对应运营流程不是本轮部署前置条件；不得为了“演示完整产品”填入虚构许可、对象键或授权策略。

内测同步上线前，必须执行 0008/0009 migration，并在两个独立浏览器 profile 中实际验证同一稳定邮箱账户的进度、摘录、书架元数据和必要偏好同步；远端本地书必须显示“需重新导入原书”且不可打开。匿名试用不得创建队列。任一项未通过时，保持客户端同步入口关闭，仍可发布不含同步的本地阅读内测。

## 发布前检查清单

- [ ] 本地与 CI 均使用 Node.js 24（最低兼容版本为 22.13）；若 `npm ci` 出现 `EBADENGINE` 或 `Exit handler never called`，先检查 Node 版本，不能继续把后续 typecheck/build/Playwright 的连带失败当作产品问题。
- [ ] 若启用登录用户的内测元数据同步，已依序执行 `0008_metadata_sync_foundation.sql`、`0009_controlled_metadata_sync_rpc.sql` 与 `0012_private_highlight_sync_rpc.sql`，且客户端页面已实际接入账户隔离 outbox、顺序 flush 与 revision pull；摘录必须经专用 RPC 以同账号、未撤销设备同步 `edition_id`、选区文本、位置、笔记、颜色与是否显示高亮。它们不上传 EPUB/PDF、封面二进制、对象键、文件元数据或 URL。第二设备中的本地书必须要求重新导入原书，不能打开。
- [ ] `npm ci && npm run typecheck && npm run build` 全部通过。
- [ ] `npm run quality` 生成 `test-results/release-report.json`；只有 `releaseReady: true` 才可发布。`blocked` 需要补齐部署配置，`failed` 需要修复代码或测试。
- [ ] 在 Cloudflare Dashboard 核对 Preview/Production 使用不同的部署环境；CI Token 仅授予该项目所需的 Workers 编辑权限，绝不复制生产 Token 到预览环境或前端变量。
- [ ] 若本次启用认证/同步、AI 或 OCR，再执行 `npm run validate:env -- --production --json`。`warnings` 表示特意关闭的可选能力；`missing` 或 `invalid` 表示不能启用该能力。记录变量名，不记录或截图变量值。
- [ ] 确认 staging/production 的 `VITE_SUPABASE_URL`、`SUPABASE_URL`、`AI_BASE_URL` 与 `OCR_BASE_URL` 都是 HTTPS；HTTP 地址只允许本地开发。
- [ ] 本地验证真实翻译时，使用被 Git 忽略的 `.dev.vars` 提供 `AI_API_KEY` 与 `AI_MODEL`，并通过 `npm run cf:dev` 启动 Worker；该命令会先构建当前前端，避免 `dist/` 过期。不要用 `npm run dev` 或直接运行 `wrangler dev`，也不要把密钥写到命令行、`VITE_*` 变量、截图或提交中。
- [ ] Playwright 冒烟覆盖书库搜索、阅读/对照、AI 解释入口和备份控件。
- [ ] staging 可访问，HTTPS 和安全响应头齐全。
- [ ] 用 `/api/catalog?q=world%20classics` 验证世界书库能返回来源标识；临时断开任一上游时确认不会永久加载，也不会缓存失败响应。手动 Cloudflare 部署会从 GitHub Runner 自动执行同一条真实目录探针；其失败代表 Worker 或上游链路问题，而不是发布者本地 DNS 问题。
- [ ] 若启用 `PLATFORM_CATALOG_JSON`，逐条核对其 `editionId` 与 `PLATFORM_CONTENT_ACCESS_JSON` 有一一对应的已审核策略，并确认目录响应中没有对象键、文件 URL、签名 URL、正文或授权信息。没有匹配策略的条目必须不出现在世界书库；不要把上游网页的“免费”状态直接抄入平台目录。
- [ ] 用 `GET /api/translation-status` 确认返回 `configured: true`、`Cache-Control: no-store` 和请求 ID；该探针不发送选区文本、不调用模型。若为 `false`，先在 Cloudflare Worker Secret 中补齐 `AI_API_KEY` 并重新部署，绝不将它改为 `VITE_AI_API_KEY`。
- [ ] 仅在受控内测环境使用无版权短句，完成一次 EPUB/PDF 划词翻译与解释；确认成功和错误响应都不被缓存。公开启用前在 Cloudflare 配置全局 WAF/Rate Limiting，并完成认证与持久化额度账本验收；Worker 的本地边缘限流不足以承担公开付费 API 的成本防护。
- [ ] 部署 action 完成后，`npm run verify:deployment -- https://<当前部署域名>` 通过；它同时验证 `/api/health`、`/api/catalog`、request id 回显、对应的缓存策略，以及首页的 CSP/HSTS/反 MIME 嗅探/反 iframe/Referrer Policy。
- [ ] 在 staging 安装 WorLibrary；首次联网打开后断网刷新，确认应用壳可打开、离线提示可见、此前导入的 EPUB/PDF 仍可打开。
- [ ] 确认 DevTools/Application 中 Service Worker 的 scope 为 `/`，且 Cache Storage 中没有 API 响应、Supabase 响应或 `.epub` / `.pdf` 文件。
- [ ] 用测试文件验证 EPUB/PDF 导入、阅读位置、摘录和备份恢复。
- [ ] 模拟翻译网关超时/限流，页面保持可阅读并展示用户可理解的提示。
- [ ] Sentry release 已创建，source map 仅上传到 Sentry，不公开发布。
- [ ] 确认最近一次数据库备份时间、恢复负责人和回滚版本。
- [ ] migration 文件名连续且只向前执行；RLS policy 检查通过。
- [ ] 登录匿名试用/魔法链接、首次同步和翻译成功/失败均有可追踪 request id。
- [ ] 在两个独立浏览器 profile 和两个测试账号上完成真实 Supabase 验收：匿名试用不创建同步队列；稳定账号只能操作自己的未撤销设备；登出或账户切换会取消旧账户的待同步工作；未知/不安全 payload 或 RPC 错误不推进 pull cursor；离线重放的 mutation 幂等；删除墓碑不会被旧设备复活；远端仅元数据条目明确标为需重新导入且不能打开本地阅读器。没有这项验收，保持客户端同步入口关闭，状态文案不得使用“已同步”或“跨设备恢复”。
- [ ] 若本次首次发布平台自有/获授权内容，已执行 `0006_platform_content_operations.sql` 与 `0007_platform_delivery_resolution_and_staff_roles.sql`，并由受控后台（不是浏览器）完成许可、来源、SHA-256、私有 R2 对象、地区策略和发布审计的完整接入清单；详见 `docs/deployment.md` 的“首个合规内容来源接入清单”。
- [ ] 若本次启用社区审核、客服支持或平台管理能力，已执行 `0010_server_owned_account_roles.sql`。普通用户没有提升角色记录；`community_moderator`、`support_agent` 与 `platform_admin` 只能由受控 service-role 调用 `set_server_account_role` 授予或撤销，并必须填写内部操作者/工单引用。不得通过 `profiles`、`user_settings`、前端状态或 JWT claims 配置角色。
- [ ] 若启用账户资料云端保存，已在目标 Supabase 按顺序执行 `0011_account_profile_and_avatar_foundation.sql` 与 `0013_public_profile_projection.sql`。用两个真实账号验证：只能编辑自己的 `profiles` 行；公开查询只可读取 `public_profiles` 明确授权的 `public_id`、昵称、简介、头像存在状态与更新时间，不能读取 `owner_id`、邮箱、设备、私有书架、阅读位置、摘录、原书、角色或私有头像路径；关闭 `is_public` 后投影立即消失。`profile-avatars` 必须保持私有，只接受本人 UUID 路径下不超过 5 MiB 的 JPEG/PNG/WebP；在按 `public_id` 校验的媒体网关完成前，不得把私有 Storage 路径作为公开头像 URL。
- [ ] 动态交付必须先部署内部内容 resolver，并由 Service Binding 连接到主 Worker；resolver 独占 Supabase service-role key，主 Worker 仅保留私有 `PLATFORM_CONTENT` R2 binding。没有完成此步骤时，不得声称数据库发布、下架或许可撤销已经控制线上正文。
- [ ] 验证普通 anon/authenticated 会话无法读取 `content_assets.object_key`、许可证据、来源审核记录或运营审计，也不能写入平台目录、资产、访问策略和权益；只有 service-role 可执行受控发布、下架与许可撤销 RPC。
- [ ] 验证普通 anon/authenticated 会话无法读取、枚举、插入、更新或删除 `account_role_assignments` 和 `account_role_audit_log`，也无法执行 `set_server_account_role`；角色撤销后，下一次后台服务端鉴权立即拒绝相应能力。
- [ ] 若启用了平台正文交付，使用两份获授权的测试 EPUB/PDF 验证平台阅读器可在当前会话中翻页；网络面板只应看到带 Authorization 的无缓存 `/api/reader/content` 请求，不能出现下载、对象 URL、IndexedDB/OPFS 正文记录或可复制的对象键。撤销授权后必须立即失败关闭。

## 发布后检查

打开生产站点执行：导入一本测试 EPUB 或文本 PDF → 打开阅读器 → 选择文本并打开解释 → 导出阅读数据 → 清空测试数据并导入备份。不要使用包含版权内容的真实书籍或完整原文作为测试样本。检查浏览器控制台无 CSP 错误，Sentry 没有新增未处理异常。

PWA 专项验证：联网首次打开并等待 Service Worker 激活；导入测试 EPUB 后，在浏览器 DevTools 的 Network 面板切换 Offline，再刷新页面并重新打开该书。应用应显示离线说明且本地书籍可读；AI、OCR 与同步应保持不可用/待恢复。重新联网后确认页面不丢失本地书籍，并点击更新提示（若出现）完成下一次刷新。不要用 `file://` 验证 PWA，必须使用 HTTPS 或 localhost。

先验证健康探针：

```sh
curl -fsS -D - https://app.example.com/api/health
```

应返回 HTTP 200、`status: "ok"` 和 `x-request-id`。若健康探针失败，先保留响应头中的 request id，再检查部署日志；不要为了让探针变绿而暴露 API 密钥或放宽 CORS。

自动化检查失败时先区分失败位置：`/api/health` 或 `/api/translation-status` 的状态、`cache-control` 或 request id 异常通常意味着 Worker 路由或部署配置问题；若翻译状态是 `configured: false`，检查 Cloudflare Environment 的 `AI_API_KEY` Secret 与 `AI_MODEL` Variable 是否已为当前发布生效，而不是把密钥改为 `VITE_*` 变量。翻译或解释响应的 `Cache-Control` 不是 `no-store` 时，停止发布并检查共享网关的响应头：选区文本和错误信息不能进入浏览器或 CDN 的共享缓存。首页安全头缺失通常意味着 Worker 未应用对应响应头。HTTPS/HSTS 缺失时不得通过降级为 HTTP 或删除该检查发布。

平台内容异常（许可到期、地区误开、权利人通知或哈希不一致）属于内容安全事件：先停止对应交付，不要通过临时公开 R2、扩大 CORS、修改浏览器缓存或删除审计记录来“修复”。对单版本使用受控服务端 `withdraw_platform_catalog_edition`；对整份许可使用 `revoke_platform_content_license`，两者都应记录操作者和原因。随后保存 request id、许可/来源记录 ID 与审计时间，核对目录不再展示、访问策略已收回，再按许可证条款处理私有对象。动态 resolver 投产后，再以已撤销的版本复验下一次 `/api/reader/content` 已失败关闭。正文、对象键、签名 URL、合同证据和完整权利人通知不得贴入工单、聊天或 Sentry。

## 回滚

前端回滚优先使用托管平台上一份已验证的上一版部署，避免重新构建得到不同依赖：

1. 在生产平台选择上一份绿色 deployment，执行 Promote/Rollback。
2. 验证首页、阅读器、备份恢复和 API 错误提示。
3. 保留失败 deployment、request id 和 Sentry issue，便于复盘。
4. 若是数据库问题，不回滚已执行的 migration；创建向前修复 migration，并先在 staging 恢复演练。

若发布 job 失败：保留 workflow run、deployment id 和 request id，先判断是构建、环境变量、CSP/CORS 还是 API 依赖问题。构建失败不需要回滚线上版本；部署成功但健康检查失败时，立即 Promote 上一个绿色 deployment，并在 15 分钟内重新执行首页、登录、同步、翻译和双译本对照检查。CSP/CORS 变更必须先在 staging 验证，不能通过临时放开 `*` 来恢复服务。

## 监控与隐私

Sentry 仅接收错误类型、路由、版本和 request id；过滤选区文本、书籍内容、Authorization header 和 AI 密钥。告警阈值建议为 5 分钟内同类错误超过 5 次，或生产可用性探测连续失败 2 次。备份至少保留最近 7 天并每月做一次恢复演练；恢复文件应存放在受限环境，演练后删除临时副本。

## 个人云书库 P0 部署与回滚

先按序执行 `0014_private_user_file_library.sql` 和 `0015_private_user_file_gateway.sql`，创建非公开 R2 bucket `worlibrary-user-backups` 并绑定为 `USER_BACKUPS`。将 `SUPABASE_SERVICE_ROLE_KEY` 只作为 Worker Secret 配置，同时配置 `SUPABASE_URL`、`SUPABASE_ANON_KEY`；不得写入 `.env`、前端变量、日志或 CI 输出。staging 必须用两个真实账户验证隔离、中断续传、私有 bucket 和删除 tombstone。

回滚只回滚 Worker 路由/版本，保留 migration、manifest 与 tombstone，避免旧设备复活已删文件。不要删除表、桶或 tombstone；先完成所有 `uploading`/`deleting` 回收后，才能计划向前修复 migration。
