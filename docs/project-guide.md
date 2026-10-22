# WorLibrary 项目地图与协作指南

本文件面向首次接手项目的 Agent 或开发者。目标是在不通读全部源码的前提下，理解系统分层、定位改动位置，并安全地增加功能。

## 1. 产品闭环与当前能力

WorLibrary 是本地优先的多语言阅读器：用户导入自己拥有的 EPUB 或 PDF，在浏览器中离线阅读、翻页、保存进度和摘录；选中文本后会立即请求翻译，并在 EPUB 选区下方的可关闭浮层显示目标理解语言的译文；可关联同一作品的不同版本进行对照阅读。

界面采用原创“日光书库”方向：书库、摘录、我的与设置使用白底、浅蓝侧栏和蓝色选中态，强调明亮、清晰、高信息密度；阅读器保留暖纸色阅读环境。侧栏采用居中标签导航，不使用序号。所有页面不展示装饰性的英文眉题、编号或微型分类标签；只保留书目来源、语言、进度等实际帮助阅读或决策的信息。可以借鉴成熟图书馆产品的信息组织，但不得复制第三方品牌、标识或具体页面。

当前已实现的关键能力：

- EPUB 与 PDF 本地导入、书架持久化、原始文件保存、阅读位置恢复；导入阅读数据时会先验证全部原始文件，缺失或损坏会取消导入而不会留下不可打开的书架记录；阅读器内置的字号、主题与翻译重试文案会跟随界面语言。
- EPUB 目录、分页、字号与主题；PDF 翻页、键盘翻页（方向键/PageUp/PageDown，以及 Home/End 跳至首末页）、按页 OCR、OCR 本地校正和 OCR 失败重试。窄屏 PDF 阅读器将上一页/下一页收敛为阅读页下方的独立大触控条，避免它被排版、OCR 等工具挤出可见区域；本地文件被清理、损坏或暂时不可读时，EPUB/PDF 阅读器显示可重试的恢复说明而不呈现空白页；阅读器顶部排版面板可统一切换字号与纸张/暖页/夜间主题。
- 公网部署目标为 Cloudflare Workers：静态应用壳与 `/api/*` Worker 同域发布；`/api/catalog` 由 Worker 代理已审核的公共书目来源，带来源级超时、短期公共书目缓存和失败回收，避免用户浏览器直接依赖外部目录的网络可达性。`/api/translate` 与 `/api/explain` 使用 Worker Secret 中的 OpenAI-compatible 配置，仅发送用户主动选中的短文本；它们与健康检查都发送 `Cache-Control: no-store` 和 `x-request-id`。`/api/translation-status` 只能报告是否完成配置，绝不返回密钥、模型或供应商地址。服务端密钥不得以 `VITE_*` 变量暴露给浏览器。
- EPUB 与 PDF 选中文字后会立即请求翻译；EPUB 译文浮层锚定在选区下方，不会固定占用页面角落或遮挡正文顶部。浮层内仍可请求解释、选择 EPUB 摘录颜色、保存摘录或按 Escape/关闭键收起；选区本身不会自动着色，只有用户明确点选某种颜色时才创建临时高亮。保存时会以新的持久注释替换该临时高亮，保证关闭浮层、刷新或重开章节后仍显示；未选颜色而保存的摘录仍保留文字，但不创建阅读页高亮。取消会撤销未保存的临时高亮。新选区会使旧请求结果失效，避免旧译文覆盖当前选区。
- 手动关联版本、双栏对照及低置信度回退。
- EPUB 内嵌原始封面提取；在“我的书库”中右键已导入书籍可重新读取封面、上传封面、编辑书名作者或删除；用户上传的自定义封面不会被覆盖。书籍导入使用书架内的“导入我的书”卡片与阅读器内导入入口，顶栏不放重复的全局导入按钮。
- 双书库入口：“我的书库”清楚区分本地导入与联网收藏；“世界书库”仅在用户主动搜索时查询合规目录适配器。当前启用 Open Library 与 Google Books：Open Library 始终标为“仅书目记录”；Google Books 严格采用其 API 返回的书目页与预览/公共领域可见性状态，按钮只会打开原始来源。两源都无法直接读取时，搜索在来源级超时后给出可重试错误，不永久停在加载状态。Worker 可在引导期合并 `PLATFORM_CATALOG_JSON` 中的已审核平台目录：每条记录必须同时匹配 `PLATFORM_CONTENT_ACCESS_JSON` 的平台策略，才可带稳定 `platformEditionId` 进入 WorLibrary 阅读器；未匹配、格式错误或仅由上游标为“免费”的条目一律保持外部书目状态。书目语言筛选提供覆盖全球主要书目语言的 ISO 639-3 列表，并用浏览器 `Intl.DisplayNames` 按当前界面语言显示名称；通过可搜索、键盘可操作的选择器显示完整名称，无法命名的代码不展示，也不直接暴露裸代码。也可优先查看拥有多语言记录的作品，并展示其语言/版本计数。世界书库不复用本地书库的大型营销标题，优先给搜索与发现留出空间。收藏后保存来源、来源记录 ID 与可读性状态。推荐区采用透明的主题策展，点击后才执行检索，不伪装成缺乏统计口径的全网排行榜。它不下载、保存或分发未获授权的正文，能否阅读全文以原始来源的版权与访问规则为准。下一阶段采用“作品优先”检索：未指定书目语言时结果按 `Work` 聚合，卡片将作者原著作为显著且独立的信息，版本列表按当前界面语言优先、其他语言后排；指定书目语言后只列出该语言的 `Edition`，但可保留不参与选择的原著元数据标签。查询必须同时覆盖原题、作者、译名/别名，并提供“只看原著”筛选，不能把原著仅当作普通译本参与排序。
- 平台书籍访问与交付：`GET /api/reader/access?editionId=` 将“加入我的书库”与“可否阅读/下载”分开，稳定输出 `download`、`stream`、`external_reader`、`preview` 或 `catalog_only`。只有私有 R2 绑定、对象和允许格式均齐备时才报告 `delivery.available: true` 并附带可安全渲染的媒体类型；`GET` / `HEAD` `/api/reader/content?editionId=` 才会在每次请求重新验证受限会话后，以单段 Range 读取 EPUB/PDF。两接口均绝不传输对象键、文件 URL、签名 URL、阅读令牌或环境变量；不提供下载交付。书库中已收藏的平台版本会进入 WorLibrary 的平台阅读页，受保护 EPUB/PDF 仅以当前内存中的 ArrayBuffer 交给 EPUB.js/PDF.js 并支持基本翻页，不写入本地书库、对象 URL 或缓存；交付未配置、格式不受支持或授权失败时明确失败关闭。不能为测试或白名单绕过未授权第三方正文。`0007` 已建立服务端专用的动态交付解析 SQL 与运营角色表：真实发布需由独立的内部 resolver（Worker Service Binding）持有 service-role 权限，依据发布状态、许可、来源哈希、地区和权益即时解析；当前公开 Worker 尚未连接该 resolver，因此生产不得把数据库发布误认为已自动生效。
- 简体中文与英文界面；`src/lib/interface-locale-registry.ts` 已建立全球界面语言的可用/规划状态、稳定回退与 RTL 能力，避免未完成翻译包被误开放。设置页的全球语言选择器应同时展示可切换的已支持语言与不可切换的计划语言路线图，且以本地化名称显示、绝不暴露裸代码；AI 理解/翻译目标通过另一套可搜索的全球语言选择器选择，保存稳定的语言名称。个人书库首页将“理解语言”和账户并列在主标题右侧，替代重复的说明性文案，并将顶部留白压缩为紧凑的内容起始区；其他页面仍在右上角提供完全相同尺寸的入口组。理解语言入口会在当前位置弹出，不会跳转设置页；当前语言名会随界面语言本地化。
- 页面状态通过 URL 查询参数恢复：书库、世界书库、摘录、我的、设置以及已导入书籍的阅读器在刷新、复制链接和浏览器前进后退后回到对应位置；路由不占用认证魔法链接使用的 hash。
- “我的”本地阅读页：统计本设备中的累计阅读时长、书籍、正在读、已完成与摘录数量；另以本地持久化的近 7 天阅读时长展示阅读轨迹，并记录本地导入书籍及已收藏平台版本的阅读时长、按最后阅读时间提供最近阅读记录。平台记录只保存稳定的版本 ID、书目元数据与时长，不保存正文、阅读位置、交付 URL 或授权信息。仅在阅读器所在的浏览器标签页处于前台可见时计时。这些数据不伪装成云端账户数据。账户入口显示会话身份的首字母或本机头像：在个人书库首页它与理解语言位于主标题右侧；其他页面位于右上角，同一账户与语言控件组保持统一高度与间距。未登录时会直接打开可关闭的邮箱登录／注册弹窗；已登录时头像打开可 Escape/点击外部关闭的私密账户菜单，提供账户中心、我的阅读、摘录、云端书库与同步、隐私与数据及退出登录。菜单顶端的头像、昵称和私密邮箱摘要是可访问的“前往个人主页”入口，会关闭菜单并路由至“我的阅读”；账户中心仍只负责资料、登录与隐私设置。顶部只显示公开昵称，绑定邮箱仅在私密菜单及设置内显示；角色和管理员入口不由浏览器暴露或决定。账户中心现在可编辑公开昵称、可选简介和本机头像：已配置并迁移 Supabase 时昵称/简介保存到本人 `profiles` 行，失败时明确只保存在当前设备；头像选择目前只保存在当前设备，专用私有头像桶及其 RLS 已在 `0011` 建好，受控上传与跨设备头像读取仍待接入。资料默认不公开，也不应用于登录、授权或员工角色判定。
- 键盘与辅助技术基础支持：主导航和筛选会暴露当前状态；阅读器目录、选区操作与元数据对话框可用 Escape 关闭；阅读器翻页快捷键只在阅读内容区域生效，目录、工具栏与 OCR 编辑控件保留自身键盘交互；所有交互控件有高对比度可见焦点。
- 匿名/魔法链接认证、Supabase 同步基础、AI 额度账本与受控 API 网关。匿名试用没有云端数据所有权边界，客户端不会为其排队或上传同步数据；当前也不提供匿名试用原地升级到账户的迁移。邮箱魔法链接会保留当前的查询参数页面路由，不复用认证 hash。旧的全表 REST 同步已在客户端关闭：它不具备账户隔离队列、服务端 revision 或“仅元数据、需重新导入”的书籍表示。客户端已具备与书籍二进制分离、按账户隔离的 metadata outbox、顺序 flush 和受控 change-feed 分页拉取协调器；拉取器只接受稳定账户、严格递增的服务端 sequence，并在调用方拒绝未知/不安全 payload 时不推进游标。对同一账户、同一版本的连续本地待发送更新，outbox 只保留最早乐观 revision/操作 ID 与最新安全 metadata，避免在首次 flush 前产生多条 `baseRevision=0` 写入；一条已被发送的操作会被本地 lease 精确认领，随后新编辑另建 pending 操作，旧回执只能删除自己的 lease 并把后续操作重基到回执 revision。每条已安全投影的远端 edition 变更还会持久化该账户、版本的服务器 revision 与 sequence；落盘失败则本页游标不前移。版本变更只经严格白名单投影到按账户隔离的 shadow store：仅接受书名、作者、语言、进度、位置、文件元数据和封面色，未知实体会被忽略且由上层决定是否推进游标；字节、封面二进制、对象键、URL 和正文一律拒绝。shadow 条目永远带 `needsReimport`，没有文件、封面二进制或可读权限，因此不能交给本地阅读器打开。运行中的同步可按账户失效：登出或切换账户后，旧会话不会继续 flush、pull、投影或写游标/revision。下一阶段才会把本地书架/进度/摘录/必要偏好的页面写入统一接到该 outbox：仅稳定已登录账户可排队，写入成功前保留本地优先状态，按账户顺序 flush 后再分页拉取并以服务端 revision 合并；登出、账户切换、未知 payload、拉取失败或文件类字段出现时必须停止该轮同步且不得推进游标。此阶段仍只同步最小元数据，不能上传 EPUB/PDF、封面二进制、对象键、URL、正文或正文定位，也不能把 `needsReimport` shadow 当作可读文件。`0008` 建立同步设备、键级设置、变更日志、删除墓碑和阅读统计事件的数据边界；`0009` 增加只允许稳定自有设备调用的受控 metadata mutation/pull RPC、服务端 revision、幂等操作与墓碑，并拒绝文件字节、对象键和正文定位字段。页面接入、真实双浏览器 RLS 验收和用户可见“已同步”状态尚未完成，不能承诺跨设备恢复。

