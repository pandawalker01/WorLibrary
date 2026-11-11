# WorLibrary

一个本地优先、可安装的多语言阅读 Web 应用。它提供以下核心体验：

- 本地导入 EPUB 与 PDF，原始文件只保存在当前浏览器设备。
- 同一作品的多个语言版本、版本切换与双栏对照阅读。
- 用户设置“理解语言”后，划线获得翻译与通俗解释。
- 扫描页 OCR、匿名 AI 额度、可安装的离线应用壳与离线阅读状态。

## 运行

这是一个 React + TypeScript + Vite 驱动的前端 Demo。请使用 Node.js 24（本项目依赖的 PDF 与 Cloudflare 工具链要求 Node.js 22.13 以上）；首次安装依赖后运行：

```bash
npm install
npm run dev
```

然后访问终端显示的本地地址（默认是 `http://localhost:5173`）。

需要连同 Cloudflare Worker 验证世界书库或真实翻译时，运行：

```bash
npm run cf:dev
```

该命令会先重新构建前端，再在 `http://localhost:8787` 启动 Worker；不要直接运行 `wrangler dev`，否则可能继续服务上一次构建留下的 `dist/` 内容。

生产构建与类型检查：

```bash
npm run typecheck
npm run build
```

架构与执行路线见：

- `docs/implementation-architecture.md`
- `docs/development-roadmap.md`
- `docs/project-guide.md`：模块地图、常见改动入口与协作规则。
- `docs/i18n-extension.md`：新增界面语言或 AI 理解语言的操作手册。
- `AGENTS.md`：所有提交必须同步维护的文档规范。
- `docs/deployment.md`：PWA 缓存策略、上线与回滚说明。
- `docs/runbook.md`：发布检查、部署预检与故障处理。

## 当前边界

书籍文件、封面、进度与摘录保存在本机的 OPFS / IndexedDB；Service Worker 只缓存应用壳和静态资源，绝不缓存或上传原始书籍。离线时可继续打开已导入书籍。Cloudflare Worker 部署后，世界书库查询经同源 `/api/catalog` 访问已审核书目来源；平台自有或已授权内容仅能经私有 R2 的受控 `/api/reader/content` 交付，需先完成许可、来源哈希、授权服务与 R2 绑定配置。已审核的平台目录可由 Worker 的 `PLATFORM_CATALOG_JSON` 公开其安全书目投影，但只有同时存在匹配的 `PLATFORM_CONTENT_ACCESS_JSON` 策略时才会显示为 WorLibrary 平台版本；它不能把第三方“免费”标签自动变成可分发正文。已授权 EPUB/PDF 在平台阅读器中只进入当前会话内存并可翻页，不写入本地书库、缓存或下载路径。真实 AI/OCR 与云端同步仍需按部署文档配置服务端环境变量。清除站点数据会清除本地原书与本地状态；云端同步只恢复已完成并经真实跨设备验收的元数据，不能替代原书备份。

无需云配置也可以部署并使用本地阅读核心。运行 `npm run validate:env -- --staging --json` 可获得机器可读的已关闭能力与缺失项；完整认证、同步、AI/OCR 上线前使用 `npm run validate:env -- --production --json`。AI 网关的健康、翻译与解释响应均禁止共享 HTTP 缓存，保护用户主动发送的选区文本与错误信息。变量分类与安全边界见 `docs/deployment.md`，不要把任意密钥写入 `VITE_*` 或提交 `.env`。

### 个人云书库前向迁移草案

`0018_private_file_consent.sql` 仅已起草并本地测试，尚未应用远端；它新增专用本人同意/暂停及用量RPC，并要求上传准入已同意且edition归本人。首次同意和自动上传产品入口仍未交付。部署前须按 `docs/release-governance.md` 由主 Agent审阅、核对实际staging migration清单，在完整文件网关验证后执行；不能单独应用此SQL并宣称云书库已上线。无新增前端密钥或环境变量，真实Supabase/R2仍NOT VERIFIED。

## 私有文件本机 SQL 并发回归

已安装 PostgreSQL 的开发者可在当前进程设置 `WORLIBRARY_TEST_PG_BIN` 指向其 `bin` 目录，然后运行 `npm run test:user-files-db`。该命令总是新建只监听 `127.0.0.1` 的临时fixture cluster，使用独立随机端口，不接受远端URL/现有data目录，不读取用户PG连接配置或密码文件，不安装系统服务，结束自动停止。它不运行Supabase/R2验收，也尚未加入共享quality执行器；测试二进制不要提交仓库。Windows可从[PostgreSQL官方页面](https://www.postgresql.org/download/windows/)链接的[EDB二进制页](https://www.enterprisedb.com/download-postgresql-binaries)取得便携包并核对官方SHA-256。
