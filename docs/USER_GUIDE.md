# cc-manager 用户指南

本文描述当前 UI 与 CLI 的实际行为。接口调用见 [API 参考](./API.md)，实现细节见 [架构说明](./ARCHITECTURE.md)。

## 启动与停止

```powershell
npm install
npm start
```

默认地址是 `http://localhost:17890`。服务只监听 `127.0.0.1`，停止服务可在启动终端按 `Ctrl+C`。

配置文件在服务启动时读取。修改自动备份周期后，需要重启服务，当前进程的定时器才会采用新周期。

## 浏览界面

### 左栏：CLI 与项目

- `Claude` 数据来自 `~/.claude/projects/`，项目名由 Claude 的编码目录反解为原路径。
- `Codex` 数据来自 `~/.codex/sessions/`，按 `session_meta.payload.cwd` 聚合；缺少工作目录的会话归入“未关联项目”。
- 项目旁的数量是检测到的 `.jsonl` 会话文件数量。

### 中栏：会话列表

支持以下排序：

- 最近活动时间降序或升序；
- 会话标题；
- 消息数。

标题优先取第一条有效用户消息。Claude 在取不到标题时会回退到 `history.jsonl`，最终回退为会话 ID 前 8 位；Codex 直接回退为 ID 前 8 位。

搜索范围：

- **标题+内容**：先本地匹配标题，再请求后端搜索消息内容；
- **仅标题**：只在浏览器内匹配标题、ID 和别名；
- **正则**：后端把输入作为不区分大小写的正则表达式。

内容搜索返回匹配会话和匹配次数，目前不返回上下文片段，也不会在预览正文内高亮。

### 右栏：预览与导航

预览会统一渲染 Claude 与 Codex 的用户消息、AI 回复、思考块、工具调用和工具结果。较长工具结果默认折叠。

当一份会话包含超过 3 条有效用户输入时，会显示用户输入导航按钮；点击条目可以滚动到对应消息。

## 会话操作

### 别名与收藏

- 别名最长 64 个字符，保存在 `~/.cc-manager/meta.json`，不会写进原始会话。
- 收藏会话会置顶；收藏也是 cc-manager 自身元数据。
- `GET /api/favorites` 返回元数据记录，因此可能包含已经从磁盘移走的会话。

### 在 CLI 中打开

点击“在 CLI 打开”会在会话所属项目目录创建新的 Windows `cmd` 窗口：

- Claude：`claude --resume <sessionId>`；
- Codex：`codex resume <sessionId>`。

服务启动时会通过 `where` 查找 CLI；CLI 后装或 PATH 改变后需要重启 cc-manager。未关联工作目录的 Codex 会话不能使用此功能。

### Fork

Fork 会读取原始 JSONL 行、生成新的 UUID，并在源文件同目录创建新会话：

- Claude 文件名为 `<newId>.jsonl`，顶层 `sessionId` 会替换为新 ID；
- Codex 文件名保持 `rollout-<时间>-<newId>.jsonl` 形式，`session_meta.payload.id` 会替换为新 ID。

文件使用排他创建，已有文件不会被覆盖。新会话的 `forkedFrom`、CLI 和项目写入 cc-manager 元数据。

### 编辑

编辑器只把聊天消息行作为可排序条目，其他会话元数据行会保留。它支持：

- 修改用户输入和 AI 输出文本；
- 插入用户或 AI 消息；
- 删除单条或批量删除；
- 上下移动；
- 在编辑器内部剪切和粘贴消息。

工具调用、工具结果和思考块只读展示；要删除它们，需要删除所在整条消息。保存时采用 copy-on-write：生成新会话，源文件不改。HTTP JSON 请求上限为 10 MB，特别大的会话可能无法在编辑器中保存。

### 导出 Markdown

导出会展开文本、工具调用参数和最多 2000 字符的工具结果；系统事件行会跳过。文件名优先使用会话标题。

### 删除

删除不是写入 `hidden` 后继续保留源文件，而是：

1. 把源 JSONL 复制到 cc-manager 项目上级的 `trash` 目录；
2. 删除原位置文件；
3. 在元数据中把该 ID 标记为 `hidden`。

