# WorLibrary 发布与故障处理手册

## 发布前检查清单

- [ ] 本地与 CI 均使用 Node.js 24（最低兼容版本为 22.13）；若 `npm ci` 出现 `EBADENGINE` 或 `Exit handler never called`，先检查 Node 版本，不能继续把后续 typecheck/build/Playwright 的连带失败当作产品问题。
- [ ] 若启用登录用户的阅读数据同步，已依序执行 `0008_metadata_sync_foundation.sql` 与 `0009_controlled_metadata_sync_rpc.sql`。它们只建立受控元数据 mutation/pull、设备/墓碑/日志基础，不上传 EPUB/PDF，也不代表客户端同步已上线。
- [ ] `npm ci && npm run typecheck && npm run build` 全部通过。
- [ ] `npm run quality` 生成 `test-results/release-report.json`；只有 `releaseReady: true` 才可发布。`blocked` 需要补齐部署配置，`failed` 需要修复代码或测试。
- [ ] 在 Cloudflare Dashboard 核对 Preview/Production 使用不同的部署环境；CI Token 仅授予该项目所需的 Workers 编辑权限，绝不复制生产 Token 到预览环境或前端变量。
- [ ] 若本次启用认证/同步、AI 或 OCR，再执行 `npm run validate:env -- --production --json`。`warnings` 表示特意关闭的可选能力；`missing` 或 `invalid` 表示不能启用该能力。记录变量名，不记录或截图变量值。
- [ ] 确认 staging/production 的 `VITE_SUPABASE_URL`、`SUPABASE_URL`、`AI_BASE_URL` 与 `OCR_BASE_URL` 都是 HTTPS；HTTP 地址只允许本地开发。
- [ ] 本地验证真实翻译时，使用被 Git 忽略的 `.dev.vars` 提供 `AI_API_KEY` 与 `AI_MODEL`，并通过 `npm run cf:dev` 启动 Worker；该命令会先构建当前前端，避免 `dist/` 过期。不要用 `npm run dev` 或直接运行 `wrangler dev`，也不要把密钥写到命令行、`VITE_*` 变量、截图或提交中。
- [ ] Playwright 冒烟覆盖书库搜索、阅读/对照、AI 解释入口和备份控件。
- [ ] staging 可访问，HTTPS 和安全响应头齐全。
- [ ] 用 `/api/catalog?q=world%20classics` 验证世界书库能返回来源标识；临时断开任一上游时确认不会永久加载，也不会缓存失败响应。手动 Cloudflare 部署会从 GitHub Runner 自动执行同一条真实目录探针；其失败代表 Worker 或上游链路问题，而不是发布者本地 DNS 问题。
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
- [ ] 在两个独立浏览器 profile 和两个测试账号上完成真实 Supabase 验收：匿名试用不创建同步队列；稳定账号只能操作自己的未撤销设备；离线重放的 mutation 幂等；删除墓碑不会被旧设备复活；远端仅元数据条目明确标为需重新导入且不能打开本地阅读器。没有这项验收，保持客户端同步入口关闭。
- [ ] 若本次首次发布平台自有/获授权内容，已执行 `0006_platform_content_operations.sql` 与 `0007_platform_delivery_resolution_and_staff_roles.sql`，并由受控后台（不是浏览器）完成许可、来源、SHA-256、私有 R2 对象、地区策略和发布审计的完整接入清单；详见 `docs/deployment.md` 的“首个合规内容来源接入清单”。
- [ ] 动态交付必须先部署内部内容 resolver，并由 Service Binding 连接到主 Worker；resolver 独占 Supabase service-role key，主 Worker 仅保留私有 `PLATFORM_CONTENT` R2 binding。没有完成此步骤时，不得声称数据库发布、下架或许可撤销已经控制线上正文。
- [ ] 验证普通 anon/authenticated 会话无法读取 `content_assets.object_key`、许可证据、来源审核记录或运营审计，也不能写入平台目录、资产、访问策略和权益；只有 service-role 可执行受控发布、下架与许可撤销 RPC。
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
