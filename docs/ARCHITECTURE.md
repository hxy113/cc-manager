# cc-manager 架构说明

本文描述当前实现。用户操作见 [用户指南](./USER_GUIDE.md)，HTTP 契约见 [API 参考](./API.md)，尚未解决的设计问题见 [已知限制](./KNOWN_LIMITATIONS.md)。

## 系统边界

cc-manager 是单用户、本机运行的会话文件管理器：

- 输入是 Claude Code 与 Codex CLI 已经写到磁盘的 JSONL 会话；
- 不代理模型 API，不接管 CLI 通信，不读取云端会话；
- 浏览、搜索和导出只读会话；
- Fork/编辑会在原目录写新会话，删除会移动源会话，恢复会改写整个会话目录；
- 备份只覆盖会话目录与 cc-manager 元数据，不是 Claude/Codex 的完整配置备份。

## 运行拓扑

```text
Browser (web/index.html)
        │ same-origin fetch /api/*
        ▼
Express on 127.0.0.1:<port>
        │
        ├─ routes.js ── adapters/claude.js ── ~/.claude/projects
        │            └─ adapters/codex.js  ── ~/.codex/sessions
        │
        ├─ store.js  ── ~/.cc-manager/{meta.json,config.json}
        ├─ backup.js ── ~/.cc-manager/backup-workspace
        │             └─ ~/cc-manager-local-backups
        └─ opencli.js ── Windows cmd + claude/codex executable
```

前端是单文件 SPA，没有构建步骤。后端和文件扫描主要使用同步 Node 文件 API，因此一次请求内的磁盘工作会占用事件循环。

## 模块职责

| 文件 | 职责 |
|---|---|
| `server/index.js` | CLI 参数分发、启动 UI、手动备份、Git 初始化与远程配置 |
| `server/server.js` | Express 初始化、Host 防护、静态资源、错误处理、自动备份定时器 |
| `server/routes.js` | HTTP 参数白名单、适配器分发、状态码和响应结构 |
| `server/store.js` | cc-manager 元数据/配置 JSON、默认配置、Markdown 导出 |
| `server/backup.js` | 工作区快照、Git/WebDAV/本地备份、历史合并、恢复与互斥 |
| `server/opencli.js` | 解析 CLI 路径、校验 ID/工作目录、创建 Windows 终端 |
| `server/adapters/claude.js` | Claude 项目目录解析、会话扫描、标题、搜索、Fork 写回 |
| `server/adapters/codex.js` | Codex 递归扫描、cwd 聚合、格式归一化、Fork 写回 |
| `web/index.html` | 三栏 UI、搜索/排序、预览、编辑器、备份/恢复设置 |

## 数据目录

