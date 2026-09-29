# Supabase staging 配置与 RLS 验证

本文是 Agent B 的 staging 操作手册。生产环境不能直接修改表，必须通过 migration 发布。

## 1. 准备环境

需要一个 Supabase staging 项目、项目 URL、匿名 key，以及具备数据库 migration 权限的 Supabase CLI 登录身份。

```bash
supabase login
supabase link --project-ref <staging-project-ref>
supabase db push
```

`supabase db push` 会执行 `supabase/migrations/0001_initial_sync.sql`。该 migration 的 trigger、policy 和 `editions.book_id` 兼容列可安全重复执行。

在 staging 的 SQL Editor 执行：

```sql
\i supabase/verify_rls.sql
```

如果 SQL Editor 不支持 `\i`，请直接粘贴 `supabase/verify_rls.sql` 内容。结果必须显示七张表且 `rowsecurity = true`。

## 2. 配置前端

将 staging 项目的浏览器安全变量注入预览环境：

```text
VITE_SUPABASE_URL=https://<staging-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<staging-anon-key>
```

只能使用 anon key。service role key 不得放进 `.env`、Vite 构建产物或浏览器请求。

## 3. 双用户隔离验证

在 Auth 面板创建两个测试用户，分别记为 User A 和 User B，并取得各自 access token。用 User A 写入一条最小 Edition：

```bash
curl -sS -X POST "$VITE_SUPABASE_URL/rest/v1/editions" \
  -H "apikey: $VITE_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $USER_A_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"id":"00000000-0000-0000-0000-000000000001","title":"RLS test","user_id":"<USER_A_ID>"}'
```

分别用 A、B 查询：

```bash
curl -sS "$VITE_SUPABASE_URL/rest/v1/editions?select=id,title,user_id" \
  -H "apikey: $VITE_SUPABASE_ANON_KEY" -H "Authorization: Bearer $USER_A_TOKEN"
curl -sS "$VITE_SUPABASE_URL/rest/v1/editions?select=id,title,user_id" \
  -H "apikey: $VITE_SUPABASE_ANON_KEY" -H "Authorization: Bearer $USER_B_TOKEN"
```

预期：A 能看到测试行，B 得到空数组；B 尝试用 A 的 `user_id` 插入或更新应返回 401/403。对 `highlights`、`reading_progress` 和 `user_settings` 重复同样检查。

## 4. 删除验证

在 staging Auth 页面删除 User A，然后确认 `profiles`、`editions`、`highlights`、`reading_progress`、`user_settings` 和 `devices` 中不再存在 A 的行。原因是这些表都通过 `on delete cascade` 关联 `auth.users`。

## 当前执行状态

本工作区没有 staging project ref、Supabase CLI 或 staging 凭据，因此本轮只能完成 migration 可重复执行改造和验证脚本；实际 `db push`、双用户 RLS 和删除验证需在具备上述凭据的环境执行。
