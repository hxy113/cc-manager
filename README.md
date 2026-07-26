<p align="center">
  <h1 align="center">cc-manager</h1>
  <p align="center">Claude Code / Codex CLI 本地会话浏览、整理与备份工具</p>
  <p align="center">
    <a href="https://github.com/hxy113/cc-manager/actions/workflows/ci.yml"><img src="https://github.com/hxy113/cc-manager/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  </p>
</p>

cc-manager 在本机启动一个 Web UI，直接读取 Claude Code 和 Codex CLI 的 `.jsonl` 会话文件。它不代理模型请求，也不接管 CLI 通信。

## 主要功能

- 按 CLI 和工作目录浏览会话，预览用户消息、AI 回复、思考块、工具调用和工具结果。
- 按时间、标题或消息数排序；搜索标题和内容，并支持正则表达式。
- 设置别名、收藏会话、按用户输入快速导航。
- 在对应项目目录中打开 `claude --resume` 或 `codex resume`。
- Fork 会话，或在内置编辑器中删改、插入、重排消息；两者都会另存为新会话，不原地覆盖源文件。
- 导出 Markdown；删除时先复制到项目外的 `trash` 目录。
- 备份到本地目录、Git 仓库和 WebDAV；浏览本地/Git 历史并按三种模式恢复。

完整操作说明见[用户指南](./docs/USER_GUIDE.md)，当前限制见[已知限制](./docs/KNOWN_LIMITATIONS.md)。

## 快速开始

要求：

- Windows 10/11；核心浏览与备份代码可跨平台，但“在 CLI 中打开”目前依赖 Windows `cmd`。
- Node.js 18 或更高版本。
- 本机已有 Claude Code 或 Codex CLI 会话记录。
- 使用 Git 备份时需要安装 Git。

```powershell
git clone https://github.com/hxy113/cc-manager.git
cd cc-manager
npm install
npm start
```

服务默认只监听 `127.0.0.1:17890`，通常会自动打开浏览器；也可以手动访问 `http://localhost:17890`。

指定其他端口：

```powershell
npm start -- 9000
```

运行测试：

```powershell
npm test
```

## CLI

```text
cc-manager ui [port]              启动 Web UI
cc-manager backup                 按当前配置执行一次手动备份
cc-manager backup --init          初始化内部备份 Git 仓库
cc-manager backup --set-remote URL 设置 Git 远程地址
cc-manager backup --first-push    备份并尝试首次推送
cc-manager restore                列出最近备份并提示使用 UI 恢复
cc-manager help                   显示帮助
```

`npm start` 等价于 `cc-manager ui`。CLI 子命令的实现入口是 `server/index.js`。

## 默认行为

| 项目 | 默认值 |
|---|---|
| HTTP 地址 | `http://127.0.0.1:17890` |
| 备份目标 | `local` |
| 自动备份周期 | 1440 分钟（24 小时）；设为 0 可关闭 |
| 本地备份目录 | `~/cc-manager-local-backups/` |
| 内部 Git 工作区 | `~/.cc-manager/backup-workspace/` |
| 元数据与配置 | `~/.cc-manager/meta.json`、`config.json` |

自动备份与手动备份并不完全相同：本地自动备份使用内容寻址同步仓库，按 4 MiB 数据块去重，并用完整清单和回收站记录表达删除；手动本地备份、Git 和 WebDAV 使用完整工作区快照。旧 `.diff-ref` 备份仍可恢复。详见[用户指南的备份章节](./docs/USER_GUIDE.md#备份)。

## 安全边界

- 服务只绑定回环地址并拒绝非 loopback Host，不应放到反向代理或公网后面。
- 普通浏览只读会话；Fork/编辑会写新会话文件，删除会移动源文件，恢复会改写会话目录。
- 恢复前会自动创建安全快照；`full` 模式还会归档原活动目录，不直接删除。
- GitHub token 和 WebDAV 密码只从环境变量读取：
  - `CC_MANAGER_GH_TOKEN`
  - `CC_MANAGER_WEBDAV_PASS`

## 文档

- [文档导航与维护规则](./docs/README.md)
- [用户指南](./docs/USER_GUIDE.md)
- [API 参考](./docs/API.md)
- [架构说明](./docs/ARCHITECTURE.md)
- [开发指南](./docs/DEVELOPMENT.md)
- [已知限制](./docs/KNOWN_LIMITATIONS.md)
- [变更记录](./docs/CHANGELOG.md)
- [贡献指南](./CONTRIBUTING.md)
- [安全策略](./SECURITY.md)

## 许可证

[MIT](./LICENSE)