| 数据 | 默认位置 | 所有者 | cc-manager 行为 |
|---|---|---|---|
| Claude 会话 | `~/.claude/projects/<encoded-project>/*.jsonl` | Claude Code | 读；Fork/编辑写新文件；删除/恢复会改动 |
| Claude 标题回退 | `~/.claude/history.jsonl` | Claude Code | 只读、进程内缓存 |
| Codex 会话 | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` | Codex CLI | 读；Fork/编辑写新文件；删除/恢复会改动 |
| 元数据 | `~/.cc-manager/meta.json` | cc-manager | 读写 |
| 配置 | `~/.cc-manager/config.json` | cc-manager | 读写 |
| Git 工作区 | `~/.cc-manager/backup-workspace/` | cc-manager | 可重建快照，保留 `.git` |
| 本地备份 | `~/cc-manager-local-backups/` | cc-manager | 新建快照与恢复安全副本 |
| 同步对象仓库 | `<localBackupDir>/.cc-manager-sync/objects/` | cc-manager | SHA-256 不可变数据块，只增加，不原地覆盖或删除 |
| 删除回收目录 | 代码仓库上级的 `trash/` | cc-manager | 排他复制后删除源文件 |

`meta.json` 以 `sessionId` 为键，存放 alias、favorite、hidden、forkedFrom、CLI、projectName 和更新时间。它不改变 CLI 原生格式。

## 适配器契约

两个适配器对路由暴露同一组方法：

| 方法 | 返回/作用 |
|---|---|
| `getProjects()` | `[{name, displayPath, sessionCount, latestSession}]` |
| `getSessions(projectName)` | 会话摘要，包含 `id/file/filePath/title/messageCount/lastActivity/cli` |
| `getSessionContent(sessionId, projectName)` | 前端预览结构；Codex 会 normalize |
| `searchSessionText(projectName, query, {isRegex})` | 匹配会话及次数，或正则错误对象 |
| `getRawLines(sessionId, projectName)` | 原始 JSONL 对象数组，用于 Fork/编辑 |
| `writeFork(rawLines, srcFilePath, newId)` | 按 CLI 原格式排他创建新文件 |

`getSessionContent` 与 `getRawLines` 不能混用。前者允许格式归一化，后者必须保留可被原 CLI 识别的结构。

### Claude

- 项目目录名例如 `D--claudecode`，`decodeProjectDir` 反解为 `D:\claudecode`。
- `resolveProjectDir` 只允许 `~/.claude/projects` 下的一级真实目录，拒绝路径穿越和符号链接；受限 Windows 环境在 `realpath` 返回 `EPERM` 时使用已验证的直接目录路径。
- 会话 ID通常来自文件名，也会从长度足够的顶层 `sessionId` 回填。
- 标题取第一条有效 user 消息；过滤 local-command caveat 等系统包裹。
- JSONL 逐行解析，损坏行跳过。

### Codex

- 递归扫描日期目录，再从 `session_meta.payload.cwd` 聚合项目。
- 会话 ID优先使用 `session_meta.payload.id`，回退到 rollout 文件名中的 UUID。
- `response_item.payload.message` 被转换为 `{type,message:{role,content}}`。
- `input_text/output_text` 转为 `text`；环境上下文块从预览文本中剥离。
- JSONL 同样逐行容错，活动文件的半截末行不会清空整个会话。

## 主要数据流

### 浏览

```text
选择项目
  → GET sessions
  → adapter 扫描/解析所有项目会话摘要
  → routes 注入 meta.json 中的 alias/favorite/hidden/forkedFrom
  → 前端排序和渲染

选择会话
  → GET session content
  → adapter 精确匹配 ID + projectName
  → 逐行解析（Codex 再 normalize）
  → renderPreview
```

### Fork 与编辑

```text
源会话摘要定位 filePath
  → getRawLines（不 normalize）
  → crypto.randomUUID
  → writeFork(..., flag="wx")
  → updateMeta(newId, forkedFrom/cli/projectName/...)
```

编辑器只修改消息行。保存时用编辑后的消息行替换原消息槽位，非消息行保留；新增且超出原槽位的消息追加到文件末尾。

### 删除

```text
定位源文件
  → 生成 timestamp + cli + random 后缀
  → copyFileSync(..., COPYFILE_EXCL) 到 trash
  → unlinkSync 源文件
  → meta.hidden = true
