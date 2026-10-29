# WorLibrary 并行开发分工方案

## 目标

将 WorLibrary 从当前的本地阅读器 MVP 推进到可公开部署的最小 2C 版本。所有 Agent 都应以小范围、可验证、可独立合并为原则，不直接修改其他 Agent 的模块。

当前基线：`main`，最新功能包括 EPUB/PDF 本地阅读、进度恢复、摘录空间、PDF/EPUB 选区摘录、书库搜索、本地备份恢复和翻译网关前端链路。

## 主分支治理与合并职责

`staging` 是唯一的共享集成基线，`main` 是仅包含已通过真实 staging 验收的发布基线。主 Agent 负责审核 PR、解决跨分支冲突、决定 `staging → main` 晋级，以及创建正式版本 Release；执行 Agent 只在功能分支或 worktree 中工作，不能直接向 `staging` 或 `main` 推送。完整分支、环境与 migration 门禁见 [release-governance.md](release-governance.md)。

每个 PR 至少应提供变更范围、用户影响、数据/迁移影响、验收步骤、已运行的测试和遗留风险。主 Agent 在合并前必须检查：

- 变更未越出该分支的职责，公共契约有明确说明；
- 必要文档、自动化测试与验收矩阵同步更新；
- `npm run typecheck`、`npm run build` 和相关 Playwright/质量测试通过；
- 涉及 Supabase migration、RLS、对象存储或 Worker 的改动已进行专项安全审查；
- 目标分支仍基于最新 `staging`（晋级 PR 则为最新 `main`），并已处理冲突。

当前仓库为 GitHub Free 私有仓库。GitHub 不允许在此组合下通过 Branch Protection API 为 `main` 启用强制保护（需要升级 GitHub Pro，或将仓库公开）。在获得平台级保护前，项目执行“软保护”：仅主 Agent 审核并合并 PR，任何直接推送必须是经用户明确授权的紧急修复，并在 PR/提交说明中记录原因。升级后应立即在 GitHub 为 `main` 启用“必须通过 PR、至少一名审核者、CI 必须通过、审批在新提交后失效、限制直接推送（包括管理员）”。

## 当前固定执行模型（长期有效）

以下分工是 WorLibrary 后续开发的默认工作方式，优先级高于本文历史任务的 Agent 编号描述。除非主 Agent 明确调整，每一轮都按此划分并行任务。

| 角色 | 固定分支 | 负责目标 | 不负责的内容 |
| --- | --- | --- | --- |
| Agent A | `codex/reader-multiedition` | EPUB/PDF 兼容、翻页与排版、目录、阅读位置、划线摘录、多译本与对照阅读 | 鉴权、云同步、AI 服务与部署配置 |
| Agent B | `codex/ai-gateway` | 划词翻译、解释、词汇/学习能力、AI 网关、缓存、限流、错误反馈 | 阅读器渲染、数据库迁移与身份体系 |
| Agent C | `codex/backend-auth-sync` | 账号、匿名试用、鉴权、权限、阅读数据同步、远端元数据与冲突处理 | 原始书籍文件上传、阅读器 UI、供应商 AI 密钥 |
| Agent D | `codex/deploy-quality` | QA 自动化、真实用户路径验收、竞品能力清单、问题复现回归、发布质量与部署检查 | 改写业务存储模型或阅读器核心逻辑 |
| 主 Agent | `main` | 任务拆分、公共契约、`storage` 变更审查、合并、全量回归、发布与推送 | 与执行 Agent 长期争抢同一模块 |

### 每轮固定流程

1. 主 Agent 先读取 `staging` 的现状、QA 结果和用户反馈，再向 A–D 下发互不冲突的任务。
2. A–D 只能在各自分支或 worktree 提交；不得直接更新 `staging` 或 `main`。
3. 每个 Agent 交付提交号、变更文件、已跑测试、遗留风险和建议的下一步。
4. 主 Agent 审查公共接口与迁移，依次集成，运行类型检查、生产构建和全量 Playwright/QA。
5. 仅主 Agent 在 CI 与代码审核通过后合并至 `staging`；真实 staging 验收通过后才合并 `staging → main`，并向用户汇报功能进度、已知限制和需要的外部配置。

### 调度原则

