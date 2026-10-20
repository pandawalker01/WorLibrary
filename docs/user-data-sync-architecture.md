# 用户数据与原书跨设备同步设计

> 状态：**已决策，待实现**。本文是 Web、桌面和移动端实现用户同步、云备份与恢复时的唯一设计基线；开始相关开发前必须同时阅读 `docs/project-guide.md` 与本文。

## 1. 决策与目标

已登录用户的个人图书馆不应只留在一个浏览器中。WorLibrary 将同步书架、阅读位置、摘录、笔记、阅读统计、偏好和用户**明确启用**的原始 EPUB/PDF 云备份，使用户能够在新设备恢复自己的图书馆。

本设计采用“本地优先 + 结构化数据 Supabase + 加密文件对象存储”的三层模型：

```text
设备本地（可离线阅读）
  ├─ EPUB/PDF 原文件、封面、全文索引
  ├─ 本地写入队列与加密文件缓存
  └─ 立即更新的进度/摘录
            │ 登录后后台同步
            ▼
Supabase Postgres（按 user_id + RLS 隔离）
  ├─ 书架元数据、版本、进度、摘录、笔记、统计、设置
  └─ 文件清单、加密对象版本、上传状态与删除墓碑
            │ 仅服务端签发短期上传/下载能力
            ▼
私有对象存储（Cloudflare R2，非公开桶）
  └─ 用户端到端加密后的 EPUB/PDF 密文分块
```

### 1.1 明确边界

- **用户导入内容**：仅在用户登录后主动开启“加密云备份”时上传；未开启时仍只留在本机。
- **平台内容**：继续使用平台许可、权益和私有 R2 交付链路，绝不混入用户备份桶或用户文件表。
- **外部目录收藏**：只同步书目、来源链接和访问状态，不上传第三方正文。
- **服务端不能读取用户备份正文**：R2 中只保存客户端加密后的密文；Supabase 只保存必要文件清单和密文校验信息。
- **匿名会话不能启用云备份**：必须先升级为稳定账号。匿名会话的本地数据可在升级时迁移至该账号，但不能作为长期备份身份。

## 2. 当前状态与缺口

现有浏览器本地库使用 IndexedDB/OPFS 保存导入文件、书架、进度和摘录；`src/lib/sync.ts` 当前仅尝试同步 `editions` 与 `highlights` 的一部分元数据。它存在以下未完成项：

1. 原 EPUB/PDF、封面和全文索引不上传；新设备无法自动恢复原书。
2. `works`、`reading_progress`、`user_settings`、设备、阅读统计、联网收藏、版本关联和删除墓碑尚未形成完整同步闭环。
3. 现有合并以简单最后写入优先为主，缺少字段级冲突策略、文件版本、离线删除和可观测重试。
4. 云备份开关、存储额度、上传恢复、下载恢复、账户删除和端到端加密尚未实现。

因此，在这些能力完成前，界面必须继续说明“本地优先；导出阅读数据用于备份”，不能承诺跨设备恢复。

## 3. 数据分类、存放位置与生命周期

| 类别 | 例子 | 本地 | Supabase | 私有对象存储 | 同步条件 |
| --- | --- | --- | --- | --- | --- |
| 账户身份 | 用户 ID、邮箱、匿名状态 | 会话缓存 | Auth / profiles | 否 | 登录即有 |
| 书架元数据 | Work、Edition、标题、作者、语言、封面摘要 | 是 | 加密 payload + 最小运维字段 | 可选加密封面对象 | 登录后自动 |
| 阅读数据 | EPUB CFI、PDF 页码、进度、摘录、笔记、颜色、统计 | 是 | 加密 payload + 同步 revision | 否 | 登录后自动 |
| 用户原书 | EPUB/PDF 二进制 | 是 | 仅清单 | 加密分块密文 | 用户显式开启 |
| AI 本地缓存 | 翻译/解释结果与少量上下文 | 是 | 默认否 | 否 | 未来独立设置 |
| 世界书库收藏 | 来源、记录 ID、访问状态 | 是 | 是 | 否 | 登录后自动 |
| 平台书籍正文 | 获授权平台 EPUB/PDF | 会话内存或许可下载副本 | 目录/权益 | 平台私有内容桶 | 由平台许可决定 |

