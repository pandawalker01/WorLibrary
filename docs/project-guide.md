# WorLibrary 项目地图与协作指南

本文件面向首次接手项目的 Agent 或开发者。目标是在不通读全部源码的前提下，理解系统分层、定位改动位置，并安全地增加功能。

## 1. 产品闭环与当前能力

WorLibrary 是本地优先的多语言阅读器：用户导入自己拥有的 EPUB 或 PDF，在浏览器中离线阅读、翻页、保存进度和摘录；选中文本后会立即请求翻译，并在 EPUB 选区下方的可关闭浮层显示目标理解语言的译文；可关联同一作品的不同版本进行对照阅读。

界面采用原创“日光书库”方向：书库、摘录、我的与设置使用白底、浅蓝侧栏和蓝色选中态，强调明亮、清晰、高信息密度；阅读器保留暖纸色阅读环境。侧栏采用居中标签导航，不使用序号。可以借鉴成熟图书馆产品的信息组织，但不得复制第三方品牌、标识或具体页面。

当前已实现的关键能力：

- EPUB 与 PDF 本地导入、书架持久化、原始文件保存、阅读位置恢复；导入阅读数据时会先验证全部原始文件，缺失或损坏会取消导入而不会留下不可打开的书架记录；阅读器内置的字号、主题与翻译重试文案会跟随界面语言。
- EPUB 目录、分页、字号与主题；PDF 翻页、键盘翻页（方向键/PageUp/PageDown，以及 Home/End 跳至首末页）、按页 OCR、OCR 本地校正和 OCR 失败重试。窄屏 PDF 阅读器将上一页/下一页收敛为阅读页下方的独立大触控条，避免它被排版、OCR 等工具挤出可见区域；本地文件被清理、损坏或暂时不可读时，EPUB/PDF 阅读器显示可重试的恢复说明而不呈现空白页；阅读器顶部排版面板可统一切换字号与纸张/暖页/夜间主题。
- 公网部署目标为 Cloudflare Workers：静态应用壳与 `/api/*` Worker 同域发布；`/api/catalog` 由 Worker 代理已审核的公共书目来源，带来源级超时、短期公共书目缓存和失败回收，避免用户浏览器直接依赖外部目录的网络可达性。`/api/translate` 与 `/api/explain` 使用 Worker Secret 中的 OpenAI-compatible 配置，仅发送用户主动选中的短文本；它们与健康检查都发送 `Cache-Control: no-store` 和 `x-request-id`。`/api/translation-status` 只能报告是否完成配置，绝不返回密钥、模型或供应商地址。服务端密钥不得以 `VITE_*` 变量暴露给浏览器。
- EPUB 与 PDF 选中文字后会立即请求翻译；EPUB 译文浮层锚定在选区下方，不会固定占用页面角落或遮挡正文顶部。浮层内仍可请求解释、选择 EPUB 摘录颜色、保存摘录或按 Escape/关闭键收起；选区本身不会自动着色，只有用户明确点选某种颜色时才创建临时高亮，取消会撤销未保存的临时高亮。新选区会使旧请求结果失效，避免旧译文覆盖当前选区。
- 手动关联版本、双栏对照及低置信度回退。
- EPUB 内嵌原始封面提取；在“我的书库”中右键已导入书籍可重新读取封面、上传封面、编辑书名作者或删除；用户上传的自定义封面不会被覆盖。
- 双书库入口：“我的书库”清楚区分本地导入与联网收藏；“世界书库”仅在用户主动搜索时查询合规目录适配器。当前启用 Open Library 与 Google Books：Open Library 始终标为“仅书目记录”；Google Books 严格采用其 API 返回的书目页与预览/公共领域可见性状态，按钮只会打开原始来源。两源都无法直接读取时，搜索在来源级超时后给出可重试错误，不永久停在加载状态。书目语言筛选提供覆盖全球主要书目语言的 ISO 639-3 列表，并用浏览器 `Intl.DisplayNames` 按当前界面语言显示名称；通过可搜索、键盘可操作的选择器显示完整名称，无法命名的代码不展示，也不直接暴露裸代码。也可优先查看拥有多语言记录的作品，并展示其语言/版本计数。世界书库不复用本地书库的大型营销标题，优先给搜索与发现留出空间。收藏后保存来源、来源记录 ID 与可读性状态。推荐区采用透明的主题策展，点击后才执行检索，不伪装成缺乏统计口径的全网排行榜。它不下载、保存或分发未获授权的正文，能否阅读全文以原始来源的版权与访问规则为准。
- 简体中文与英文界面；`src/lib/interface-locale-registry.ts` 已建立全球界面语言的可用/规划状态、稳定回退与 RTL 能力，避免未完成翻译包被误开放。设置页的全球语言选择器应同时展示可切换的已支持语言与不可切换的计划语言路线图，且以本地化名称显示、绝不暴露裸代码；AI 理解/翻译目标通过另一套可搜索的全球语言选择器选择，保存稳定的语言名称。顶栏的“理解语言”是同一选择器的紧凑入口，会在当前位置弹出，不会跳转设置页；当前语言名会随界面语言本地化。
- 页面状态通过 URL 查询参数恢复：书库、世界书库、摘录、我的、设置以及已导入书籍的阅读器在刷新、复制链接和浏览器前进后退后回到对应位置；路由不占用认证魔法链接使用的 hash。
- “我的”本地阅读页：统计本设备中的累计阅读时长、书籍、正在读、已完成与摘录数量；另以本地持久化的近 7 天阅读时长展示阅读轨迹，并记录每本书的本地阅读时长、按最后阅读时间提供最近阅读记录。仅在阅读器所在的浏览器标签页处于前台可见时计时。这些数据不伪装成云端账户数据。右上角账户入口显示会话身份的首字母头像，并通向设置中的账号与同步区。
- 键盘与辅助技术基础支持：主导航和筛选会暴露当前状态；阅读器目录、选区操作与元数据对话框可用 Escape 关闭；阅读器翻页快捷键只在阅读内容区域生效，目录、工具栏与 OCR 编辑控件保留自身键盘交互；所有交互控件有高对比度可见焦点。
- 匿名/魔法链接认证、Supabase 同步基础、AI 额度账本与受控 API 网关。当前可稳定承诺的是本地优先阅读；跨设备同步仍处于实现阶段，不能在未配置 Supabase 且未通过真实跨设备验收时承诺恢复。

