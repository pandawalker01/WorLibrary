# WorLibrary 协作与文档维护规则

本文件适用于在本仓库工作的所有 Agent 和贡献者。

## 文档是提交的一部分

每次准备创建代码提交时，必须检查这次变更是否改变了功能、模块职责、数据流、配置、运行方式、测试边界或用户可见行为。若改变了，必须在同一个提交中更新对应 Markdown 文档；不能把文档更新留给“以后”。

最低要求如下：

| 变更类型 | 必须检查并按需更新的文档 |
| --- | --- |
| 新增或调整模块、接口、数据存储、同步、AI、OCR、鉴权 | docs/project-guide.md |
| 新增或调整界面语言、翻译目标语言、可见文案 | docs/i18n-extension.md 与 docs/project-guide.md |
| 调整本地开发、环境变量、数据库迁移、部署或回滚 | README.md、docs/runbook.md、docs/deployment.md |
| 新增、删除或改变验收标准 | docs/acceptance-matrix.md |
| 调整里程碑或工作顺序 | docs/development-roadmap.md |

如果经过检查确认无需改文档，提交说明的正文必须写明已检查的文档及原因；若提交说明已固定，必须在交接消息中写明。不要只在本地思考后省略记录。

## 新功能的最小交付

新增或修改用户功能时，必须同时具备：

1. 对应的实现与可访问入口；
2. 至少一条与风险相称的自动化测试；
3. 对项目地图和相关操作手册的更新；
4. 类型检查、生产构建和相关测试通过。

## 先读哪里

开始工作前，先阅读 docs/project-guide.md。涉及界面语言时再阅读 docs/i18n-extension.md；涉及上线、环境变量或数据库时再阅读 docs/runbook.md 与 docs/deployment.md。
