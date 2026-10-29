# WorLibrary QA 验收矩阵

本文件是发布前的功能基线。QA 不以“按钮存在”为通过条件，而以真实文件、真实内容和可恢复的数据状态为准。

## 执行方式

```bash
npm run qa
```

测试报告写入 `test-results/qa-report.json`，Playwright 的截图、视频和 trace 写入 `test-results/`。

## 本轮内测 MVP 边界

本轮内部技术验收只覆盖本地阅读、合规世界书库、邮箱登录和**元数据**跨设备同步。同步范围为书架元数据、进度、摘录和必要偏好；原 EPUB/PDF、封面二进制和离线正文当前仍在导入设备。另一设备获得本地书元数据时，当前必须显示“需重新导入原书”，且不可启动本地阅读器。匿名试用不创建同步队列。这一条是内部技术验收边界，不是面向正式用户的最终体验。

以下能力明确不作为本轮内部技术验收阻塞项：高级端到端加密/恢复码、Google/Apple 登录、匿名升级迁移、平台自有或获授权内容的运营发布与下载、原生客户端、支付订阅及完整全球界面翻译包。它们仍须在后续各自的安全和合规验收通过后才可开放。用户自导入书的个人云书库无感跨设备访问则是**对外公开试用前的阻塞项**。

## P0：没有通过就不能发布

| 场景 | 通过标准 | 自动化证据 |
| --- | --- | --- |
| EPUB 导入 | 导入真实 fixture 后书库出现文件名派生的书名 | `tests/qa/import-open.spec.ts` |
| 阅读数据备份完整性 | 备份缺少任一本书的原始文件或文件损坏时，导入失败且不写入不可打开的书架记录 | `tests/qa/import-open.spec.ts` |
| EPUB 原书封面 | 导入含嵌入封面的真实 EPUB 后，书架显示该封面而非色块 fallback；刷新后仍可见 | `tests/qa/cover-and-interface-language.spec.ts` |
| 新用户阅读闭环 | 全新浏览器状态可完成带原书封面 EPUB 导入、打开、翻页、划词翻译、保存摘录、刷新恢复，并可中英来回切换界面而不改变理解语言 | `tests/qa/reader-e2e-flow.spec.ts` |
| 真实内容打开 | 阅读器 iframe 出现 fixture 特征文本，而不是演示文案 | `tests/qa/import-open.spec.ts` |
| EPUB 翻页 | 有上/下一页和键盘翻页；翻页后出现下一章节特征文本 | `tests/qa/import-open.spec.ts` |
| 本地文件恢复提示 | 已导入书籍的原始文件被浏览器清理或损坏时，阅读器明确说明原因并提供重试入口，而不是空白页或演示内容 | `tests/qa/import-open.spec.ts` |
| EPUB 阅读偏好恢复 | 字号和主题在刷新、重新打开后保持一致 | `tests/qa/import-open.spec.ts` |
| PDF 导入、打开与翻页 | PDF 渲染真实页面；工具栏、方向键/PageUp/PageDown、Home/End 首末页跳转和页码边界均可用；聚焦工具栏控件时这些快捷键不会误翻页 | `tests/qa/pdf-reader.spec.ts` |
| PDF 阅读偏好恢复 | 字号、主题与缩放在刷新、重新打开后保持一致 | `tests/qa/pdf-reader.spec.ts` |
| PDF OCR 本地校正 | 用户可编辑识别文字并确认；后续翻译请求与保存摘录使用确认后的文字，不会使用未确认草稿 | `tests/qa/pdf-reader.spec.ts` |
| 阅读位置恢复 | PDF 切换到第二页后，刷新及回到书库重新打开都恢复到第二页 | `tests/qa/reader-position.spec.ts` |
| 划词翻译与失败反馈 | EPUB/PDF 选区一出现即自动请求目标理解语言译文；译文浮层锚定选区下方并可关闭；翻译本身不自动着色，只有明确点选颜色才会创建 EPUB 高亮；网关超时、限流、不可用和额度耗尽均给出可理解提示，且仅可重试的错误显示重试 | `tests/qa/import-open.spec.ts`、`tests/qa/reader-e2e-flow.spec.ts`、`tests/qa/pdf-reader.spec.ts`、`tests/qa/ai-feedback.spec.ts` |
| 显式颜色摘录 | 用户在划词浮层选择颜色后，系统立即将其保存为 EPUB 摘录，再以所选高对比度填充色和描边显示；关闭浮层、重新划选、刷新或重开后均保持。不兼容 CFI 必须给出明确提示而不能静默失败。未选择颜色时关闭浮层不得创建高亮 | `tests/qa/reader-e2e-flow.spec.ts` |
| Worker 翻译部署边界 | `/api/translate`、`/api/explain` 仅用 Worker Secret 调用供应商；选区成功/失败均为 `no-store` 并回显 request id；`/api/translation-status` 只报告配置状态且绝不泄露密钥/模型/供应商细节 | `tests/worker-contract.test.mjs`、`scripts/verify-deployment.test.mjs` |
| 生产鉴权与用量账本 | 已验证 JWT 在没有持久化额度适配器时必须于供应商调用前拒绝；适配器以请求 ID 去重、额度耗尽不调用供应商，账本和可观察日志都不得包含划词正文、访问令牌或供应商密钥 | `server/usage-ledger.quality.test.mjs` |
| 界面语言与理解语言分离 | 中/英文界面切换在刷新后保持；切换界面语言绝不修改理解语言，也不会改变翻译请求的 `targetLanguage` | `tests/qa/cover-and-interface-language.spec.ts` |
| 全球理解语言 | 可搜索并选择非默认的全球语言，刷新后保持，选择器使用完整语言名且不展示裸 ISO 代码 | `tests/qa/cover-and-interface-language.spec.ts` |
| 译本关联 | 两本真实导入书籍可以关联到同一 Work | `tests/multiedition.spec.ts` |
| 双栏对照 | 左右栏分别渲染两本真实书籍；没有关联时不能展示 demo | `tests/multiedition.spec.ts` |
| 移动端真实阅读 | 390px 视口导入 EPUB/PDF 后书架、翻页与阅读工具条均可见、可点击且无横向溢出；PDF 上一页/下一页应在阅读页下方的独立触控条中提供，触控高度至少 44px | `tests/qa/mobile-reader.spec.ts` |
| PWA 应用壳 | 生产预览提供 standalone Manifest、图标与已激活的 Service Worker；离线状态明确提示，且不改变本地书库边界 | `tests/qa/pwa-shell.spec.ts` |
| 键盘与辅助技术状态 | 主导航会标记当前页；中英文语言选择会公布选中状态；目录、选区与书籍信息对话框均可用 Escape 关闭；目录、工具栏或 OCR 编辑器获得焦点时，方向键/翻页键不得误翻页，阅读内容区域仍可翻页 | `tests/qa/accessibility.spec.ts` |

