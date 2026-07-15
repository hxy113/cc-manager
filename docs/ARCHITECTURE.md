# cc-manager 架构文档

本文档面向想要理解、扩展或接手 cc-manager 的开发者。

## 总体架构

```
┌─────────────────────────────────────────────────┐
│  浏览器（前端，纯 HTML+CSS+JS，零构建）           │
│  http://localhost:17890                          │
│  ┌──────────┬──────────────┬──────────────┐    │
│  │ 左栏      │ 中栏          │ 右栏          │    │
│  │ CLI+项目  │ 会话列表+搜索 │ 聊天预览+导航 │    │
│  └──────────┴──────────────┴──────────────┘    │
└────────────────────┬────────────────────────────┘
                     │ fetch /api/...
┌────────────────────▼────────────────────────────┐
│  Node.js 后端（Express，端口 17890）             │
│  ┌──────────────────────────────────────────┐   │
│  │ routes.js  REST API 路由                  │   │
│  ├──────────────────────────────────────────┤   │
│  │ adapters/claude.js  读 ~/.claude/projects│   │
│  │ adapters/codex.js   读 ~/.codex/sessions │   │
│  ├──────────────────────────────────────────┤   │
│  │ store.js   元数据 + 配置 + Markdown 导出  │   │
│  │ backup.js  三路备份 + 恢复 + git 工作区   │   │
│  └──────────────────────────────────────────┘   │
└────────────────────┬────────────────────────────┘
                     │ 读取
┌────────────────────▼────────────────────────────┐
│  本地文件系统                                     │
│  ~/.claude/projects/   Claude Code 会话 (.jsonl) │
│  ~/.codex/sessions/    Codex CLI 会话 (.jsonl)   │
│  ~/.cc-manager/        cc-manager 自身数据        │
│    ├─ meta.json        别名/收藏/fork 元数据      │
│    ├─ config.json      备份配置                   │
│    └─ backup-workspace/ git 版本化备份工作区      │
└─────────────────────────────────────────────────┘
```

## 核心设计原则

1. **只读源数据**：cc-manager 从不写入 Claude/Codex 的会话文件，只读取。唯一的"写"是删除（移到 trash）。
2. **零构建前端**：`web/index.html` 是单文件 SPA，无 webpack/vite，clone 即用。
3. **备份工作区独立 git**：`~/.cc-manager/backup-workspace/` 是独立 git 仓库，与 cc-manager 项目本身的 git 仓库无关，专门用于版本化备份。
4. **恢复前必先备份**：任何恢复操作前，先把当前状态复制到 `~/cc-manager-local-backups/pre-restore-<时间戳>/`。

## 数据流

### 浏览一次会话

```
用户点击会话
  -> 前端 fetch /api/cli/claude/session/<id>?projectName=...
  -> routes.js 转发到 claude.getSessionContent()
  -> 读取 ~/.claude/projects/<projectName>/<id>.jsonl
  -> 逐行 JSON.parse（容错：跳过损坏行）
  -> 返回消息数组
  -> 前端 renderPreview() 渲染（user 蓝/assistant 绿/tool_result 灰）
```

### 备份一次

```
用户点"一键备份" 或 定时器触发
  -> backup.asyncRunBackup()
  -> buildBackupSnapshot()
       -> ensureBackupGit()  确保 workspace 是 git 仓库
       -> 清空 workspace（保留 .git）
       -> xcopy ~/.claude/projects -> workspace/claude-sessions
       -> xcopy ~/.codex/sessions  -> workspace/codex-sessions
  -> 根据 config.backupTarget 执行：
       local  -> doLocalBackup()  复制 workspace 到 ~/cc-manager-local-backups/<时间戳>/
       github -> doGitBackup()    git commit + push
       webdav -> doWebdavBackup() PUT 上传每个文件
       all    -> 三者都跑
  -> workspace git commit（让恢复历史可查）
  -> 返回每路结果 {ok, message, results[]}
```

### 恢复一次