- 同一文件或同一公共契约只允许一个执行 Agent 在一个周期内主改；例如 `src/lib/storage.ts`、`src/App.tsx`、`package.json`、`vite.config.ts` 由主 Agent 协调。
- 用户报告的 P0 问题（导入、打开、翻页、数据丢失、权限越界）优先于新功能；主 Agent 可暂停其他任务进行串行修复。
- Agent D 的验收失败必须形成可复现测试或明确的人工复现步骤，之后才能关闭问题。
- 没有真实生产凭据时，Agent 可完成接口、模拟与回归；主 Agent 不会伪称生产服务已经上线。

## 分支规则

分支统一使用以下命名：

```text
codex/reader-multiedition
codex/backend-auth-sync
codex/ai-gateway
codex/deploy-quality
```

每个 Agent 必须从最新 `staging` 创建自己的分支或独立 worktree。禁止直接向 `staging` 或 `main` 推送。完成后提交目标为 `staging` 的 PR，由主 Agent 集成。

## Agent A：阅读器与多译本

分支：`codex/reader-multiedition`

### 负责范围

- EPUB/PDF 阅读器交互。
- `Work`、`Edition`、`Alignment` 前端数据模型。
- 多译本关联、切换和最小双栏对照阅读。
- 移动端阅读布局、字号和主题设置。
- EPUB/PDF 摘录体验和回链。

### 允许修改

```text
src/components/EpubReader.tsx
src/components/PdfReader.tsx
src/components/HighlightsView.tsx
src/components/*Reader*.tsx
src/lib/reader*.ts
src/lib/edition*.ts
src/reader-*.css
src/epub-*.css
src/pdf-*.css
```

### 不应修改

- `src/lib/storage.ts` 的数据库迁移和同步逻辑。
- 用户鉴权、AI 网关、部署配置。

如需新增数据字段，先在 PR 描述中提出接口，不直接改变公共存储结构。

### 验收标准

- 两个版本可以建立关联并切换。
- 进度按 Edition 独立保存。
- 双栏阅读在无法对齐时可以退化为独立滚动。
- 桌面和窄屏布局均可使用。
- 不破坏现有 EPUB/PDF 阅读和摘录。

## Agent C：鉴权、数据库与同步

分支：`codex/backend-auth-sync`

### 负责范围

- Supabase 项目初始化和数据库 migration。
- 匿名试用、邮箱魔法链接登录。
- 用户、设备、书籍元数据、阅读进度、摘录同步。
- RLS 策略、用户数据隔离、匿名身份升级。
- 本地数据与远程数据的首次同步和冲突策略。

### 允许新增

```text
supabase/migrations/*
supabase/seed.sql
src/lib/auth*.ts
src/lib/sync*.ts
src/lib/remote*.ts
src/components/Auth*.tsx
.env.example
```

### 数据边界

云端首期只同步：

- `Work / Edition` 元数据。
- 阅读进度和位置。
- 摘录、备注、颜色。
- 用户设置。

首期不上传原始书籍文件，原始文件仍留在本地。

### 验收标准

- 匿名用户可以使用本地阅读。
- 注册后可以恢复本地进度和摘录。
- 不同用户无法读取彼此数据。
- 重复同步具备幂等性。
- 删除账号可以删除云端个人数据。

## Agent B：AI 翻译与解释网关

分支：`codex/ai-gateway`

### 负责范围

- 实现 `/api/translate`。
- 实现 `/api/explain`。
- 服务端供应商适配器和密钥保护。
- 请求限流、额度账本、缓存、超时、重试和错误码。
- 前端 `src/lib/translation.ts` 与服务端协议对齐。

### API 契约

请求：

```json
{
  "text": "原文",
  "sourceLanguage": "auto",
  "targetLanguage": "zh-CN",
  "context": "可选上下文",
  "requestId": "客户端幂等 ID"
}
```

成功响应：

```json
{
  "translation": "译文",
  "provider": "provider-name",
  "model": "model-name",
  "cached": false
}
```

### 允许修改

```text
server/*
api/*
functions/*
src/lib/translation.ts
src/lib/explanation.ts
.env.example
```

### 验收标准

- 浏览器端不包含供应商密钥。
- 翻译和解释有统一错误码。
- 重复请求可以命中缓存。
- 超时、限流和供应商故障有用户可理解的提示。
- 记录脱敏日志，不记录完整原文。

