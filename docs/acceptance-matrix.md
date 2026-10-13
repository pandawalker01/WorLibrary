# WorLibrary QA 验收矩阵

本文件是发布前的功能基线。QA 不以“按钮存在”为通过条件，而以真实文件、真实内容和可恢复的数据状态为准。

## 执行方式

```bash
npm run qa
```

测试报告写入 `test-results/qa-report.json`，Playwright 的截图、视频和 trace 写入 `test-results/`。

## P0：没有通过就不能发布

| 场景 | 通过标准 | 自动化证据 |
| --- | --- | --- |
| EPUB 导入 | 导入真实 fixture 后书库出现文件名派生的书名 | `tests/qa/import-open.spec.ts` |
| 阅读数据备份完整性 | 备份缺少任一本书的原始文件或文件损坏时，导入失败且不写入不可打开的书架记录 | `tests/qa/import-open.spec.ts` |
| EPUB 原书封面 | 导入含嵌入封面的真实 EPUB 后，书架显示该封面而非色块 fallback；刷新后仍可见 | `tests/qa/cover-and-interface-language.spec.ts` |
| 新用户阅读闭环 | 全新浏览器状态可完成带原书封面 EPUB 导入、打开、翻页、划词翻译、保存摘录、刷新恢复，并可中英来回切换界面而不改变理解语言 | `tests/qa/reader-e2e-flow.spec.ts` |
| 真实内容打开 | 阅读器 iframe 出现 fixture 特征文本，而不是演示文案 | `tests/qa/import-open.spec.ts` |
| EPUB 翻页 | 有上/下一页和键盘翻页；翻页后出现下一章节特征文本 | `tests/qa/import-open.spec.ts` |
| EPUB 阅读偏好恢复 | 字号和主题在刷新、重新打开后保持一致 | `tests/qa/import-open.spec.ts` |
| PDF 导入、打开与翻页 | PDF 渲染真实页面；工具栏、键盘和页码边界均可用 | `tests/qa/pdf-reader.spec.ts` |
| PDF 阅读偏好恢复 | 字号、主题与缩放在刷新、重新打开后保持一致 | `tests/qa/pdf-reader.spec.ts` |
| PDF OCR 本地校正 | 用户可编辑识别文字并确认；后续翻译请求与保存摘录使用确认后的文字，不会使用未确认草稿 | `tests/qa/pdf-reader.spec.ts` |
| 阅读位置恢复 | PDF 切换到第二页后，刷新及回到书库重新打开都恢复到第二页 | `tests/qa/reader-position.spec.ts` |
| 划词翻译与失败反馈 | 真实 EPUB 选区出现翻译入口；网关超时、限流、不可用和额度耗尽均给出可理解提示，且仅可重试的错误显示重试 | `tests/qa/import-open.spec.ts`、`tests/qa/ai-feedback.spec.ts` |
| 生产鉴权与用量账本 | 已验证 JWT 在没有持久化额度适配器时必须于供应商调用前拒绝；适配器以请求 ID 去重、额度耗尽不调用供应商，账本和可观察日志都不得包含划词正文、访问令牌或供应商密钥 | `server/usage-ledger.quality.test.mjs` |
| 界面语言与理解语言分离 | 中/英文界面切换在刷新后保持；切换界面语言绝不修改理解语言，也不会改变翻译请求的 `targetLanguage` | `tests/qa/cover-and-interface-language.spec.ts` |
| 译本关联 | 两本真实导入书籍可以关联到同一 Work | `tests/multiedition.spec.ts` |
| 双栏对照 | 左右栏分别渲染两本真实书籍；没有关联时不能展示 demo | `tests/multiedition.spec.ts` |
| 移动端真实阅读 | 390px 视口导入 EPUB/PDF 后书架、翻页与阅读工具条均可见、可点击且无横向溢出 | `tests/qa/mobile-reader.spec.ts` |
| PWA 应用壳 | 生产预览提供 standalone Manifest、图标与已激活的 Service Worker；离线状态明确提示，且不改变本地书库边界 | `tests/qa/pwa-shell.spec.ts` |
| 键盘与辅助技术状态 | 主导航会标记当前页；中英文语言选择会公布选中状态；目录、选区与书籍信息对话框均可用 Escape 关闭；目录、工具栏或 OCR 编辑器获得焦点时，方向键/翻页键不得误翻页，阅读内容区域仍可翻页 | `tests/qa/accessibility.spec.ts` |

## P1：核心阅读体验

| 场景 | 通过标准 |
| --- | --- |
| 摘录 | 可保存、编辑、删除，并在刷新后恢复 |
| 进度 | EPUB/PDF 各自保存独立阅读进度；PDF 页码、EPUB CFI 均覆盖刷新后恢复 |
| 离线 | 已导入文件在断网时仍能打开 |
| 同步 | 仅同步元数据和摘录；不把本地原文件误标为已上传 |
| 排版 | 字号、主题、目录和阅读进度显示正常 |
| 世界书库 | 用户主动搜索开放书目后能看到明确来源；可按书目语言筛选、优先筛选拥有多语言记录的作品，并展示来源提供的语言/版本计数；收藏条目会出现在“我的书库”并标为联网收藏；主题推荐应标明其策展性质；不得把条目伪装成可下载的未授权正文 | `tests/smoke.spec.ts` |

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