### 3.1 用户文件的永久删除

用户从书库选择“只从此设备删除”时，不影响云备份；选择“从所有设备和云端删除”时，客户端写入墓碑，服务端停止分发该版本并异步删除所有加密对象分块。对象删除完成前，UI 显示“删除处理中”。账户删除需在法定保留例外外删除全部用户数据、文件清单与密文对象，并记录不含正文的操作审计。

## 4. 远端数据模型

现有 `works`、`editions`、`reading_progress`、`highlights`、`user_settings` 与 `devices` 继续以 `user_id = auth.uid()` RLS 隔离。新增迁移必须向前兼容，并增加以下表：

```text
user_file_manifests
  id, user_id, edition_id, plaintext_hash, plaintext_size, media_type,
  encryption_version, wrapped_dek, wrapped_dek_nonce, key_envelope_id,
  chunk_count, active_version, upload_state, idempotency_key,
  deleted_at, created_at, updated_at

user_file_chunks
  id, user_id, manifest_id, manifest_version, chunk_index, cipher_hash,
  ciphertext_size, nonce, object_key (server-only), uploaded_at, deleted_at

sync_changes
  id, user_id, device_id, entity_type, entity_id, operation_id, operation,
  entity_revision, base_revision, payload_ciphertext, occurred_at, tombstone_payload

user_storage_quotas
  user_id, included_bytes, used_bytes, reserved_bytes, updated_at

user_key_envelopes
  id, user_id, envelope_version, recovery_kdf, kdf_salt, kdf_parameters,
  wrapped_account_root_key, wrap_nonce, created_at, revoked_at
```

规则：

- 浏览器可读写自己的书架/进度/摘录等业务行，但 `title`、`author`、`file_name`、封面、阅读位置、摘录、笔记、统计、AI 缓存与文件 hash 都必须进入端到端加密 payload；服务端仅可见用户 ID、随机实体 ID、媒体类型、密文字节数、同步 revision、状态和审计时间。服务端不提供用户私人书架全文搜索；搜索在已解锁客户端本地完成。
- 浏览器**不能**直接读写 `user_file_chunks.object_key`、配额、服务器侧删除状态、key envelope 或其他设备数据。
- 文件分块的对象键只由受控服务端或 Worker 解析；浏览器只能拿到单用途、极短期的上传/下载请求能力，且不得写入 IndexedDB、日志或 URL 查询参数。
- `sync_changes` 是逻辑变更日志，不保存全文、文件名以外的敏感正文或 AI 选区；同步确认后可按保留期压缩。
- 所有写入需附带设备 ID、UUID `operation_id` 和每实体单调递增的 `entity_revision`；RLS、唯一约束与事务负责拒绝跨用户、重复操作、重复分块和陈旧版本覆盖。`(manifest_id, manifest_version, chunk_index)`、`(user_id, operation_id)` 与 `(user_id, idempotency_key)` 必须唯一。

## 5. 加密与密钥管理

### 5.1 加密方案

1. 客户端为每个用户备份版本生成随机 256-bit 数据密钥（DEK）。
2. EPUB/PDF 在客户端分块（建议 8 MiB），每块使用 AES-256-GCM 加密，独立随机 IV；上传密文、cipher hash、大小和分块序号。
3. 文件明文 SHA-256 只用于用户自身去重与恢复校验；不得作为公共可枚举索引或跨用户去重键。
4. DEK 以用户主密钥（KEK）包装；Supabase 与 R2 仅保存包装后的 DEK、加密算法版本和必要元数据，永远不保存明文 DEK。

### 5.2 主密钥与恢复

WorLibrary 使用魔法链接，不假定用户具有可用于派生密钥的账户密码。启用云备份时，客户端生成随机 256-bit **账户根密钥（ARK）** 与高熵恢复码：

