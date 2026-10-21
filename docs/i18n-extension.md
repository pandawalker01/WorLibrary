# WorLibrary 国际化扩展手册

这份手册用于新增或维护界面语言，以及维护 AI 的理解/翻译目标语言。界面语言和 AI 输出语言是两套独立配置，不能混用。

## 当前支持范围

| 配置 | 当前值 | 保存位置 | 影响范围 |
| --- | --- | --- | --- |
| 界面语言 | 简体中文、English | localStorage，键为 wor-library-ui-locale | 书库、阅读器、摘录、设置、登录同步、导入导出等可见文案 |
| AI 理解/翻译目标语言 | 可搜索的全球语言列表 | localStorage，键为 wor-library-reading-language | 划词翻译、解释与 OCR 文本的输出目标 |

界面语言切换不会改变 AI 输出语言；反过来也一样。新功能必须遵守这一规则。

## 关键代码位置

| 文件 | 职责 |
| --- | --- |
| src/lib/i18n.ts | UiLocale、UI_LOCALES、copy 文案语言包与读写函数的唯一来源 |
| src/components/ReadingLanguagePicker.tsx | 以完整名称显示、搜索和选择全球 AI 理解语言；对外保存稳定英文语言名称，不展示裸 ISO 代码 |
| src/lib/interface-locale-registry.ts | 全球界面语言的可用/规划元数据、回退解析与 RTL 方向；不承载用户可见译文 |
| src/App.tsx | 读取 uiLocale，将 copy[uiLocale] 注入我的书库、世界书库（含来源/版权边界提示）、我的页（含近 7 天轨迹和每本书阅读时长）、设置、导航与 PWA 更新提示；顶栏理解语言弹窗与设置页复用同一全球语言选择器 |
| src/components/EpubReader.tsx | EPUB 阅读器可见文案、阅读主题标签与划词操作 |
| src/components/PdfReader.tsx | PDF 阅读器、翻页、OCR、阅读主题标签与划词操作 |
| src/components/HighlightsView.tsx | 摘录筛选、编辑、删除等可见文案 |
| src/components/AuthPanel.tsx | 登录、匿名试用和同步状态文案；所有可见文本必须取自 `i18n.ts` |
| src/components/DataTransfer.tsx | 导入/导出阅读数据文案 |
| tests/qa/ui-language.spec.ts | 界面语言与 AI 理解语言独立、刷新后持久化的核心回归 |

不要在组件中新增硬编码的用户可见文案。先在 i18n.ts 建立键，再从当前语言包读取。

### 全球界面语言选择器的呈现规则

界面语言设置应使用 `presentInterfaceLocales(uiLocale)` 获得可本地化显示的全球语言清单，而不是在页面中再硬编码两张语言卡。清单必须分为“已支持”和“计划中”两个区域（区域标题、状态说明和“即将支持”标记均来自 `i18n.ts` 的界面文案）。

- 只有 `status: available` 的项目可点击、可保存到 `worlibrary.ui-locale`，也才允许实际切换页面文案。
- `status: planned` 的项目可以作为路线图被看见，但必须禁用，并明确说明其完整翻译与无障碍检查尚未完成；不能制造“已经切换成功”的假象。
- 展示名称应使用注册表的 `displayName` 和 `nativeName`；不要把 `ja`、`ar` 或 `pt-BR` 之类的代码直接作为界面标签。
- 当一项 RTL 语言（例如阿拉伯语）从 planned 升为 available 时，除了完整翻译包外，必须验证 `document.documentElement.dir = 'rtl'` 下的阅读器工具栏、侧栏、表单、焦点环和数字方向；不能仅修改文本。
- 旧版 localStorage 中的 planned 或无效界面语言必须由 `resolveInterfaceLocale` 安全回退到可用语言，且绝不能影响 AI 理解语言。

## 新增界面语言的步骤

以下以 Spanish（es）为例。只要按顺序完成即可，不需要重新设计阅读器逻辑。