## Agent D：部署、测试与质量

分支：`codex/deploy-quality`

### 负责范围

- GitHub Actions 检查、测试、预览部署和生产发布。
- staging / production 环境配置说明。
- 域名、HTTPS、CSP、CORS 和安全响应头。
- Playwright 冒烟测试和关键流程回归。
- Sentry 或同类错误监控。
- 备份、恢复、回滚和发布检查清单。

### 允许修改

```text
.github/workflows/*
tests/*
playwright.config.*
docs/deployment*.md
docs/runbook*.md
vite.config.ts
public/*
```

### 验收标准

- PR 自动运行类型检查、构建和冒烟测试。
- staging 可部署并可访问。
- production 发布有人工确认和回滚路径。
- 能验证导入、阅读、摘录、备份恢复和翻译失败场景。
- 关键错误可以追踪但不泄露书籍原文。

## 主 Agent：集成与公共契约

主 Agent 不与上述分支争抢同一模块，主要负责：

- 维护 `main` 和版本发布。
- 审核数据库和 API 契约。
- 维护 `src/lib/storage.ts` 的迁移版本。
- 解决跨分支冲突。
- 运行全量类型检查、构建和端到端测试。
- 更新 `docs/technical-architecture.md` 和 `docs/development-roadmap.md`。

公共文件发生变化前，Agent 必须先在 PR 中说明原因：

```text
src/lib/storage.ts
src/App.tsx
package.json
package-lock.json
vite.config.ts
```

## 推荐并行顺序

### 第一批：可以立即并行

1. Agent A：设计 Work/Edition/Alignment 类型和最小双栏原型。
2. Agent C：Supabase migration、Auth 和 RLS 原型。
3. Agent B：翻译网关和 explain API。
4. Agent D：CI、Playwright 冒烟测试和 staging 文档。

### 第二批：集成

1. 主 Agent 固化公共数据模型。
2. 合并 Agent C 的数据库 migration。
3. 合并 Agent B 的 API 契约和前端适配。
4. 合并 Agent A 的多译本界面。
5. 合并 Agent D 的部署和测试流水线。

### 第三批：发布前验收

```text
导入 EPUB/PDF
 → 本地阅读
 → 选择文本
 → 翻译/解释
 → 保存摘录
 → 注册账号
 → 同步进度和摘录
 → 另一设备恢复
 → staging 冒烟测试
 → production 发布
```

## Agent 新窗口启动模板

将下面内容连同本文件路径发送给新 Agent：

```text
你负责 WorLibrary 的 [分支名]。
请先阅读：
- docs/parallel-development-plan.md
- docs/development-roadmap.md
- docs/technical-architecture.md

只修改你负责范围内的文件，从最新 main 创建分支：
[分支名]

完成后必须：
1. 运行类型检查和构建；
2. 运行与你模块相关的测试；
3. 更新必要文档；
4. 提供提交信息、变更文件和剩余风险；
5. 不直接推送 main。
```

## 合并规则

- 小提交优先，一个提交只解决一个主题。
- 每个 PR 必须包含验收步骤。
- 数据库 migration 必须可重复执行，禁止手工改生产库。
- API 先合约后实现，前后端不得各自发明字段。
- 合并顺序优先：数据模型 → 后端接口 → 前端界面 → 部署测试。
- 任一 Agent 发现公共契约需要变化，应停止扩大修改范围并记录到 PR。

## 版本 Release 规则

产品不以任意一次 `main` 合并作为对外上线。主 Agent 仅在一个可复现的发布候选满足以下条件后创建语义化版本标签（例如 `v0.2.0`）和 GitHub Release：

1. 所有待发布 PR 已审核并合入 `main`，且变更日志与已知限制已更新；
2. `npm run quality` 的发布报告为可发布状态，关键回归、部署前检查和相关迁移已完成；
3. staging 已按 `docs/runbook.md` 完成真实用户路径验收；
4. production 发布经 GitHub Environment 人工批准，发布后冒烟与回滚检查完成。

Release 说明必须包含用户可见功能、兼容性/迁移提示、已知限制、回滚版本和部署时间。未经上述门槛，不创建“正式上线”Release。