书籍文件默认留在本机。目标同步范围是元数据、进度、摘录、阅读统计、世界书库收藏和相关设置，不是原始书籍文件；当前云端同步尚未完成该范围，清除站点数据前必须导出本地阅读数据。

## 2. 分层总览

用户浏览器
  - PWA 应用壳：Manifest、Service Worker、安装入口与安全更新提示
  - React 页面和组件：书库、阅读器、摘录、我的（本地阅读统计）、设置、离线状态
  - 本地层：IndexedDB 元数据与摘录；OPFS 或 IndexedDB 文件内容
  - 阅读引擎：EPUB.js、PDF.js
  - 客户端服务：翻译、解释、OCR、认证、同步

服务端
  - Cloudflare Worker 入口：worker/index.mjs（静态应用壳、目录搜索、健康检查）
  - Node 网关：server/ai-gateway.mjs、server/ocr-gateway.mjs
  - Supabase：认证、远端同步行、额度账本与 SQL migration
  - 外部 AI/OCR 供应商：只接收用户主动选择的短文本或当前页

质量层
  - Playwright：tests/qa/ 为用户验收流程；tests/ 为契约和冒烟测试
  - scripts/quality-gate.mjs：发布质量门
  - docs/acceptance-matrix.md：可追溯的验收矩阵

## 3. 模块地图

