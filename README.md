# WorLibrary

一个面向多语言深度阅读的 Web Demo。它展示以下核心体验：

- 本地导入 EPUB、PDF、MOBI 与 CBZ（Demo 仅模拟导入，不读取或上传文件）。
- 同一作品的多个语言版本、版本切换与双栏对照阅读。
- 用户设置“理解语言”后，划线获得翻译与通俗解释。
- 扫描页 OCR、匿名 AI 额度和离线可读状态的产品入口。

## 运行

这是一个 React + TypeScript + Vite 驱动的前端 Demo。首次安装依赖后运行：

```bash
npm install
npm run dev
```

然后访问终端显示的本地地址（默认是 `http://localhost:5173`）。

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

## 当前边界

界面和交互均可演示，但真实文件解析、IndexedDB 离线存储、OCR 和 AI 服务仍未连接。它们是下一阶段的后端与阅读引擎集成工作。
