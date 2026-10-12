# WorLibrary 发布与故障处理手册

## 发布前检查清单

- [ ] `npm ci && npm run typecheck && npm run build` 全部通过。
- [ ] `npm run quality` 生成 `test-results/release-report.json`；只有 `releaseReady: true` 才可发布。`blocked` 需要补齐部署配置，`failed` 需要修复代码或测试。
- [ ] Playwright 冒烟覆盖书库搜索、阅读/对照、AI 解释入口和备份控件。
- [ ] staging 可访问，HTTPS 和安全响应头齐全。
- [ ] 在 staging 安装 WorLibrary；首次联网打开后断网刷新，确认应用壳可打开、离线提示可见、此前导入的 EPUB/PDF 仍可打开。
- [ ] 确认 DevTools/Application 中 Service Worker 的 scope 为 `/`，且 Cache Storage 中没有 API 响应、Supabase 响应或 `.epub` / `.pdf` 文件。
- [ ] 用测试文件验证 EPUB/PDF 导入、阅读位置、摘录和备份恢复。
- [ ] 模拟翻译网关超时/限流，页面保持可阅读并展示用户可理解的提示。
- [ ] Sentry release 已创建，source map 仅上传到 Sentry，不公开发布。
- [ ] 确认最近一次数据库备份时间、恢复负责人和回滚版本。
- [ ] migration 文件名连续且只向前执行；RLS policy 检查通过。
- [ ] 登录匿名试用/魔法链接、首次同步和翻译成功/失败均有可追踪 request id。

## 发布后检查

打开生产站点执行：导入一本测试 EPUB 或文本 PDF → 打开阅读器 → 选择文本并打开解释 → 导出阅读数据 → 清空测试数据并导入备份。不要使用包含版权内容的真实书籍或完整原文作为测试样本。检查浏览器控制台无 CSP 错误，Sentry 没有新增未处理异常。

PWA 专项验证：联网首次打开并等待 Service Worker 激活；导入测试 EPUB 后，在浏览器 DevTools 的 Network 面板切换 Offline，再刷新页面并重新打开该书。应用应显示离线说明且本地书籍可读；AI、OCR 与同步应保持不可用/待恢复。重新联网后确认页面不丢失本地书籍，并点击更新提示（若出现）完成下一次刷新。不要用 `file://` 验证 PWA，必须使用 HTTPS 或 localhost。

先验证健康探针：

```sh
curl -fsS -D - https://app.example.com/api/health
```

应返回 HTTP 200、`status: "ok"` 和 `x-request-id`。若健康探针失败，先保留响应头中的 request id，再检查部署日志；不要为了让探针变绿而暴露 API 密钥或放宽 CORS。

## 回滚

前端回滚优先使用托管平台上一份已验证的上一版部署，避免重新构建得到不同依赖：

1. 在生产平台选择上一份绿色 deployment，执行 Promote/Rollback。
2. 验证首页、阅读器、备份恢复和 API 错误提示。
3. 保留失败 deployment、request id 和 Sentry issue，便于复盘。
4. 若是数据库问题，不回滚已执行的 migration；创建向前修复 migration，并先在 staging 恢复演练。

若发布 job 失败：保留 workflow run、deployment id 和 request id，先判断是构建、环境变量、CSP/CORS 还是 API 依赖问题。构建失败不需要回滚线上版本；部署成功但健康检查失败时，立即 Promote 上一个绿色 deployment，并在 15 分钟内重新执行首页、登录、同步、翻译和双译本对照检查。CSP/CORS 变更必须先在 staging 验证，不能通过临时放开 `*` 来恢复服务。

## 监控与隐私

Sentry 仅接收错误类型、路由、版本和 request id；过滤选区文本、书籍内容、Authorization header 和 AI 密钥。告警阈值建议为 5 分钟内同类错误超过 5 次，或生产可用性探测连续失败 2 次。备份至少保留最近 7 天并每月做一次恢复演练；恢复文件应存放在受限环境，演练后删除临时副本。