正式产品的已决策目标是“个人云书库”：登录用户在首次清晰同意后，后续自导入 EPUB/PDF 自动进入其私有云书库；新设备登录后无需重新导入即可按需打开，书架、元数据、进度、摘录、阅读统计、世界书库收藏和相关设置同步恢复。默认模式采用私有托管加密以优先保证无感访问；需要服务端不可读正文的用户可选择高级端到端加密模式，并接受首次新设备恢复码或已登录设备确认。当前云端同步尚未完成上述范围，清除站点数据前必须导出本地阅读数据，界面不得承诺跨设备自动访问。对象存储、密钥、配额、删除和验收规则见 `docs/user-data-sync-architecture.md`。

### 当前内测 MVP 的交付边界

本轮按“可真实试用，而非一次完成所有长期能力”推进。内测必须可用：本地 EPUB/PDF 导入、原书封面、阅读与翻页、位置恢复、划词翻译/解释、用户主动选色的摘录、多译本对照、合规世界书库检索和收藏、邮箱魔法链接，以及稳定账户之间的书架元数据、进度、摘录和必要偏好同步。

当前内测中的同步后本地导入书在第二台设备只能显示为“需重新导入原书”：它保留书目和阅读数据，但不能伪装成已拥有正文或可打开的离线书。这是内测降级而非正式产品体验目标。匿名会话继续完全本机化。内测验收前必须在两个独立浏览器 profile 中验证 RLS、断网重放、幂等和删除墓碑。

