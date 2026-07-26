# cc-manager 文档导航

这里的文档按读者和用途分层。除 `CHANGELOG.md` 与 `HANDOVER.md` 外，其他文档描述的都应是**当前版本行为**。

| 文档 | 面向谁 | 内容 | 是否为当前事实来源 |
|---|---|---|---|
| [README](../README.md) | 第一次使用者 | 项目定位、主要能力、快速开始 | 是，保持简洁 |
| [用户指南](./USER_GUIDE.md) | 日常使用者 | UI、会话操作、备份与恢复的完整用法 | 是，产品行为主来源 |
| [API 参考](./API.md) | API 调用者 | HTTP 路由、参数、响应和状态码 | 是，接口主来源 |
| [架构说明](./ARCHITECTURE.md) | 维护者 | 模块、数据模型、数据流、安全边界 | 是，实现主来源 |
| [开发指南](./DEVELOPMENT.md) | 贡献者 | 环境、测试、改动规范、文档维护规则 | 是，工程规范主来源 |
| [已知限制](./KNOWN_LIMITATIONS.md) | 使用者与维护者 | 当前确实存在但尚未解决的限制 | 是，风险与待办主来源 |
| [变更记录](./CHANGELOG.md) | 所有人 | 各版本在当时发生了什么 | 否，属于历史记录 |
| [历史交接纪要](./HANDOVER.md) | 追溯早期背景者 | 2026-07-17 的开发过程和当时状态 | 否，仅作档案 |
| [贡献指南](../CONTRIBUTING.md) | 外部贡献者 | 开发入口、PR 要求、敏感数据规则 | 是 |
| [安全策略](../SECURITY.md) | 安全报告者 | 支持范围、私密报告和安全模型 | 是 |

## 单一事实来源

- 默认配置以 `server/store.js` 的 `DEFAULT_CONFIG` 为准，并同步写入用户指南。
- HTTP 路由以 `server/routes.js` 为准，并同步写入 API 参考。
- 备份与恢复语义以 `server/backup.js` 为准，并同步写入用户指南和架构说明。
- 历史文档不得被用来解释当前行为；如果实现改变，应同时更新相关当前文档和 `CHANGELOG.md`。

## 文档更新检查表

改动以下代码时，至少同步检查对应文档：

| 改动位置 | 必查文档 |
|---|---|
| `server/routes.js` | `API.md`、必要时 `USER_GUIDE.md` |
| `server/store.js` 默认配置 | `USER_GUIDE.md`、`API.md` |
| `server/backup.js` | `USER_GUIDE.md`、`ARCHITECTURE.md`、`KNOWN_LIMITATIONS.md` |
| `server/adapters/*` | `ARCHITECTURE.md`、必要时 `KNOWN_LIMITATIONS.md` |
| `web/index.html` 功能或交互 | `README.md`、`USER_GUIDE.md` |
| CLI 参数 | `README.md`、`DEVELOPMENT.md` |