```

复制成功后才删除源文件，避免跨盘 `rename` 的 `EXDEV` 问题。trash 恢复目前没有 UI。

## 备份架构

### 完整工作区快照

`buildBackupSnapshot()`：

1. `ensureBackupGit()` 初始化内部 Git 仓库、设置本地提交身份并创建空初始提交；
2. `wipeWorkspace()` 删除除 `.git` 外的旧镜像；
3. 用 `fs.cpSync` 复制 Claude/Codex 会话目录；
4. 存在时复制 `meta.json` 为 `cc-manager-meta.json`。

工作区是可重建镜像，不是唯一备份。

### 目标选择

`selectBackupTargets()` 的行为：

| 配置 | 目标 |
|---|---|
| `local` | local |
| `github` | github |
| `webdav` | webdav |
| `all` | github → webdav → local |
| `both` | github → webdav（旧配置兼容） |
| 未知/空 | local |

### 手动与自动

| 场景 | local | github | webdav |
|---|---|---|---|
| 手动 | 完整工作区目录副本 | 完整工作区 commit/push | 完整工作区逐文件 PUT |
| 自动 | 从源目录生成内容寻址同步快照 | 刷新完整工作区后 commit/push | 刷新完整工作区后 PUT |

本地自动同步：

- 扫描 Claude/Codex 的 `.jsonl` 和 `meta.json`；`size + mtime + ctime + dev/ino` 全部未变时复用上一份已哈希记录，任一项变化才完整读取并按内容哈希，不只依赖 `mtime`；
- 固定按 4 MiB 分块，每块计算 SHA-256，并仅将仓库中不存在的对象写入 `.cc-manager-sync/objects/<前两位>/<hash>`；
- `auto-<timestamp>/.sync-manifest.json` 保存该时刻的完整路径→文件哈希→块列表映射，因此任意一份新快照都不依赖长链才能解释；
- 相对父快照消失的路径进入 `deleted`，记录删除时间、上一快照和原文件哈希。文件从活动视图移走，但旧清单和对象仍是回收站，可追溯且不物理删除；
- 先在 `.cc-manager-sync/staging/` 写完整清单，再同目录原子重命名发布；无内容变化直接 skipped；
- 父快照已有某类会话而本轮整个源目录缺失时失败关闭，不把挂载、权限或目录异常误发布为批量删除；
- 只有发布成功后才更新 `lastAutoBackupDir`。`autoBackupMtime` 只为旧配置兼容保留。

元数据缓存让绝大多数历史会话不再重复读取；固定分块使 JSONL 末尾追加通常只产生一个新的尾块，相同内容即使来自不同文件也共享对象。源文件扫描开始时记录大小，本轮最多读取该长度，避免活跃日志持续追加导致备份永不结束。

Git 通过 `execFileSync('git', args)` 执行，避免 Windows shell 解释 `%`、`|` 等字符。WebDAV 使用 Node `http/https`，Basic Auth 密码只来自环境变量。

### 操作互斥

`runExclusiveOperation` 保证单个 Node 进程内一次只运行一个备份或恢复。它不是跨进程锁；同时启动两个 cc-manager 实例仍可能竞争相同工作区。

## 历史与恢复

### 历史合并

`listBackupHistory` 合并：

- 内部 Git 的全部 commit；
- 默认和自定义本地根目录下，可解析时间且包含 `claude-sessions`、`codex-sessions`、`.diff-ref` 或 `.sync-manifest.json` 的目录。

结果按时间降序、按 ID 去重后分页。

### Git 恢复

```text
校验 hash/cli/mode
  → createSafetyBackup
  → wipeWorkspace（保留 .git）
  → git checkout <hash> -- .
  → copyWithMode 到活动会话目录
  → finally: git reset --hard HEAD
```

`finally` 保证复制失败时也尽量恢复内部工作区。

### 本地恢复

本地恢复先校验路径真实位于默认或自定义备份根目录。

- 新同步快照：校验清单路径、大小、块哈希和全部所需对象后，直接按完整清单恢复。`full` 中不存在于清单的文件不会进入新活动目录；旧活动目录移动到安全快照，失败的半成品也移动归档并尝试回滚。
- 旧 `.diff-ref`：沿 `refDir` 回溯并防止越界/循环，然后从最老层向最新层叠加，保持历史兼容。

模式实现：

- `incremental`：只复制活动目录不存在的文件；
- `merge`：覆盖同名并增加缺失文件，不移除活动目录独有文件；
- `full`：把活动目录移动到安全快照的 `original-*` 后重建；旧 diff 链的后续层继续用 merge 叠加。

恢复前安全副本总是写入默认 `~/cc-manager-local-backups/pre-restore-*`，不跟随自定义普通备份路径。

## HTTP 与浏览器安全

- Express 只绑定 `127.0.0.1`。
- 中间件拒绝非 loopback Host，降低局域网暴露与 DNS rebinding 风险。
- 不启用 CORS；前端与 API 必须同源。
- session ID进入 URL 前编码，动态项目/会话文本进入 HTML 前转义。
- `opencli` 对 session ID使用白名单，并在启动终端前确认工作目录存在。
- 恢复只接受十六进制 commit hash或允许根目录内的真实本地路径。

这不是多用户鉴权系统。不要把服务改成 `0.0.0.0` 或直接部署到公网。

## 配置生命周期

`store.getConfig()` 每次读取 `config.json` 并与 `DEFAULT_CONFIG` 合并。HTTP 设置更新会立即持久化，但 `server.js` 的自动备份定时器只在启动时创建一次，因此周期变更需要重启服务。

元数据和配置当前使用同步整文件 JSON 读写。损坏文件会回退默认值，尚无原子写入或自动修复机制。