1. ARK 只保存在已解锁设备的安全存储中：Web 使用不可导出的 WebCrypto `CryptoKey` / 包装后的 IndexedDB 记录，桌面/移动使用系统 Keychain/Keystore；不得放入 localStorage。
2. 恢复码经经过安全评审的 KDF（首选 Argon2id；WebCrypto 受限平台必须使用参数受控的 PBKDF2-SHA-256）派生 KEK，包装 ARK，形成 `user_key_envelopes` 中唯一可跨设备恢复的密钥信封。
3. 新设备先完成 Supabase 魔法链接登录，再输入恢复码解开 ARK，之后才可解开各文件 DEK 并下载密文分块。另一台已解锁设备也可通过短时、双端确认的设备配对流程添加新设备；该流程不得把 ARK 放入 URL、推送内容或服务端日志。
4. 用户可创建新的恢复码；轮换会新增 envelope 并废弃旧 envelope。被盗设备可从设备列表撤销，其 JWT 刷新与后续文件能力必须立即失效；已下载的本地密文/明文无法被远程抹除，应在产品中明示。

遗失恢复码且没有另一台已解锁设备时，平台无法恢复用户原书。该限制必须在开启云备份前明确展示。不得以服务端保管通用解密密钥来换取便利。

> 具体 KDF 参数、WebCrypto 兼容性、密钥轮换和原生安全存储必须在实现前完成安全评审与跨端互操作测试；不得自行发明密码算法。

## 6. 同步协议与冲突策略

### 6.1 登录、初始化和上传

```text
本地匿名/已登录书架
  → 用户登录或升级账号
  → 选择“保留本机资料并同步”
  → 以不透明游标拉取云端 change feed / snapshot watermark
  → 合并元数据与阅读数据
  → 若用户已开启云备份，排队加密、分块、可恢复上传
  → 服务端原子提交 manifest，再把版本标为 active
```

上传中断不能暴露或激活半份文件：未完成 manifest 仅为 `uploading`，过期分块由后台回收。`initiate`、每块上传、`complete` 与取消均需 UUID 幂等键；同一 `manifest_version` 只能从 `uploading → verifying → active` 单向迁移。上传完成后，新设备通过 manifest 获取下载能力，逐块校验、解密并写入其本地 OPFS/沙盒。

### 6.2 合并规则

| 实体 | 冲突策略 |
| --- | --- |
| 阅读位置/进度 | 先比较服务端分配的 `entity_revision`，再用服务端 `occurred_at` 解决同 revision 的竞争；客户端时间只用于展示。若两个设备都前进，保留更靠后的有效位置，并保留另一条变更供诊断。 |
| 摘录、笔记 | 以稳定 ID 合并；删除使用墓碑优先于旧更新；同一笔记并发编辑保留两个修订版本，提示用户选择。 |
| 书架与版本元数据 | 以服务端 revision 合并；标题/作者人工编辑冲突保留双方加密修订并提示。 |
| 原文件 | 文件内容以 `content_hash + manifest version` 标识，不进行字节级合并；同名不同内容并存为两个版本。 |
| 删除 | 墓碑跨设备至少保留 30 天，防止离线旧设备重新上传已删除内容。超过保留期返回的旧设备必须先全量 snapshot 再写入；其陈旧操作拒绝且不允许 resurrection。 |

本地写入永远先完成，网络失败进入持久化队列并采用带抖动的指数退避；不会因同步失败阻塞翻页、划线或导入。

## 7. 服务端与对象存储接口

浏览器不直接获得 R2 长期凭据。新增 Worker API 需要使用已验证 Supabase JWT，并在每个请求验证 `user_id` 与 manifest 的所有权：

| 路由 | 职责 | 安全要求 |
| --- | --- | --- |
| `POST /api/user-files/initiate` | 创建上传会话、原子预留配额、返回分块上传能力 | 验证 JWT issuer/audience/expiry/JWK、登录、设备未撤销、配额、文件类型/大小限制、幂等键、无对象键泄露 |
| `POST /api/user-files/:id/chunks/:index` | 接收或代理单块密文 | 能力绑定 user/device/manifest/version/index/hash/单次有效期；顺序/哈希/大小校验、`no-store` |
| `POST /api/user-files/:id/complete` | 核验所有分块并激活 manifest | 原子提交、审计、失败关闭 |
| `GET /api/user-files/:id/chunks/:index` | 受控下载单块密文 | 每次 JWT/RLS 所有权校验、范围/速率限制、`private, no-store` |
| `DELETE /api/user-files/:id` | 创建全局删除墓碑、撤销未使用能力与异步清理任务 | 幂等、恢复窗口、部分失败重试与可见状态 |
| `GET /api/sync/changes` | 拉取当前用户变更 | 不透明游标、snapshot watermark、分页、无正文/对象键；游标过期时要求全量 snapshot |

