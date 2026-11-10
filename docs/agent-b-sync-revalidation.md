# Agent B 同步复验工作记录

## 2026-11-11 基线审计

- 已通过 Git HTTPS fetch 核实 staging：`f3a7a56dc2b20ea257256a19f8536fd4da1aa74c`，CI run `40869346646` 为 success。
- 独立分支：`codex/agent-b-sync-revalidation`。PR #5 已合并，不再作为开放协作入口；PR #7 的 replay 修复已在 staging。
- 审计时唯一开放 PR 为目录边界 PR #9，与本任务没有直接实现依赖。Agent A 当前没有开放 PR，待主 Agent 指定依赖。
- GitHub CLI 与 Git HTTPS 在用户代理和用户会话中可用；SSH 失败不阻止本任务。
- 本机默认 Node 为 20.19.2，低于项目最低 22.13；需先选择合规 Node 再安装依赖和运行质量门。

## 范围与协作

接收方：主 Agent、Agent A。Agent B 负责设备、账户隔离 outbox、lease、revision/cursor、edition/highlight 墓碑、允许的阅读偏好与真实 RLS 复验。

初始提交仅增加本记录，不修改 `App.tsx`、`storage.ts`、`worker/index.mjs` 或 migration；后续若需修改共享文件或新增 migration，先在 PR 声明精确范围。原书、R2、manifest、配额和文件清理仍归 Agent A。

## 真实环境门禁

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| staging migration 实际清单 | BLOCKED | 尚未取得受控只读项目会话，不能由仓库中的 0016 推断远端已应用 |
| SQLSTATE 20000 修复后 edition upsert | BLOCKED | 历史失败见 `evidence/staging-sync-2026-10-28.json`；未复测 |
| 双 Profile 同账户往返 | NOT VERIFIED | 尚未准备真实 staging 客户端与两独立 Profile |
| 双账户 RLS 与匿名限制 | NOT VERIFIED | 未执行真实 RPC/表访问 |
| 断网、幂等、重试、切换与 cursor | NOT VERIFIED | 本地测试不能替代真实验收 |
| 删除墓碑与旧设备复活拒绝 | NOT VERIFIED | 未执行真实旧设备重放 |

先由主 Agent 确认 staging 当前部署 SHA、实际 migration 清单及独占验收窗口。仅对已审核的缺失迁移按门禁申请执行；不重复执行 0016，不修改历史 migration，不部署共享环境或 Production。

## 验收与前向修复计划

依次审计本地实现并对发现的缺陷先补回归测试，再修复；运行类型检查、生产构建、相关测试、完整 Playwright 和最终 `npm run quality`。远端按 runbook 的八项步骤记录 PASS/FAIL/BLOCKED、请求 ID 与 revision/sequence，不保留凭据或敏感 payload。只有已执行的检查才可记为通过。

本记录不改变产品行为、运行步骤或验收标准；已检查 project-guide、runbook、deployment、acceptance-matrix，暂无需因本次审计记录调整其内容。无 DDL、部署或数据变更，无数据库回滚需求；如后续发现数据库缺陷，只提交新的前向迁移。
