# Agent B：鉴权、数据库与同步交接记录

## 身份与分支

- Agent：B
- 负责方向：Supabase 鉴权、数据库、RLS、云端同步
- 分支：`codex/backend-auth-sync`
- 远程分支：`origin/codex/backend-auth-sync`
- 最新提交：`27e137f feat: connect indexeddb sync adapter`

## 已完成工作

### Supabase 数据层

- 新增 `supabase/migrations/0001_initial_sync.sql`。
- 建立用户资料、设备、Work、Edition、阅读进度、摘录和用户设置表。
- 所有个人数据表启用 RLS，并通过 `auth.uid()` 限制读写范围。
- 新用户自动创建 profile。
- 使用级联删除保证删除用户后清理个人云端数据。

### 认证

- 新增 `src/lib/auth.ts`。
- 支持匿名注册/试用。
- 支持邮箱 Magic Link。
- 支持本地会话保存、自动刷新、退出登录和跨标签页状态监听。
- 新增 `src/components/AuthPanel.tsx`，提供基础登录面板。

### 远程同步

- 新增 `src/lib/remote.ts`，封装 Supabase REST API。
- upsert 自动注入当前会话的 `user_id`，满足 RLS 策略。
- 新增 `src/lib/sync.ts`。
- 支持本地书籍元数据、阅读位置、进度、摘录和设置的同步。
- 新增 `createIndexedDbSyncAdapter()`，直接连接现有 IndexedDB。
- 同步只上传元数据和阅读数据，不上传原始书籍文件。
- 重复同步使用 upsert，具备幂等性。
- 远程较新的数据按时间合并到本地。

### 配置与验证

- 新增 `.env.example`，包含 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY`。
- 新增 `supabase/seed.sql` 说明文件。
- 类型检查通过。
- Vite 生产构建通过。
- 当前仓库没有现成自动化测试脚本。

## 重要集成说明

- `AuthPanel` 目前是独立组件，尚未接入 `src/App.tsx` 设置页。
- 主 Agent 集成时可在设置页渲染 `<AuthPanel onNotice={toast} />`。
- 同步调用示例：

```ts
const session = await getSession()
if (session) {
  const remote = createRemoteClient(session)
  await syncLibrary(remote, createIndexedDbSyncAdapter())
}
```

- `VITE_SUPABASE_URL` 与 `VITE_SUPABASE_ANON_KEY` 必须配置后认证和同步才会启用。
- migration 需要在目标 Supabase 项目中执行，当前仅已提交到仓库。
- 原始 EPUB/PDF/其他书籍文件始终保留在本地，不进入云端同步。

## 下一步待完成

1. 在 Supabase staging 项目执行 migration，并验证匿名用户和邮箱用户的 RLS 隔离。
2. 将 `AuthPanel` 集成到 `App.tsx` 的设置视图。
3. 在用户登录后触发首次同步，并在进度/摘录变更后安排防抖同步。
4. 补充匿名身份升级到邮箱账号的完整合并流程。
5. 为账号删除增加用户可操作入口，并验证云端级联删除和本地退出。
6. 增加离线同步队列、失败重试和冲突提示。
7. 为认证、RLS 和同步适配器补充自动化测试。
8. 与主 Agent 统一 Work/Edition 字段命名，尤其是 `book_id` 与 `edition_id` 的兼容策略。

## 交付记录

- `683bfbe feat: add auth and cloud sync foundation`
- `27e137f feat: connect indexeddb sync adapter`

