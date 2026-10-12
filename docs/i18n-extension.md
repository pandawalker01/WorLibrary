# WorLibrary 国际化扩展手册

这份手册用于新增或维护界面语言，以及维护 AI 的理解/翻译目标语言。界面语言和 AI 输出语言是两套独立配置，不能混用。

## 当前支持范围

| 配置 | 当前值 | 保存位置 | 影响范围 |
| --- | --- | --- | --- |
| 界面语言 | 简体中文、English | localStorage，键为 wor-library-ui-locale | 书库、阅读器、摘录、设置、登录同步、导入导出等可见文案 |
| AI 理解/翻译目标语言 | 中文、English、日本語、Français | localStorage，键为 wor-library-reading-language | 划词翻译、解释与 OCR 文本的输出目标 |

界面语言切换不会改变 AI 输出语言；反过来也一样。新功能必须遵守这一规则。

## 关键代码位置

| 文件 | 职责 |
| --- | --- |
| src/lib/i18n.ts | UiLocale、UI_LOCALES、READING_LANGUAGES、copy 文案语言包与读写函数的唯一来源 |
| src/App.tsx | 读取 uiLocale，将 copy[uiLocale] 注入书库、我的页（含近 7 天阅读轨迹）、设置、导航与 PWA 更新提示；提供设置入口 |
| src/components/EpubReader.tsx | EPUB 阅读器可见文案与划词操作 |
| src/components/PdfReader.tsx | PDF 阅读器、翻页、OCR 与划词操作 |
| src/components/HighlightsView.tsx | 摘录筛选、编辑、删除等可见文案 |
| src/components/AuthPanel.tsx | 登录、匿名试用和同步状态文案 |
| src/components/DataTransfer.tsx | 导入/导出阅读数据文案 |
| tests/qa/ui-language.spec.ts | 界面语言与 AI 理解语言独立、刷新后持久化的核心回归 |

不要在组件中新增硬编码的用户可见文案。先在 i18n.ts 建立键，再从当前语言包读取。

## 新增界面语言的步骤

以下以 Spanish（es）为例。只要按顺序完成即可，不需要重新设计阅读器逻辑。

1. 在 src/lib/i18n.ts 的 UiLocale 联合类型中加入 es。
2. 在 UI_LOCALES 中加入语言选项，例如 value 为 es、label 为 Español。
3. 在 copy 对象新增 es 语言包，键必须与现有 zh-CN 和 en 完全一致。
4. 所有变量文案使用同文件导出的 interpolate(template, values) 函数，不要在组件里字符串拼接。例如“找到 N 本书”应使用语言包中的统一模板和 interpolate。
5. 检查新增或近期修改的组件中是否仍有用户可见硬编码文字；必要时把键补进语言包。
6. 运行类型检查与生产构建。
7. 扩展 tests/qa/ui-language.spec.ts：切换到 es、刷新、确认关键书库/阅读器/设置控件仍可用，并确认 AI 理解语言未被改变。
8. 更新 docs/project-guide.md 的“当前能力”和本手册的支持范围表，再提交代码与文档。

## 新增 AI 理解/翻译目标语言的步骤

1. 在 ReadingLanguage 类型与 READING_LANGUAGES 中加入目标语言。
2. 同时提供每个界面语言下的显示名，例如 zhLabel、enLabel；若将来加入更多界面语言，应将这些名称也纳入语言包。
3. 确认 AI/OCR 服务端允许该目标语言，并在真实环境测试一段文本的翻译和解释。
4. 确认默认值、旧 localStorage 值和无效值回退仍然安全。
5. 补充测试：切换目标语言后刷新仍保持，切换界面语言不改变该值。
6. 更新本手册与 docs/project-guide.md。

## 质量清单

- 页面切换、刷新和重新打开书籍后，语言选择保持。
- 文案切换不改变书籍文件、阅读进度、摘录或 AI 目标语言。
- 英文和新增语言下，按钮仍有可访问名称；不要只依赖图标。
- 失败提示、空状态、确认框、Toast 与 PWA 更新提示也必须本地化。
- 交互状态文案也必须双语维护：例如“已选中”、目录展开/收起、选区关闭、OCR 结果与重试。状态按钮应同步提供 `aria-pressed`、`aria-expanded` 或 `aria-current`，而不是只用颜色表示状态。
- 失败提示、空状态、确认框和 Toast 也必须本地化。
- 日期、数字和复数规则较复杂时，优先引入成熟的 Intl 或 FormatJS 方案，不要手写多语言分支。
