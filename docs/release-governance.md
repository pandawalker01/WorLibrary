# WorLibrary 分支、环境与发布门禁

## 目的

`main` 必须始终代表可发布到 Production 的版本。功能代码、数据库迁移和用户可见行为必须先在独立的 staging 环境完成真实验收，才可晋级到 `main`。Git 分支与 Supabase/Cloudflare 环境是两层不同的隔离，缺一不可。

## 固定分支流

```text
codex/<feature> → PR → staging → staging 环境验收 → PR → main → Production 发布
```

- `codex/<feature>`：每个 Agent 的独立 worktree 分支；禁止直接推送 `staging` 或 `main`。
- `staging`：受保护的共享集成分支。所有功能 PR 的默认目标。合并后只允许部署到 staging 环境。
- `main`：受保护的发布分支。只接受已通过 staging 真实验收的 `staging → main` 晋级 PR。

一个 PR 只解决一个可审计目标。修复 staging 验收缺陷时，必须从最新 `staging` 建立新的独立 `codex/` 分支并重新走该流程。

## 环境绑定

| Git ref | 允许部署环境 | Supabase 项目 | 目的 |
| --- | --- | --- | --- |
| `codex/*` | 不得部署共享 staging/Production | 无 | 本地与 CI 验证；可选无状态 Preview |
| `staging` | 仅 `staging` | `lkibueigjufvrwdqdshk` | 集成、迁移、RLS、对象存储与真实验收 |
| `main` | 仅 `production` | `bvnykmaczjpsuifyzkyt` | 已批准版本的正式发布 |

CI 的手动部署 job 必须拒绝 `staging` 以外的 ref 部署 staging，以及 `main` 以外的 ref 部署 Production。GitHub Environment 中的 staging 与 production Secrets 必须独立保存，且 production 必须启用 required reviewers。

## 数据库迁移门禁

1. migration 只允许新增向前版本；不得重写已在任一远端应用的历史 migration。
2. 主 Agent 审核 migration 顺序、RLS、幂等、对象访问与回滚/前向修复影响。
3. migration 合入 `staging` 后，只能在明确链接到 staging project ref 的受控终端或发布 workflow 中执行；先核对远端 migration 清单，再执行并复核。
4. 两账户/两 Profile 的真实验收通过并留存脱敏证据后，才允许 `staging → main`。
5. Production 只应用已在 staging 验证的同一 migration 集合；数据库故障只用新的向前修复 migration，禁止回滚历史 SQL。

不在 PR、日志、截图或聊天中记录密钥、密码、邮箱、对象 URL、令牌或完整请求 payload。

## 晋级与回滚

`staging → main` PR 必须包含：已部署 commit、staging migration 版本、CI 结果、真实验收矩阵链接、未验证项与回滚/前向修复说明。主 Agent 复核后才可合并。

Production 发布由 `main` 的手动 workflow 触发，并经 GitHub Environment 批准。发布后运行部署 smoke test；应用故障回滚到上一绿色部署，数据库问题使用前向 migration 修复并先在 staging 演练。

## 仓库管理员一次性设置清单

1. 创建 `staging` 分支，以当前 `main` 为基线。
2. 为 `staging` 和 `main` 启用保护：仅 PR 合并、必需 `quality` 检查、审批在新提交后失效、限制直接推送。
3. 创建 GitHub Environments：`staging`、`production`；production 启用 required reviewers。
4. 为两个 Environment 分别配置最小权限部署凭据；不得共用或复制 production Secret 到 staging。
5. 将 Cloudflare staging 与 production 绑定到不同站点/Worker 名称或受控域名，并确认 staging 客户端只指向 staging Supabase。

若 GitHub 计划限制无法在当前私有仓库套餐上强制保护，继续采用软保护：只有主 Agent 合并，所有直接推送须经用户明确授权并留下原因；升级套餐后立即启用上述规则。