```
用户选 commit + 模式（incremental/merge/full）
  -> backup.restoreFromCommit(hash, cli, mode)
  -> 1. 安全备份：xcopy 当前 ~/.claude/projects 到 pre-restore-<时间戳>/
  -> 2. git checkout <hash> -- .  把 workspace 切到目标版本
  -> 3. copyWithMode(workspace, ~/.claude/projects, mode):
       incremental -> 仅复制目标不存在的文件
       merge       -> 存在覆盖，不存在添加，dest 独有保留
       full        -> 完全覆盖
  -> 4. git checkout -- .  把 workspace 切回当前
```

## 三家 CLI 的数据格式差异

这是项目最复杂的部分，适配器层负责抹平差异。

| | Claude Code | Codex CLI |
|---|---|---|
| 路径 | `~/.claude/projects/<编码路径>/` | `~/.codex/sessions/YYYY/MM/DD/` |
| 项目划分 | 按目录（`D--claudecode` = `D:\claudecode`） | 按日期，需从 jsonl 的 `session_meta.cwd` 反推 |
| 文件名 | `<sessionId>.jsonl` | `rollout-<时间>-<uuid>.jsonl` |
| 消息结构 | `msg.message.content`（string 或 array） | `line.payload.content`（在 response_item 类型行里） |
| 内容块类型 | `text` / `tool_use` / `tool_result` / `thinking` | `input_text` / `output_text` / `tool_use` / `tool_result` |

`codex.js` 的 `normalizeContent()` 把 Codex 格式转成 Claude-like 格式，这样前端和 Markdown 导出可以共用一套渲染逻辑。

## 已知边界与陷阱

### Windows 兼容性（项目主要运行环境）

1. **`execSync` vs `execFileSync`**：`execSync` 在 Windows 上会经过 `cmd.exe`，`%` 和 `|` 会被解释。`runGit` 必须用 `execFileSync('git', args, ...)` 直接 spawn，否则 `git log --format=%H|%ct|%s` 会失败。
2. **跨盘符 rename**：`fs.renameSync` 不能跨盘符（C -> D 报 EXDEV）。删除操作用 `copyFileSync` + `unlinkSync`。
3. **xcopy 而非 cp**：复制目录用 `xcopy /E /I /Q /Y`，这是 Windows 专用。移植到 Mac/Linux 需改成 `cp -r`。
4. **CRLF**：Git 会警告 LF 转 CRLF，无害。

### 活跃会话的并发读取

Claude Code 正在写 `.jsonl` 时，cc-manager 同时读取是安全的：
- jsonl 是追加写入，前面的行不会变
- 最后一行可能不完整，`JSON.parse` 会失败，被静默跳过
- 不影响 Claude Code 继续写入

### 备份工作区的 git

- `~/.cc-manager/backup-workspace/.git` 是独立仓库
- `ensureBackupGit()` 在首次备份时自动 `git init` + 空提交
- 每次备份后 `git add -A && git commit`，让 `listBackupHistory()` 能查到
- 这个 git 仓库和 cc-manager 项目本身的 GitHub 仓库无关

## 开发指南

### 添加新的 CLI 适配器

1. 在 `server/adapters/` 下新建 `<cli>.js`
2. 实现四个函数：`getProjects()` / `getSessions(projectName)` / `getSessionContent(sessionId, projectName)` / `searchSessionText(projectName, query, {isRegex})`
3. `getSessionContent` 返回的消息格式统一为：
   ```js
   { type: 'user'|'assistant', message: { role, content: [...] }, timestamp }
   ```
   content 块类型用 `text` / `tool_use` / `tool_result` / `thinking`
4. 在 `routes.js` 的 `adapters` 对象注册
5. 在 `web/index.html` 的 `renderCliTabs` 加 tab

### 跑测试

```bash
npm test
# 或 node test/run.js
```

测试覆盖：路径编解码、消息提取、Markdown 导出、备份模式逻辑。无外部依赖，纯 Node 内置 `assert`。

### 常见开发陷阱

- **改了后端代码要重启 server**：Node 不会热重载。杀掉端口 17890 的进程再 `npm start`。
- **`runGit` 必须用 `execFileSync`**：不要为了"简单"改回 `execSync`，Windows 上会出诡异问题。
- **`path` / `fs` 要在文件顶部 require**：之前出过 `path is not defined` 的 bug，因为路由里用了 `path.join` 但顶部没引入。
