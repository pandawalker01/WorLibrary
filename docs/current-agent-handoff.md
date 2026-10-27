# WorLibrary 当前交接记录

> 本文档用于新设备、新会话和新 Agent 恢复项目上下文。以仓库代码、迁移和 PR 实际状态为准，不以聊天记录中的未落地承诺为准。

## 产品定位

WorLibrary 是世界图书馆阅读器：让用户发现世界各地的作品和译本，在 WorLibrary 内阅读，并以自己的语言理解内容。长期目标是建立覆盖全球作品的 `Work → Edition → Access` 目录，同时严格区分书目、合法在线阅读、可下载版本和用户私有文件。

## 当前主线状态

- `main` 受保护，所有变更通过 PR 进入。
- PR #1 已合并：私有头像上传基础。
- PR #2、#3、#4 已合并：公开资料隐私边界、个人云书库文件网关、账户同步重试与隔离已进入 `main`。
- 不得把 CI 通过等同于真实 Supabase/R2 验收完成。

## 已完成能力

- 本地 EPUB/PDF 导入、离线阅读、分页、目录、进度恢复。
- 划词翻译、解释、摘录、笔记和显式颜色标注。
- 邮箱魔法链接登录和账户中心基础。
- Supabase 账户隔离、受控 metadata RPC、outbox、revision、删除墓碑基础。
- 私有头像存储基础和公开资料最小投影设计。
- 世界书库来源适配、来源标注、联网收藏和访问状态区分。
- Cloudflare Worker 同域 API、AI/目录入口和安全响应头基础。

## 当前 P0 待办

1. 在 PR #5 分支 `codex/sync-real-acceptance` 完成元数据同步真实 Supabase 双 Profile/双账户验收。2026-10-28 staging 账户认证、设备注册和 change-feed 拉取已成功；edition upsert 发现 SQLSTATE `20000` / `case not found`，需先在 staging 应用新 migration `0016_metadata_sync_scalar_payload_guard.sql` 再继续。不得把本地自动化当作线上 RLS 证据。
2. 用两个独立浏览器 Profile 验证同账户恢复、跨账户隔离、匿名限制、断网重放、账户切换、cursor 持久化和删除墓碑。
3. 发现同步代码问题时，先添加回归测试并修复，再复测真实 Supabase。
4. 完成个人云书库后续真实 Supabase/R2 验收及新设备恢复，该功能由 Agent A 负责。
5. 在真实验收通过前，产品文案只能说“同步预览”或“需验收”，不能承诺云端备份已完成。

## Agent 分工

### Agent A：个人云书库

负责 PR #3：manifest、私有对象存储、Worker 文件网关、分块上传、配额、删除清理、新设备恢复。不得修改社区、管理员后台、公开主页或平台版权交付。

### Agent B：同步与真实验收

负责已合并的 PR #4 同步实现及 PR #5 staging 真实验收：书架元数据、阅读进度、摘录/笔记/颜色、阅读偏好、outbox、revision、重试、账户切换、RLS 和双浏览器验收。不得负责原书上传或对象存储。

### 主 Agent

负责冲突解决、代码审查、迁移顺序审查、隐私/RLS/版权边界、完整质量门和最终合并。任何 Agent 不得直接合并 `main`。

## 数据和安全边界

- 原书 EPUB/PDF、封面二进制、对象键、长期 URL 和整本正文不能进入 metadata RPC 或公开表。
- 公开资料默认关闭；公开投影不包含邮箱、认证 ID、书架、进度、摘录、角色或私有头像路径。
- 用户自导入内容默认属于用户私有云书库，不能自动变成平台可分发内容。
- 平台内容必须有明确许可证或公共领域依据，才能提供 WorLibrary 内阅读或下载。
- 不提交 `.env`、密钥、service role key、JWT secret、`.wrangler/`。

## 数据库迁移顺序

迁移必须按仓库编号顺序执行。当前相关迁移包括：

- `0011_account_profile_and_avatar_foundation.sql`
- `0012_private_highlight_sync_rpc.sql`
- `0013_public_profile_projection.sql`
- `0014_private_user_file_library.sql`
- `0015_private_user_file_gateway.sql`

执行生产迁移前必须检查目标项目已有表、策略和函数，不能盲目重复执行或修改已执行迁移文件。

## 新会话启动步骤

```text
请先阅读 AGENTS.md、docs/current-agent-handoff.md、docs/project-guide.md、docs/development-roadmap.md、docs/user-data-sync-architecture.md、docs/runbook.md 和 docs/acceptance-matrix.md。
先检查 git status、当前分支、所有开放 PR、CI 状态和合并冲突，再开始工作。不要直接修改或合并 main。
```

## 验收命令

```bash
npm run typecheck
npm run build
npm run test:bundle
npm run quality
git diff --check
```

## 下一步顺序

先审核 PR #2、#3、#4 的差异和迁移；再在真实 Supabase/R2 环境完成双账户验收；验收通过后按依赖顺序合并；最后继续实现作品级世界书库搜索、社区和平台运营能力。
