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
| 真实内容打开 | 阅读器 iframe 出现 fixture 特征文本，而不是演示文案 | `tests/qa/import-open.spec.ts` |
| EPUB 翻页 | 有上/下一页和键盘翻页；翻页后出现下一章节特征文本 | `tests/qa/import-open.spec.ts` |
| EPUB 阅读偏好恢复 | 字号和主题在刷新、重新打开后保持一致 | `tests/qa/import-open.spec.ts` |
| PDF 导入、打开与翻页 | PDF 渲染真实页面；工具栏、键盘和页码边界均可用 | `tests/qa/pdf-reader.spec.ts` |
| PDF 阅读偏好恢复 | 字号、主题与缩放在刷新、重新打开后保持一致 | `tests/qa/pdf-reader.spec.ts` |
| 阅读位置恢复 | PDF 切换到第二页后，刷新及回到书库重新打开都恢复到第二页 | `tests/qa/reader-position.spec.ts`（当前预期失败：刷新后回到第 1 页，P0 未通过） |
| 划词翻译与失败反馈 | 真实 EPUB 选区出现翻译入口；网关超时、限流、不可用和额度耗尽均给出可理解提示，且仅可重试的错误显示重试 | `tests/qa/import-open.spec.ts`、`tests/qa/ai-feedback.spec.ts` |
| 译本关联 | 两本真实导入书籍可以关联到同一 Work | 待补 |
| 双栏对照 | 左右栏分别渲染两本真实书籍；没有关联时不能展示 demo | 待补 |

## P1：核心阅读体验

| 场景 | 通过标准 |
| --- | --- |
| 摘录 | 可保存、编辑、删除，并在刷新后恢复 |
| 进度 | EPUB/PDF 各自保存独立阅读进度；PDF 页码恢复已有失败回归保护，EPUB CFI 跨刷新恢复仍需单独覆盖 |
| 离线 | 已导入文件在断网时仍能打开 |
| 同步 | 仅同步元数据和摘录；不把本地原文件误标为已上传 |
| 排版 | 字号、主题、目录和阅读进度显示正常 |

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
- `reader-position.spec.ts` 验证浏览器本地持久化，而非跨设备同步。该回归目前故意保留为失败证据：PDF 从第 2 页刷新后会回到第 1 页，修复前不能作为发布通过项。清除站点数据后位置丢失属于预期，需要通过导出/导入恢复。
- 译本关联、双栏真实内容对照和 EPUB CFI 的跨刷新定位仍处于待补状态，不能因现有测试通过而视为已验收。
