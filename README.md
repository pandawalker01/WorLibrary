# WorLibrary

一个本地优先、可安装的多语言阅读 Web 应用。它提供以下核心体验：

- 本地导入 EPUB 与 PDF，原始文件只保存在当前浏览器设备。
- 同一作品的多个语言版本、版本切换与双栏对照阅读。
- 用户设置“理解语言”后，划线获得翻译与通俗解释。
- 扫描页 OCR、匿名 AI 额度、可安装的离线应用壳与离线阅读状态。

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
- `docs/deployment.md`：PWA 缓存策略、上线与回滚说明。
- `docs/runbook.md`：发布检查、部署预检与故障处理。

## 当前边界

书籍文件、封面、进度与摘录保存在本机的 OPFS / IndexedDB；Service Worker 只缓存应用壳和静态资源，绝不缓存或上传原始书籍。离线时可继续打开已导入书籍，联网后 AI、OCR 与同步功能恢复。真实 AI/OCR 与云端同步仍需按部署文档配置服务端环境变量。

无需云配置也可以部署并使用本地阅读核心。运行 `npm run validate:env -- --staging --json` 可获得机器可读的已关闭能力与缺失项；完整认证、同步、AI/OCR 上线前使用 `npm run validate:env -- --production --json`。AI 网关的健康、翻译与解释响应均禁止共享 HTTP 缓存，保护用户主动发送的选区文本与错误信息。变量分类与安全边界见 `docs/deployment.md`，不要把任意密钥写入 `VITE_*` 或提交 `.env`。