本轮不交付：原书加密云备份、恢复码与配额；Google/Apple 登录和匿名迁移；平台自有/授权正文的运营发布、下载与权益交付；原生客户端、订阅支付、复杂冲突界面和完整全球界面语言包。中英文是当前可切换界面语言；AI 理解语言仍支持全球可搜索选择。该范围是路线图中的优先级约束，不代表延后能力被删除。

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
| 世界书库 | src/lib/world-library.ts、src/components/WorldLanguagePicker.tsx、src/App.tsx、worker/index.mjs | 用户主动发起的合规书目检索、全球语言列表与可搜索本地化选择器、以作品聚合的多语种版本筛选、主题推荐、来源/可读性标注、联网收藏的本地持久化，以及已审核平台目录投影 | `WORLD_CATALOG_SOURCES` 是浏览器回退的数据源注册点；Worker 目录合并还可读取仅含书目投影的 `PLATFORM_CATALOG_JSON`。每个适配器必须显式输出来源、来源记录 ID、外链和 `access.mode`，并在接入前完成条款、限流、来源与版权审查；当前启用 Open Library（`catalog_only`）和 Google Books（按 `viewability` 映射为 `catalog_only`、`preview` 或 `public_domain`）。平台目录记录必须与私密 `PLATFORM_CONTENT_ACCESS_JSON` 中的相同 `editionId` 策略匹配，否则不可展示为应用内版本；目录中不得出现对象键、文件 URL、正文、授权数据或从第三方“免费”标签推断出的分发权。每个来源请求必须有超时和失败回收，禁止让书库永久停在加载状态。Google Books 的语言筛选仅对有 ISO 639-1 映射的语言生效，无法映射时不混入未筛选结果。`WORLD_LANGUAGE_CODES` 是可扩展的 ISO 639-3 代码集，名称由 `worldLanguageName` 用 `Intl.DisplayNames` 显示；选择器禁止展示无法解释的裸代码。后续 Work resolver 必须保存原题、作者、别名、原著语言和 `is_original`；无语言筛选时汇总同一作品的版本并将原著独立强调，指定语言时只返回相符版本；不要把搜索结果伪装为已授权全文，也不要把联网收藏写入 StoredBook 或同步成原始文件 |
| PWA 离线壳 | src/main.tsx、public/manifest.webmanifest、public/sw.js、public/offline.html | 注册 Service Worker、应用安装元数据、静态资源缓存、离线回退和更新激活 | 只缓存应用壳/静态资源；绝不缓存 API、Supabase、原始书籍文件或用户正文 |
| 本地书库 | src/lib/storage.ts | 文件保存、书籍元数据、封面、进度、摘录、导入导出、作品/版本关系，以及按账户隔离的 metadata sync outbox | 个人书库的目标默认按作品聚合，不按语言把同一作品机械拆散：同一 `Work` 下展示自导入、平台和联网收藏的多个版本，原著独立标识并优先推荐界面语言版本；同时提供“按版本”视图及语言、原著、多译本、来源和阅读状态筛选。无法可靠匹配的自导入书保留为未关联单版本，并由用户决定是否关联，不能猜测合并。outbox 不得保存原文件/封面二进制/正文/对象键，且不能与 books 或 book-blobs 混用；修改 StoredBook 或备份格式时兼容旧记录，并补迁移/回归 |
| EPUB 阅读器 | src/components/EpubReader.tsx、src/components/PlatformEpubReader.tsx、src/epub-reader.css | 本地 EPUB 的目录、分页、位置、选区操作；平台 EPUB 的受保护内存阅读 | 本地 EPUB 的位置用 CFI；平台组件绝不调用存储、索引或下载 API，离开后销毁 EPUB.js 资源 |
| PDF 阅读器 | src/components/PdfReader.tsx、src/components/PlatformPdfReader.tsx、src/pdf-reader.css | 本地 PDF 的位置、键盘控制、OCR；平台 PDF 的受保护内存渲染与基本翻页 | 不阻塞翻页；平台组件绝不调用存储或下载 API，离开后销毁 PDF.js 文档；本地 OCR 草稿只有点击确认后才能用于翻译或摘录 |
| 摘录 | src/components/HighlightsView.tsx、src/highlights.css | 列表、搜索、筛选、笔记、颜色、删除 | 保存后要验证刷新与同步语义 |
| 多版本对照 | src/components/EditionComparisonReader.tsx、src/lib/edition.ts | 关联版本、章节/段落对齐、双栏降级 | 不要强制不可靠的句对句同步 |
| AI 客户端 | src/lib/translation.ts、src/lib/explanation.ts、src/lib/ai-result-cache.ts | 调网关、缓存、错误与重试信息 | 浏览器不能保存供应商密钥；仅传选区和必要上下文 |
| OCR 客户端 | src/lib/ocr.ts、docs/ocr.md | 当前 PDF 页转数据并请求 OCR | 只发送用户主动选定的页；不要上传整本书；校正草稿不可自动发给 AI |
| 认证与同步 | src/App.tsx、src/components/AuthPanel.tsx、src/lib/auth.ts、src/lib/remote.ts、src/lib/device-registration-session.ts、src/lib/metadata-sync-engine.ts、src/lib/metadata-sync-edition-shadow.ts、src/lib/sync.ts、supabase/migrations/0008_metadata_sync_foundation.sql、0009_controlled_metadata_sync_rpc.sql | 未登录账户入口的邮箱登录／注册弹窗、匿名/魔法链接会话、最小设备注册 RPC、稳定账户的浏览器设备会话协调、账户隔离 outbox 的顺序 flush、受控远端 mutation/pull 与安全 shadow 投影 | 顶栏账户按钮在未登录时必须打开可关闭、可 Escape 退出的对话框，登录成功后关闭；已登录时才进入设置。设备协调器只在稳定账户且调用方已验证远端配置时读取/创建随机本机 UUID；该 UUID 不得含用户、邮箱、书籍或正文，服务器以 JWT 绑定账户。版本 shadow projector 只能向隔离 store 写入白名单元数据，未知实体不写入，禁止构造 StoredBook 或接受文件/URL/正文；原始书籍不进入同步；匿名会话不得启动同步；同步适配器必须使用与本地存储相同的 IndexedDB schema version；只能调用明确白名单的 RPC，页面接入前先完成真实两设备验收 |
| 个人云书库（待实现） | docs/user-data-sync-architecture.md、未来的 user-files Worker/API 与 Supabase migrations | 已登录用户的书架/阅读数据同步、无感跨设备原书访问，以及可选端到端加密原书备份 | 默认托管加密必须让新设备仅登录即可按需打开文件；高级端到端加密必须明确恢复码/设备确认成本。用户文件与平台正文必须用不同私有 bucket、表、权限和审计流；客户端不保存恢复码或明文密钥到 localStorage |
| 国际化 | src/lib/i18n.ts、src/lib/interface-locale-registry.ts、src/components/ReadingLanguagePicker.tsx 与各组件 | 界面语言和全球 AI 输出语言；界面语言的可用/规划状态、稳定回退与 RTL 方向 | 先读 docs/i18n-extension.md；两种语言配置独立；planned 语言没有完整文案前不得出现在可切换列表 |
| API 与额度 | worker/、api/、server/、supabase/migrations/ | Worker 路由、平台版本访问策略、受保护正文 Range 交付、JWT 校验、额度扣减、目录代理、健康检查 | 密钥仅在环境变量；`/api/reader/access` 只返回策略，`/api/reader/content` 每次复验后才从私有 R2 读取允许的 EPUB/PDF；两者不得返回正文定位信息或对象存储位置；平台动态交付只能经内部 Service Binding resolver 调用 `resolve_platform_reader_delivery`，不得让浏览器或主 Worker 获得 Supabase service-role key；额度操作需服务端原子化 |
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

