# WorLibrary 部署指南

## 环境

| 环境 | 用途 | 来源 | 必需检查 |
| --- | --- | --- | --- |
| local | 开发与离线阅读验证 | 本地 Vite | `npm run typecheck`、`npm run build` |
| staging | 每个 PR 的预览环境 | GitHub Actions + Vercel Preview | 冒烟测试、关键流程手测 |
| production | 对外服务 | `main` 合并后人工批准的 Vercel Production | 发布清单、回滚路径、监控 |

生产和 staging 的平台密钥只放在部署平台的环境变量中，不提交 `.env`。AI/OCR 密钥只能由 API 网关使用；浏览器构建产物不得包含供应商密钥。

## GitHub Actions

`.github/workflows/ci.yml` 对 Pull Request 和 `main` 推送执行类型检查、构建和 Playwright Chromium 冒烟测试。预览发布需要在 GitHub 的 `staging` environment 配置 `VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`；生产发布使用 `production` environment，并开启 required reviewers 作为人工确认。

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
