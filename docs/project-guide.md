# WorLibrary 项目地图与协作指南

本文件面向首次接手项目的 Agent 或开发者。目标是在不通读全部源码的前提下，理解系统分层、定位改动位置，并安全地增加功能。

## 1. 产品闭环与当前能力

WorLibrary 是本地优先的多语言阅读器：用户导入自己拥有的 EPUB 或 PDF，在浏览器中离线阅读、翻页、保存进度和摘录；选中文本后可请求翻译或解释；可关联同一作品的不同版本进行对照阅读。

界面采用原创“日光书库”方向：书库、摘录、我的与设置使用白底、浅蓝侧栏和蓝色选中态，强调明亮、清晰、高信息密度；阅读器保留暖纸色阅读环境。侧栏采用居中标签导航，不使用序号。可以借鉴成熟图书馆产品的信息组织，但不得复制第三方品牌、标识或具体页面。

当前已实现的关键能力：

- EPUB 与 PDF 本地导入、书架持久化、原始文件保存、阅读位置恢复。
- EPUB 目录、分页、字号与主题；PDF 翻页、键盘翻页、按页 OCR 和 OCR 失败重试。
- 选中文字后的翻译、解释、保存摘录、颜色和笔记编辑。
- 手动关联版本、双栏对照及低置信度回退。
- EPUB 内嵌原始封面提取；旧书可在设置中重新读取封面；用户上传的自定义封面不会被覆盖。
- 简体中文与英文界面；中文、英文、日语、法语的 AI 理解/翻译目标语言。
- “我的”本地阅读页：统计本设备中的累计阅读时长、书籍、正在读、已完成与摘录数量，并提供最近阅读入口；这些数据不伪装成云端账户数据。右上角账户入口显示会话身份的首字母头像，并通向设置中的账号与同步区。
- 键盘与辅助技术基础支持：主导航和筛选会暴露当前状态；阅读器目录、选区操作与元数据对话框可用 Escape 关闭；所有交互控件有高对比度可见焦点。
- 匿名/魔法链接认证、Supabase 同步元数据、AI 额度账本与受控 API 网关。

书籍文件默认留在本机。同步的是元数据、进度、摘录和相关设置，不是原始书籍文件。

## 2. 分层总览

用户浏览器
  - PWA 应用壳：Manifest、Service Worker、安装入口与安全更新提示
  - React 页面和组件：书库、阅读器、摘录、我的（本地阅读统计）、设置、离线状态
  - 本地层：IndexedDB 元数据与摘录；OPFS 或 IndexedDB 文件内容
  - 阅读引擎：EPUB.js、PDF.js
  - 客户端服务：翻译、解释、OCR、认证、同步

服务端
  - Vercel 风格 API 入口：api/translate.mjs、api/explain.mjs、api/health.mjs
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
| 应用编排 | src/App.tsx | 页面视图、书架与阅读器内导入、我的页本地统计、设置、会话、同步触发 | 不把文件解析或网络细节塞进这里；复用 lib 与组件 |
| PWA 离线壳 | src/main.tsx、public/manifest.webmanifest、public/sw.js、public/offline.html | 注册 Service Worker、应用安装元数据、静态资源缓存、离线回退和更新激活 | 只缓存应用壳/静态资源；绝不缓存 API、Supabase、原始书籍文件或用户正文 |
| 本地书库 | src/lib/storage.ts | 文件保存、书籍元数据、封面、进度、摘录、导入导出、作品/版本关系 | 修改 StoredBook 或备份格式时兼容旧记录，并补迁移/回归 |
| EPUB 阅读器 | src/components/EpubReader.tsx、src/epub-reader.css | EPUB 打开、目录、分页、位置、选区操作 | EPUB 的位置用 CFI；测试刷新恢复和无目录回退 |
| PDF 阅读器 | src/components/PdfReader.tsx、src/pdf-reader.css | PDF 渲染、页面位置、键盘控制、OCR 入口 | 不阻塞翻页；OCR 失败必须能重试且保留页面 |
| 摘录 | src/components/HighlightsView.tsx、src/highlights.css | 列表、搜索、筛选、笔记、颜色、删除 | 保存后要验证刷新与同步语义 |
| 多版本对照 | src/components/EditionComparisonReader.tsx、src/lib/edition.ts | 关联版本、章节/段落对齐、双栏降级 | 不要强制不可靠的句对句同步 |
| AI 客户端 | src/lib/translation.ts、src/lib/explanation.ts、src/lib/ai-result-cache.ts | 调网关、缓存、错误与重试信息 | 浏览器不能保存供应商密钥；仅传选区和必要上下文 |
| OCR 客户端 | src/lib/ocr.ts | 当前 PDF 页转数据并请求 OCR | 只发送用户主动选定的页；不要上传整本书 |
| 认证与同步 | src/lib/auth.ts、src/lib/remote.ts、src/lib/sync.ts、src/components/AuthPanel.tsx | 匿名/魔法链接会话、远端行同步、队列与冲突处理 | 原始书籍不进入同步；RLS 是服务端最终边界 |
| 国际化 | src/lib/i18n.ts 与各组件 | 界面语言和 AI 输出语言 | 先读 docs/i18n-extension.md；两种语言配置独立 |
| API 与额度 | api/、server/、supabase/migrations/ | 网关、JWT 校验、额度扣减、健康检查 | 密钥仅在环境变量；额度操作需服务端原子化 |
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

本地：书籍二进制、封面、阅读位置、摘录、笔记、作品/版本关系、AI 缓存。

远端：认证身份、同步元数据、进度、摘录、设置、设备与额度账本。服务端不得接收整本书；AI 只接收选区与少量上下文，OCR 只接收用户点击识别的当前页。

涉及数据库时，新增 migration 只能向前；所有用户数据表必须有 RLS，并以 user_id 等于 auth.uid() 作为所有权边界。额度、订阅和权限只能由服务端更新。

同步或数据库变更时，先核对 src/lib/remote.ts 中的远端表白名单（works、editions、reading_progress、highlights、user_settings、devices），再查看 supabase/migrations 的既有 schema 与 RLS。不要假定客户端可直接写 usage ledger、订阅或权限表。

## 6. 开发、验证与提交

本地启动：npm install，然后 npm run dev。通常访问 http://localhost:5173；不要用 file:// 直接打开 index.html，也不要连接遗留的 Vite 端口。

最低验证：npm run typecheck、npm run build，以及与改动范围匹配的 Playwright 用例。PWA 变更必须运行 `npx playwright test tests/qa/pwa-shell.spec.ts`，并在生产预览中验证 Service Worker 注册、离线提示与已导入书籍恢复。对跨模块功能，运行 npx playwright test。发布前还需参考 docs/runbook.md。

提交前必须阅读根目录 AGENTS.md 并更新受影响的文档。文档、测试和实现应进入同一次提交，使新 Agent 可以从仓库状态而非聊天记录恢复上下文。

## 7. 推荐阅读顺序

1. 本文件。
2. README.md，了解启动方式。
3. docs/implementation-architecture.md，了解长期架构与边界。
4. docs/i18n-extension.md（若涉及语言）。
5. docs/runbook.md 与 docs/deployment.md（若涉及环境、数据库或发布）。
6. 与任务对应的组件、lib 文件和已有 Playwright 用例。