1. 先在 src/lib/interface-locale-registry.ts 登记 es，初始状态必须是 planned；它会作为不可切换的路线图项目出现，但不能作为已支持语言。
2. 在 src/lib/i18n.ts 的 UiLocale 联合类型中加入 es，并在 UI_LOCALES 中加入语言选项，例如 value 为 es、label 为 Español。
3. 在 copy 对象新增 es 语言包，键必须与现有 zh-CN 和 en 完全一致；完成版式、无障碍和 RTL（如适用）测试后，才将注册表状态改为 available。
4. 所有变量文案使用同文件导出的 interpolate(template, values) 函数，不要在组件里字符串拼接。例如“找到 N 本书”应使用语言包中的统一模板和 interpolate。
5. 检查新增或近期修改的组件中是否仍有用户可见硬编码文字；必要时把键补进语言包。
6. 运行类型检查与生产构建。
7. 扩展 tests/qa/ui-language.spec.ts：切换到 es、刷新、确认关键书库/阅读器/设置控件仍可用，并确认 AI 理解语言未被改变。
8. 更新 docs/project-guide.md 的“当前能力”和本手册的支持范围表，再提交代码与文档。

## 新增 AI 理解/翻译目标语言的步骤

1. 全球语言选择器由 `ReadingLanguagePicker` 从共享语言代码集生成；不要在设置页重新维护一份固定卡片列表。
2. 确认 AI/OCR 服务端允许该目标语言，并在真实环境测试一段文本的翻译和解释。
3. 确认默认值、旧 localStorage 值和无效值回退仍然安全。
4. 补充测试：搜索并选择非默认语言后刷新仍保持，切换界面语言不改变该值。
5. 更新本手册与 docs/project-guide.md。

## 质量清单

- 页面切换、刷新和重新打开书籍后，语言选择保持。
- 文案切换不改变书籍文件、阅读进度、摘录或 AI 目标语言。
- 不使用仅为装饰服务的英文眉题、序号或微型分类标签；页面标题、说明、来源、语言、进度和可访问名称必须保留其实际信息价值，不能借“精简视觉”删除。
- 英文和新增语言下，按钮仍有可访问名称；不要只依赖图标。
- 失败提示、空状态、确认框、Toast 与 PWA 更新提示也必须本地化；世界书库的来源名称、联网收藏、本地导入、语言筛选、多语种/版本计数、主题推荐与版权边界提示同样属于必须双语维护的可见文案。全球书目语言名称不在语言包中逐项复制：通过 `worldLanguageName(code, uiLocale)` 调用浏览器 `Intl.DisplayNames` 生成。选择器会尝试英文名称回退；若仍不能得到可读名称，则隐藏该项，绝不向用户展示 ISO 代码。
- 世界书库新增来源或访问状态时，来源显示、书目/预览/公共领域状态和失败提示必须同时加入 `i18n.ts` 的中英文语言包；来源自身的名称可保持其官方名称。不能以“公共领域”状态暗示 WorLibrary 托管或下载了正文。
- 交互状态文案也必须双语维护：例如“已选中”、目录展开/收起、选区关闭、自动翻译中的浮层、OCR 结果与重试。EPUB 自动译文浮层应锚定在选区下方；翻译本身不能自动创建颜色标注，颜色按钮必须明确表示当前选择并使用 `aria-pressed`。状态按钮应同步提供 `aria-pressed`、`aria-expanded` 或 `aria-current`，而不是只用颜色表示状态。划词后的自动译文必须始终使用独立保存的 AI 理解语言，不能因界面语言变化而改变目标语言。
- 顶栏理解语言入口必须直接打开可搜索的选择器而不改变当前路由或跳转设置；它显示的语言名与选项名称都使用当前界面语言的 `Intl.DisplayNames` 本地化。存储值仍为稳定的英文名称，以保障既有 AI 请求与用户设置兼容。
- 失败提示、空状态、确认框和 Toast 也必须本地化。
- 账号与同步的状态同样必须从 `i18n.ts` 取值：匿名试用不可称为可云同步，已登录的元数据同步也不可称为完整跨设备恢复；登录回调应保留当前查询参数路由，不能因为语言或认证文案改动而跳回首页。
- 日期、数字和复数规则较复杂时，优先引入成熟的 Intl 或 FormatJS 方案，不要手写多语言分支。