远端目标：Supabase 保存认证身份、同步元数据、进度、摘录、设置、设备与额度账本；当前尚未完成阅读统计、世界书库收藏和所有设置的跨设备同步。账户资料使用独立于认证与同步数据的受控 `profiles` 字段：只包含经校验的公开昵称、可选简介、头像媒体引用、显式 `is_public` 与时间戳；绝不复制邮箱、真实姓名、设备、私有书架、阅读位置、私人摘录、原书文件、对象键或任何管理员角色。创建/更新/删除仅限 `id = auth.uid()` 的本人；公开读取仅限已明确启用社区主页的最小字段。头像文件进入专用受控媒体桶，以随机对象键与类型/尺寸校验保存；不得将原始文件名、EXIF、长期签名 URL 或认证邮箱写入头像地址、公开资料、日志或缓存。审核和管理操作走服务端能力，不扩张普通浏览器对私有资料的读取范围。正式个人云书库还将通过独立私有对象桶保存登录用户同意同步的自导入文件，使新设备可无感按需访问；当前尚未实现，服务端不得接收用户本地导入的整本书。用户云书库与平台版本必须隔离：前者是账户私有、不可分享的个人文件，后者由 Worker Secret `PLATFORM_CONTENT_ACCESS_JSON` 声明策略；受限平台策略再由 `READER_AUTHORIZATION_URL` 验证会话。只有受控、私有的 `PLATFORM_CONTENT` R2 绑定可被 `/api/reader/content` 读取，且每次请求重新验证后只流式返回允许格式的正文字节，不返回对象键、签名 URL、授权 token 或授权服务响应中的用户数据。`content_licenses`、`content_source_records`、`content_assets` 和审计日志只由服务端运营流程管理，浏览器无读写权。禁止接入、镜像、代理或为任何用户白名单绕过未获授权正文来源；AI 只接收选区与少量上下文，OCR 只接收用户点击识别的当前页。

涉及数据库时，新增 migration 只能向前；所有用户数据表必须有 RLS，并以 user_id 等于 auth.uid() 作为所有权边界。额度、订阅和权限只能由服务端更新。公开资料的可见性是内容展示选择，不是权限系统：不得根据公开昵称、头像、`is_public`、前端状态或 JWT claim 赋予任何审核、客服或平台管理能力。运营人员角色位于 `platform_staff_roles`，不能写入 `profiles`、`user_settings` 或 JWT claims；仅服务端可查询并且撤销必须立即生效。账户层的普通用户不保存角色记录；社区审核员、客服支持员和平台管理员仅可由 `0010_server_owned_account_roles.sql` 的 service-role RPC 授予或撤销。`account_role_assignments` 与其审计日志不向 anon/authenticated 暴露，浏览器不能读取、枚举或写入角色；未来后台必须每次经服务端查询活跃角色，不能信任前端状态或 JWT claims。公开资料上线前须在生产 Supabase 验证 RLS、对象桶策略、头像内容校验、撤销公开状态后的缓存失效，以及普通用户不能枚举未公开资料、角色或任何私有阅读数据。

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
8. docs/known-issues.md，确认没有把已知缺陷误报为已完成。