在当前仓库位置，回收目录是 `D:\claudecode\trash\`。文件名包含时间、CLI 和随机后缀，避免覆盖。UI 暂无一键还原 trash 的功能，需要手动放回原目录。

## 备份

### 备份范围

快照包含：

- `~/.claude/projects/`；
- `~/.codex/sessions/`；
- 存在时的 `~/.cc-manager/meta.json`。

它不包含 Claude/Codex 的其他配置、凭据、模型缓存，也不包含 cc-manager 的 `config.json`。

### 目标

| 目标 | 行为 | 凭据 |
|---|---|---|
| `local` | 复制到本地备份目录 | 无 |
| `github` | 在内部 Git 工作区提交，并在可用时推送 | `CC_MANAGER_GH_TOKEN` |
| `webdav` | 逐文件 HTTP PUT，跳过 `.git` | `CC_MANAGER_WEBDAV_PASS` |
| `all` | GitHub、WebDAV、本地依次执行 | 对应凭据 |

默认目标为 `local`，默认本地目录为 `~/cc-manager-local-backups/`。

GitHub 建议使用私有仓库，因为备份内含完整聊天记录。第一次在 UI 保存仓库 URL 时会自动初始化内部 Git 工作区并设置 `origin`。也可以用 CLI 显式完成：

```powershell
node server/index.js backup --init
node server/index.js backup --set-remote https://github.com/USER/REPO.git
```

或者全局安装后使用 `cc-manager` 命令。无 token 时仍会创建本地 Git commit，但不保证能推送。

WebDAV 密码不保存到 `config.json`。先保存 URL/用户名，再点击连接测试。

### 手动与自动备份

- 顶栏“一键备份”和 `cc-manager backup` 是手动备份；它们先重建完整工作区快照。
- 自动备份周期默认 1440 分钟，设为 0 可关闭；UI 允许 0–1440。
- 当自动任务包含 `local` 时，本地目标使用基于文件 `mtime` 的 diff 目录 `auto-<时间>`，并用 `.diff-ref` 指向上一层。
- 自动 Git/WebDAV 目标使用刷新后的完整工作区，而不是本地 diff 目录。
- 备份和恢复在同一个进程内互斥；已有操作运行时，新操作会返回“请稍后重试”。

### 备份历史

恢复窗口合并两个来源并按时间倒序分页：

- 内部 Git 工作区的 commit；
- 默认和自定义本地备份根目录下，名称可解析为时间且包含会话目录或 `.diff-ref` 的文件夹。

每页默认 20 条。`pre-restore-*` 和 `auto-*` 也会进入历史。

## 恢复

恢复来源可以是 Git commit 或 UI 返回的本地备份目录。服务只接受内部备份根目录中的本地路径。

恢复前总会把当前 Claude/Codex 会话复制到默认本地根目录下的 `pre-restore-<时间>/`，即使配置了自定义普通备份目录也是如此。

三种模式：

| 模式 | 同名文件 | 当前目录独有文件 | 适用场景 |
|---|---|---|---|
| `incremental` | 保留当前版本 | 保留 | 只补回缺失会话，最保守 |
| `merge` | 用备份覆盖 | 保留 | 回到备份内容，同时保留后来新增会话 |
| `full` | 用备份覆盖 | 从活动目录移走 | 让活动目录严格按备份链重建 |

`full` 不直接删除旧活动目录，而是把它移动到安全快照中的 `original-claude-sessions` / `original-codex-sessions`。本地 diff 备份会从基准层开始逐层叠加。

WebDAV 当前只支持上传，不支持在 UI 中列历史或恢复。

## 配置与环境变量

`~/.cc-manager/config.json` 的当前字段：

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `repoUrl` | `""` | Git 远程 URL |
| `branch` | `main` | 推送分支 |
| `autoIntervalMin` | `1440` | 自动备份分钟数，0 为关闭 |
| `backupTarget` | `local` | `local` / `github` / `webdav` / `all`；兼容旧值 `both` |
| `webdavUrl` | `""` | WebDAV 根 URL |
| `webdavUsername` | `""` | WebDAV 用户名 |
| `localBackupDir` | `""` | 空值使用默认目录 |
| `autoBackupMtime` | `0` | 内部自动 diff 基准，不应手改 |
| `lastAutoBackupDir` | `""` | 内部 diff 链指针，不应手改 |
| `lastBackupAt` | `null` | 最近至少一个目标成功的时间 |
| `lastRestoreAt` | `null` | 最近恢复成功的时间 |

环境变量：

| 变量 | 用途 |
|---|---|
| `CC_MANAGER_GH_TOKEN` | HTTPS Git 推送认证 |
| `CC_MANAGER_WEBDAV_PASS` | WebDAV Basic Auth 密码 |

## 故障排查

- **设置已保存但自动周期没变化**：重启 cc-manager。
- **Git 只有本地 commit，没有推送**：检查 `repoUrl`、远程 `origin`、分支和 `CC_MANAGER_GH_TOKEN`。
- **WebDAV 测试仍使用旧地址**：先保存设置，再测试。
- **CLI 打不开**：确认 `where claude` / `where codex` 有结果并重启服务。
- **编辑返回请求过大**：会话原始 JSON 超过 10 MB；当前需使用 Fork 或外部工具处理。
- **恢复记录缺失**：确认目录名含可解析时间，并且含 `claude-sessions`、`codex-sessions` 或 `.diff-ref`。