| 区域 | 主要文件 | 负责什么 | 修改时要注意 |
| --- | --- | --- | --- |
| 应用编排 | src/App.tsx | URL 页面状态、我的/世界书库、阅读器内导入、统一阅读排版面板、我的页本地统计、设置、会话、同步触发 | 路由使用查询参数，保留认证 hash；不把文件解析或网络细节塞进这里；复用 lib 与组件 |
| 世界书库 | src/lib/world-library.ts、src/components/WorldLanguagePicker.tsx、src/App.tsx | 用户主动发起的合规书目检索、全球语言列表与可搜索本地化选择器、多语种筛选、主题推荐、来源/可读性标注、联网收藏的本地持久化 | `WORLD_CATALOG_SOURCES` 是唯一的数据源注册点；每个适配器必须显式输出来源、来源记录 ID、外链和 `access.mode`，并在接入前完成条款、限流、来源与版权审查；当前启用 Open Library（`catalog_only`）和 Google Books（按 `viewability` 映射为 `catalog_only`、`preview` 或 `public_domain`）。每个来源请求必须有超时和失败回收，禁止让书库永久停在加载状态。Google Books 的语言筛选仅对有 ISO 639-1 映射的语言生效，无法映射时不混入未筛选结果。`WORLD_LANGUAGE_CODES` 是可扩展的 ISO 639-3 代码集，名称由 `worldLanguageName` 用 `Intl.DisplayNames` 显示；选择器禁止展示无法解释的裸代码；不要把搜索结果伪装为已授权全文，也不要把联网收藏写入 StoredBook 或同步成原始文件 |
| PWA 离线壳 | src/main.tsx、public/manifest.webmanifest、public/sw.js、public/offline.html | 注册 Service Worker、应用安装元数据、静态资源缓存、离线回退和更新激活 | 只缓存应用壳/静态资源；绝不缓存 API、Supabase、原始书籍文件或用户正文 |
| 本地书库 | src/lib/storage.ts | 文件保存、书籍元数据、封面、进度、摘录、导入导出、作品/版本关系 | 修改 StoredBook 或备份格式时兼容旧记录，并补迁移/回归 |
| EPUB 阅读器 | src/components/EpubReader.tsx、src/epub-reader.css | EPUB 打开、目录、分页、位置、选区操作 | EPUB 的位置用 CFI；测试刷新恢复和无目录回退 |
| PDF 阅读器 | src/components/PdfReader.tsx、src/pdf-reader.css | PDF 渲染、页面位置、键盘控制、OCR 入口与本地校正 | 不阻塞翻页；OCR 失败必须能重试且保留页面；草稿只有点击确认后才能用于翻译或摘录 |
| 摘录 | src/components/HighlightsView.tsx、src/highlights.css | 列表、搜索、筛选、笔记、颜色、删除 | 保存后要验证刷新与同步语义 |
| 多版本对照 | src/components/EditionComparisonReader.tsx、src/lib/edition.ts | 关联版本、章节/段落对齐、双栏降级 | 不要强制不可靠的句对句同步 |
| AI 客户端 | src/lib/translation.ts、src/lib/explanation.ts、src/lib/ai-result-cache.ts | 调网关、缓存、错误与重试信息 | 浏览器不能保存供应商密钥；仅传选区和必要上下文 |
| OCR 客户端 | src/lib/ocr.ts、docs/ocr.md | 当前 PDF 页转数据并请求 OCR | 只发送用户主动选定的页；不要上传整本书；校正草稿不可自动发给 AI |
| 认证与同步 | src/lib/auth.ts、src/lib/remote.ts、src/lib/sync.ts、src/components/AuthPanel.tsx | 匿名/魔法链接会话、远端行同步、队列与冲突处理 | 原始书籍不进入同步；RLS 是服务端最终边界 |
| 国际化 | src/lib/i18n.ts、src/lib/interface-locale-registry.ts、src/components/ReadingLanguagePicker.tsx 与各组件 | 界面语言和全球 AI 输出语言；界面语言的可用/规划状态、稳定回退与 RTL 方向 | 先读 docs/i18n-extension.md；两种语言配置独立；planned 语言没有完整文案前不得出现在可切换列表 |
| API 与额度 | worker/、api/、server/、supabase/migrations/ | Worker 路由、JWT 校验、额度扣减、目录代理、健康检查 | 密钥仅在环境变量；额度操作需服务端原子化 |
| Cloudflare 部署 | worker/index.mjs、wrangler.jsonc、scripts/verify-deployment.mjs、.github/workflows/ci.yml | 同域静态 SPA、`/api/catalog`、`/api/translate`、`/api/explain`、健康/翻译就绪探针、真实目录发布验证与 Worker 安全头 | 手动部署必须从 Wrangler 输出提取地址，并由 GitHub Runner 验证健康、翻译配置状态和真实目录查询；公共书目结果可短期缓存；AI/OCR、认证和错误响应不得共享缓存；生产端点必须 HTTPS。当前 Worker 的边缘限流是每 isolate 的基础防护，公开启用付费 AI 前还必须接入全局限流/WAF 与账户额度边界 |
| 样式 | src/*.css | 分区布局、阅读器与移动端适配 | 改动后检查桌面与 390px 窄屏用例 |
| 无障碍与键盘阅读 | src/App.tsx、src/components/EpubReader.tsx、src/components/PdfReader.tsx、src/app.css | 焦点可见性、ARIA 当前/展开状态、Escape 关闭阅读器临时界面 | 同时检查中英文可访问名称，并运行 `tests/qa/accessibility.spec.ts` |

## 4. 常见改动如何落位

| 想做的事 | 优先修改 | 必须补的验证 |
| --- | --- | --- |
| 新增书籍格式 | storage.ts + 对应 Reader 组件 + 导入入口 | 导入、刷新、重开、删除、错误文件提示 |
| 调整 EPUB/PDF 体验 | 对应 Reader 与 CSS | 翻页、阅读位置恢复、移动端、选区动作 |
| 新增书架字段或设置 | storage.ts + App.tsx + 导入导出 | 旧数据兼容、刷新、备份恢复 |
| 新增 AI 功能 | 客户端 lib + server 网关 + API 路由 | 不泄露密钥、配额/超时/失败提示、缓存 |
| 修改同步行为 | sync.ts + remote.ts + migration/RLS | 离线队列、冲突、只同步元数据、跨会话恢复 |
| 新增界面语言 | i18n.ts + 相关测试 | 按 docs/i18n-extension.md 完整执行 |
| 调整部署 | docs/deployment.md + docs/runbook.md + 环境校验脚本 | staging、健康检查、回滚预案 |
| 调整离线/PWA | public/sw.js + manifest + src/main.tsx | 首装、离线导航、更新提示；验证导入书籍仍由 OPFS/IndexedDB 读取 |

## 5. 数据与隐私边界

本地：书籍二进制、封面、阅读位置、摘录、笔记、作品/版本关系、AI 缓存，以及联网收藏书目的标题/作者/封面 URL/来源链接、来源记录 ID 与可读性状态（localStorage 的 `worlibrary.saved-world-books`）。

远端目标：Supabase 保存认证身份、同步元数据、进度、摘录、设置、设备与额度账本；当前尚未完成阅读统计、世界书库收藏和所有设置的跨设备同步。Cloudflare Worker 只在用户提交搜索时向已启用的合规书目来源请求公共元数据，可短期缓存已归一化的无身份查询；服务端不得接收整本书。禁止接入、镜像、代理或为任何用户白名单绕过未获授权正文来源；AI 只接收选区与少量上下文，OCR 只接收用户点击识别的当前页。

涉及数据库时，新增 migration 只能向前；所有用户数据表必须有 RLS，并以 user_id 等于 auth.uid() 作为所有权边界。额度、订阅和权限只能由服务端更新。

同步或数据库变更时，先核对 src/lib/remote.ts 中的远端表白名单（works、editions、reading_progress、highlights、user_settings、devices），再查看 supabase/migrations 的既有 schema 与 RLS。不要假定客户端可直接写 usage ledger、订阅或权限表。

## 6. 开发、验证与提交

本地启动：npm install，然后 npm run dev。通常访问 http://localhost:5173；不要用 file:// 直接打开 index.html，也不要连接遗留的 Vite 端口。

最低验证：npm run typecheck、npm run build、npm run test:worker，以及与改动范围匹配的 Playwright 用例。Cloudflare 配置完成后还要运行 `npm run cf:dev` 或 `npm run cf:deploy -- --dry-run`，并验证 `/api/health` 与 `/api/catalog`。`cf:dev` 会先构建当前前端再启动 Worker；不要直接运行 `wrangler dev` 以免服务过期的 `dist/`。PWA 变更必须运行 `npx playwright test tests/qa/pwa-shell.spec.ts`，并在生产预览中验证 Service Worker 注册、离线提示与已导入书籍恢复。对跨模块功能，运行 npx playwright test。发布前还需参考 docs/runbook.md。

提交前必须阅读根目录 AGENTS.md 并更新受影响的文档。文档、测试和实现应进入同一次提交，使新 Agent 可以从仓库状态而非聊天记录恢复上下文。

## 7. 推荐阅读顺序

1. 本文件。
2. `docs/cross-platform-client-plan.md`（若涉及桌面、iOS/iPadOS、Android 或跨端同步）。
3. README.md，了解启动方式。
4. docs/implementation-architecture.md，了解长期架构与边界。
5. docs/i18n-extension.md（若涉及语言）。
6. docs/runbook.md 与 docs/deployment.md（若涉及环境、数据库或发布）。
7. 与任务对应的组件、lib 文件和已有 Playwright 用例。