对象存储使用与平台内容分离的私有 bucket，例如 `USER_BACKUPS`；禁止 public bucket、静态域名、跨用户对象键猜测、CDN 公共缓存和浏览器直连长期 token。服务端日志只记录请求 ID、用户/设备匿名化标识、字节数和结果，不记录正文、密钥、对象键或恢复码。

## 8. 配额、成本与产品交互

- 开启云备份前显示目前已用、本次预计上传量、套餐/免费额度、是否仅 Wi-Fi 上传，以及恢复码风险。
- 默认可设置单文件上限、总配额与月度上传限制；服务端在 `initiate` 的同一事务中预留字节，完成/取消/超时回收后结算。预留必须有到期时间，且同用户同 hash 的已存在密文版本才可复用；不得跨用户去重。
- 用户可以分别选择：同步阅读数据、备份原书、仅 Wi-Fi、自动下载最近阅读书籍、删除云备份但保留本机文件。
- 新设备先恢复书架与进度，再按需下载书籍；不能因为登录就自动消耗大量流量或存储空间。
- 文件本身可能受版权或服务条款限制。开启备份仅面向用户拥有合法副本的个人私有备份，不代表平台获得分发权，也不允许共享、公开链接或跨账户转让。

## 9. 分阶段实施与验收

### 阶段 A：完整元数据同步

补齐现有同步表、变更日志、设备 ID、阅读统计、世界书库收藏、设置、删除墓碑与冲突 UI；不上传原文件。

验收：两台设备登录同一账号后，进度、摘录、笔记、统计与书架元数据可恢复；网络中断不丢本地写入；不同账号互不可见。

### 阶段 B：加密云备份基础

实现恢复码、WebCrypto 分块加密、私有对象桶、manifest、可恢复上传、额度预留与新设备按需下载。开始编码前先完成一份协议附录：KDF 参数、cipher envelope 二进制格式、nonce 规则、JWT 验证、设备撤销、变更游标、状态机、对象回收 SLA、RPO/RTO 与威胁模型。

验收：用公开测试 EPUB/PDF 验证上传中断续传、换设备恢复、密文对象不可直接打开、错误恢复码无法解密、清除新设备数据后可重新恢复。

### 阶段 C：跨端与运营完善

为 Tauri/Capacitor 接入安全密钥存储与原生文件沙盒；增加配额、成本告警、账号删除、密钥轮换、数据导出、审计与灾难恢复演练。

验收：Web、桌面、iOS/iPadOS、Android 均能在网络切换、离线编辑与并发修改后稳定恢复；账户删除在承诺期限内清除结构化数据与加密对象。

## 10. 上线前安全与 QA 清单

- 两个真实账号及匿名会话的 RLS 隔离测试；不得越权读取 manifest、分块或进度。
- 对象桶维持私有；浏览器、公开 URL、日志和错误响应中均无对象键、密钥、恢复码或正文。
- 上传完整性：块大小、总大小、cipher hash、分块数和 manifest 状态均校验；中断、重试、重复和乱序请求不可生成错误 active 文件。
- 恢复完整性：明文 hash、媒体类型和解密认证标签失败时拒绝导入，不污染本地书架。
- 冲突/删除：离线设备、墓碑、恢复窗口、并发笔记编辑和相同文件名不同内容均有自动化回归。
- 费用与滥用：配额预留、速率限制、异常大文件、重复上传、账号删除和对象回收均可观测。
- 平台内容与用户备份完全隔离：不同 bucket、不同权限、不同 API 与不同审计流。
- 威胁模型覆盖恶意客户端、XSS、被盗 JWT/恢复码、替换或回滚密文、失联设备和对象删除失败；验证密钥轮换后旧文件仍可读取，并记录灾难恢复 RPO/RTO。

## 11. 尚待产品确认的项目

实现前必须由产品所有者确定：免费配额与付费方案、单文件/总文件上限、恢复码呈现与遗失政策、是否允许用户关闭端到端加密以换取客服恢复、删除宽限期、支持的备份格式、地区/合规要求，以及首发只支持 Web 还是同时支持桌面和移动端。