## P1：核心阅读体验

| 场景 | 通过标准 | 自动化证据 |
| --- | --- | --- |
| 摘录 | 可保存、编辑、删除，并在刷新后恢复 |
| 进度 | EPUB/PDF 各自保存独立阅读进度；PDF 页码、EPUB CFI 均覆盖刷新后恢复 |
| 页面恢复 | 设置、摘录、我的、世界书库和已导入书籍阅读页刷新后仍停留在对应页面；浏览器前进后退与复制链接保持一致，且不占用认证回调 hash | `tests/smoke.spec.ts` |
| 页面信息层级 | 书库、世界书库、摘录、我的、设置、账户与阅读页均不展示装饰性的英文眉题、编号或微型分类标签；标题、来源、语言、进度和操作的语义信息仍清晰可访问。 | `tests/smoke.spec.ts` |
| 个人书库首页账户布局 | 个人书库首页移除主标题右侧的说明性文案，并将顶部留白收紧；“理解语言”和账户头像/名称与主标题处于同一横向区域。账户仍可打开登录对话框，其他页面仍在右上角提供同尺寸、同间距的入口组。 | `tests/smoke.spec.ts` |
| 已登录账户入口 | 已登录用户的头像打开可 Escape/点击外部关闭的私密账户菜单，可进入账户中心、我的阅读、摘录、同步和隐私入口，并可退出登录；菜单顶端的头像/昵称/私密邮箱摘要点击后进入“我的阅读”个人主页。顶部不显示邮箱，邮箱只在用户自己的私密账户区域显示。 | `tests/smoke.spec.ts` |
| 公开身份资料（进行中） | 用户可设置公开昵称、头像、简介并显式开启/关闭社区主页；默认不公开。`public_profiles` 只投影不透明 `public_id`、昵称、简介、头像存在状态和更新时间；匿名/登录浏览器均没有认证 ID、邮箱、角色、设备、私有书架、阅读位置、私人摘录、原书文件、对象键或私有头像路径的列权限。关闭社区主页立即删除投影。昵称或头像不得用于登录、权限或管理员判断。 | `tests/account-profile.spec.ts` 覆盖迁移和客户端字段边界；待补独立公开主页、按 `public_id` 的头像媒体网关、开关 Playwright 流程及生产双账户隔离验收 |
| 角色与公开资料边界 | 社区审核员、客服支持员与平台管理员只能由 service-role 授予/撤销；浏览器不能读取、枚举或写入角色、审计日志或任意他人私有资料。公开资料字段、前端状态与 JWT claim 均不能决定权限；撤销角色在下一次服务端敏感请求立即生效。 | `tests/account-role-migration.spec.ts`；待补服务端权限路由与生产撤销验证 |
| 离线 | 已导入文件在断网时仍能打开 |
| 数据边界与同步（本轮内部技术验收） | 原始 EPUB/PDF、封面二进制与离线文件暂时留在本机；清除站点数据后原书不能恢复。旧的全表 REST 同步在客户端必须保持关闭；云端同步只在账户隔离 outbox、受控 RPC、墓碑、服务端 revision 与真实跨设备验收完成后启用。不同步项必须明确提示，不能把仅本地的阅读统计、联网收藏或偏好伪装为已同步。个人云书库发布后，该临时限制由“公开试用门槛”行替代。 |
| 会话与同步边界 | 匿名试用不会创建同步队列或上传本地元数据；未登录用户点击顶栏账户入口会在当前页面打开可 Escape/取消关闭的邮箱登录／注册对话框，已登录用户才进入设置；邮箱魔法链接登录后回到发起登录时的书库/阅读器查询参数路由；账户页不得把有限元数据同步称为完整跨设备恢复，且中英文状态文案均取自语言包。 | `tests/contracts.spec.ts`、`tests/qa/accessibility.spec.ts` |
| 浏览器同步设备注册 | 仅稳定账户且已配置受控远端时才读取或创建本机随机 UUID 并调用 `register_sync_device`；匿名或未配置时不触碰设备存储或网络。持久化 UUID 与请求体不含用户身份、邮箱、书籍 ID、文件名或正文；服务端设备响应只投影安全的设备状态。 | `tests/device-registration-session.spec.ts`、`tests/remote-rpc-client.spec.ts` |
| 同步基础数据边界 | 同步设备、变更日志、删除墓碑、键级设置与阅读统计事件均以用户 RLS 隔离；普通浏览器会话不能直接写日志/墓碑/统计聚合，迁移不包含任何 EPUB/PDF blob 或对象键 | `tests/metadata-sync-foundation-migration.spec.ts` |
| 受控元数据同步底座 | RPC 只接受 authenticated 自有未撤销设备的受限 metadata mutation/pull；服务端分配 revision、拒绝陈旧写、保证 operation 幂等并写入墓碑；客户端 outbox 以账户隔离并拒绝二进制、对象定位、数据 URL 和正文。edition 白名单为书名、作者、语言、进度、位置、文件名/类型/大小和安全封面色（这些是文本/数值 metadata，不是原书文件）；阅读进度只含版本 ID、进度与位置；偏好只含 `reader.layout` / `reader.language`。摘录另走 `0012` 的专用 RPC，只接收 `edition_id`、选区文本、位置、笔记、`gold`/`rose`/`blue` 与是否显示高亮，并再次验证本人活跃设备。任何 RPC 均不能接收 EPUB/PDF 或封面二进制、对象键、URL 或整本正文。change-feed 拉取只允许稳定账户，分页 sequence 必须严格递增；调用方拒绝未知/不安全 payload 时不得推进游标。edition 变更仅可投影到账户隔离的 `needsReimport` shadow；未知 entity 不得写入 shadow。迁移 `0016` 修复递归 payload guard 对 JSON 标量 leaf 抛 `case not found` 的缺陷。 | `tests/controlled-metadata-sync-migration.spec.ts`、`tests/private-highlight-sync-migration.spec.ts`、`tests/remote-rpc-client.spec.ts`、`tests/metadata-sync-outbox.spec.ts`、`tests/metadata-sync-engine.spec.ts`、`tests/metadata-sync-edition-shadow.spec.ts` |
| 页面写入与受控同步衔接（当前阶段） | 稳定已登录账户的本地导入、书目校正、成功持久化的 EPUB/PDF 阅读进度，以及成功保存、改色、改笔记或删除的私有摘录都会在本地事务成功后进入账户隔离 outbox；账户变化会使旧意图/旧运行失效，后台失败不得回退或阻塞本地阅读。同一账户按顺序 flush，成功后才按严格递增 revision 拉取。同一账户同一 entity 的连续 pending upsert 必须合并为最早基线/操作 ID 与最新安全 payload；已发送操作须由本地 lease 精确 claim，回执只能确认该 claim，后续本地编辑必须保留为新 pending 操作并重基到回执 revision。网络失败保留 outbox 并按有限指数退避重试，断网时由 `online` 事件触发重放；登出和账户切换会取消旧账户运行与重试定时器。未知/不安全 payload、非暂时 RPC 错误不推进 pull cursor。本地阅读仍可继续，不能以失败回退覆盖本地未确认改动。远端书籍 shadow 仍作为账户隔离、不可点击的“需重新导入原书”卡片展示；只有用户手选 EPUB/PDF 且格式、文件名、字节大小精确匹配时，才创建本地可读副本。远端私有摘录 shadow 仅限同账户、同版本的文本/位置/笔记/颜色/显示状态，不授予书籍文件读取权。本地书籍删除成功后会先排入本书摘录的空 payload 删除，再排入仅含 `editionId` 与 revision 的空 payload edition tombstone；它只删除当前设备文件，服务端 tombstone 会拒绝旧设备的版本 upsert。阅读偏好只允许 `reader.layout` 与 `reader.language`，按账户缓存和恢复，界面语言不随云端变化。所有 EPUB/PDF、封面二进制、对象键、URL 与整本正文均不得进入 metadata RPC 或同步投影；摘录选区文本只经专用私有 RPC 发送。 | `tests/reading-progress-storage.spec.ts`、`tests/metadata-sync-edition-intent.spec.ts`、`tests/metadata-sync-highlight-intent.spec.ts`、`tests/metadata-sync-preference-intent.spec.ts`、`tests/metadata-sync-preference-shadow.spec.ts`、`tests/metadata-sync-retry.spec.ts`、`tests/metadata-sync-runtime.spec.ts`、`tests/metadata-sync-engine.spec.ts`、`tests/metadata-sync-coordinator.spec.ts`、`tests/private-highlight-sync-migration.spec.ts`、`tests/remote-book-metadata-shadows.spec.ts`、`tests/remote-book-shadow-reimport.spec.ts`、`tests/remote-shadow-shelf-ui.spec.ts` |
| 阅读偏好页面接线 | 稳定登录账户修改主题、字号、PDF 缩放或理解语言后，只有 `reader.layout` / `reader.language` 的白名单 payload 可入队；远端应用先持久化账户专属缓存，且切换账户后恢复目标账户缓存或安全默认值。匿名、登出与界面语言不得触发该同步。 | `tests/metadata-sync-preference-intent.spec.ts`、`tests/metadata-sync-preference-shadow.spec.ts`；契约通过 |
| 内测元数据同步闭环（真实项目阻塞） | 两个独立浏览器 profile 使用同一稳定测试账户后，书架元数据、进度、摘录/笔记/颜色和必要偏好双向恢复；另用第二账户验证 UI、change feed、RPC 和可读表均不能跨账户读取/写入。匿名会话无设备注册、RPC 或 outbox。断网重放按序提交且同一 operation ID 只应用一次；账户切换/登出阻止旧运行继续 flush、pull、写 revision/cursor 或重试，但保留旧账户队列供其重新登录后恢复。revision 或 shadow 持久化失败时 cursor 不前进，cursor 写失败显式失败；删除墓碑拒绝旧设备用相同 entity ID 复活数据。远端本地书只显示“需重新导入原书”且无法打开；RPC 不得携带 EPUB/PDF 或封面二进制、对象键、URL 或整本正文。具体步骤见 [`docs/runbook.md`](runbook.md#真实-supabase-双-profile-验收步骤)。 | **2026-10-28：BLOCKED。**更新凭据后账户 A/B 登录、设备注册和 change-feed 拉取成功；真实 edition upsert 返回 SQLSTATE `20000` / `case not found`（request ID `01a17e3c-e328-797d-91a5-76ef80fa61a9`）。已添加 scalar-guard migration `0016` 和契约回归测试，但 staging 尚未应用；因此书架/进度/摘录/偏好同步、RLS、匿名、重试、cursor、切换和 tombstone 仍未通过。没有截图；脱敏 RPC 记录见 `docs/evidence/staging-sync-2026-10-28.json`。 |
| 个人云书库（公开试用门槛） | 用户首次明确同意后，后续自导入 EPUB/PDF 自动进入其账户私有云书库；设备 B 只在本人 metadata shadow 与 active manifest 同时存在时显示“云端可恢复”。按块恢复先保留临时分块，最终文件大小及 SHA-256 与本人 manifest 匹配后才写入 OPFS/IndexedDB；同长度哈希不符会拒绝恢复、清除该 manifest 的临时分块，并让下一次尝试从受控网关重新下载，失败不得产生半成品或宣称同步完成。P0 是私有对象存储，不宣称应用层加密、解密或密钥管理。 | `0014`/`0015`/`0017`、`src/lib/user-file-library.ts` 与 `tests/user-file-library.spec.ts` 覆盖 manifest、分块、最终哈希、临时恢复、配额、过期回收与删除墓碑的代码/合约边界；真实 Supabase/R2 上传/恢复、双账户 RLS 隔离与双设备验收**NOT VERIFIED**。发布前必须验证对象私有、RLS、无长期对象 URL/密钥泄露、删除后拒读与设备 B 恢复。 |
| 世界书库代理 | Cloudflare `/api/catalog` 可在用户浏览器不直连上游的情况下返回来源、访问状态与书目记录；上游全部不可达时应有限时失败提示，且不缓存错误。每次手动部署后 GitHub Runner 必须对实际 Worker 执行一次目录探针，验证响应来源、请求 ID 与短期公共缓存策略。 | `scripts/verify-deployment.mjs`、GitHub Actions |
| 排版 | 字号、主题、目录和阅读进度显示正常 |
| 本地书籍管理入口 | 已导入书籍在“我的书库”右键菜单提供封面刷新、上传封面、编辑信息和删除；设置页与书库页面均不展示独立的管理区 | `tests/smoke.spec.ts` |
| 书籍导入入口 | 书库顶部不显示重复的“＋ 导入”控件；用户仍可通过书架内“导入我的书”卡片及阅读器内导入入口选择 EPUB/PDF | `tests/smoke.spec.ts` |
| 世界书库 | 用户主动搜索开放书目后能看到明确来源；可通过可搜索、键盘可访问的全球语言选择器筛选（按当前界面语言显示完整名称，绝不显示裸 ISO 代码）、优先筛选拥有多语言记录的作品，并展示来源提供的语言/版本计数；收藏条目会出现在“我的书库”并标为联网收藏；主题推荐应标明其策展性质；不得把条目伪装成可下载的未授权正文 | `tests/smoke.spec.ts` |
| 作品级检索与原著发现（进行中） | 数据层只会基于来源明确提供的同源 `sourceWorkId` 聚合版本；缺失标识或跨来源的同名记录必须保持独立。聚合结果支持按界面语言排序、指定语言和仅原著筛选，并保留原著元数据。页面尚未渲染 Work 卡、原题/译名/别名检索或显著原著标识。 | `tests/world-library-work-first.spec.ts`；后续补 Worker resolver 和端到端多语言排序/原著搜索 Playwright 验收；不得因未知的作品关系自动合并用户自导入书。 |
| 个人书库的作品/版本视图（待实现） | 默认“按作品”展示：同一作品下归纳自导入、平台和联网收藏的各语言版本，显示原著、来源、离线/在线/来源阅读等真实状态，并以界面语言版本作优先推荐；用户可切换“按版本”，并以语言、原著、多译本、来源和阅读状态筛选。无法可靠匹配的自导入书作为未关联单版本保留，只有用户确认时才关联。 | 待实现后补存储迁移、关联/撤销关联、筛选、两种视图和旧数据兼容验收。 |
| 世界书库数据源边界 | Mock Open Library 与 Google Books 搜索后检查结果标有正确来源和访问状态；加入我的书库后，收藏保存 `sourceId`、`sourceRecordId`、外链与 `access.mode`；旧收藏仍能恢复；上游请求超时后必须退出加载态并允许再次搜索。已审核平台目录条目必须同时存在匹配访问策略，才可生成 `platformEditionId`、在 WorLibrary 内打开；没有策略的“免费”联网条目必须被排除或保持来源书目。 | `tests/qa/world-language-discovery.spec.ts`、`tests/worker-contract.test.mjs`；每新增适配器必须补相同来源/访问权验收。不得出现下载、导入正文或把书目页表示为可阅读全文的入口；目录响应不得泄露对象键、签名 URL、正文或授权信息；来源失败不泄露或替换为未审核来源 |
| 平台内容与书架权限边界 | 本地导入、平台版本与外部目录收藏必须在数据模型中分离；用户书架可显示“可离线阅读、在线阅读、限量预览、来源阅读、仅书目记录”等真实状态。已收藏的平台版本可进入 WorLibrary 平台阅读页；尚未配置交付时必须清晰失败，不能跳转第三方、伪造正文或下载入口；已配置 EPUB/PDF 只在当前会话内存中渲染和基本翻页，不写入本地书库、对象 URL 或持久缓存；平台阅读停留时长以 `platform:<editionId>` 保存到本地统计并可在“我的”最近阅读中重新打开，但只保存书目元数据与时长，绝不保存正文、阅读位置、交付 URL 或授权信息；平台私有对象键和用户权益不得被浏览器读取或写入 | `tests/platform-catalog-migration.spec.ts`、`tests/qa/world-language-discovery.spec.ts` |
| 平台阅读访问与私有交付 | `/api/reader/access` 只输出访问策略及允许的媒体类型；受限版本缺少会话、授权服务或授权时失败关闭，且响应绝不包含正文、对象键、签名 URL 或令牌。`/api/reader/content` 必须在每次 GET/HEAD 重新验证授权，只服务 stream/preview 的私有 R2 EPUB/PDF，正确处理单段 Range、`private, no-store` 与 416，且无下载交付 | `tests/worker-contract.test.mjs`、`tests/qa/world-language-discovery.spec.ts` |
| 平台内容运营控制 | 许可、来源审核、SHA-256、私有对象、地区策略和发布审计必须关联；浏览器不能读写许可/来源/审计/资产、员工角色或目录与权益管理数据；仅 service-role 可受控发布、下架或撤销许可 | `tests/platform-content-operations-migration.spec.ts`、`tests/platform-delivery-resolution-migration.spec.ts` |
| 平台动态交付解析 | 投产的内部 resolver 必须依据发布状态、许可、来源哈希、地区和权益，在每次访问时解析交付；主 Worker 使用私有 R2 读取正文，浏览器响应、缓存及日志绝不含对象键；数据库下架或许可撤销后下一次正文请求失败关闭 | `tests/platform-delivery-resolution-migration.spec.ts`；上线前补真实 resolver 端到端验收 |

## 竞品基线

- Readwise Reader：导入 EPUB/PDF、分页或滚动阅读、划线、批注与同步。
- Kindle / Kobo：明确翻页、进度、字号、词典、划线和笔记。
- LingQ：导入内容、词汇状态、上下文翻译和学习记录。

本项目先达到 P0，再扩展全文翻译、自动章节对齐、词汇本、TTS 与更多格式。

## QA 闭环

1. QA runner 执行 P0/P1 并输出结构化报告。
2. 主 Agent 根据失败场景分配给阅读器、存储、AI 或部署 Agent。
3. 修复后必须先跑失败用例，再跑完整 QA。
4. P0 任一失败，禁止合并到 `main`。

## 当前自动化覆盖边界

- 自动化 fixture 只包含可公开测试的最小 EPUB/PDF 内容；不提交受版权保护的完整书籍。
- `reader-position.spec.ts` 验证浏览器本地持久化，而非跨设备同步。清除站点数据后位置丢失属于预期，需要通过导出/导入恢复。
- `mobile-reader.spec.ts` 覆盖窄屏基础可用性，仍需在发布前用真机及 Safari/Android Chrome 进行一次人工体验验收。
