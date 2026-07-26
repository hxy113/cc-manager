# cc-manager HTTP API

当前 API 由 `server/routes.js` 定义。基础地址默认是 `http://127.0.0.1:17890`，所有 API 路径以 `/api` 开头。

## 通用约定

- 服务只接受 `localhost`、`127.0.0.1` 或 `[::1]` Host，不提供跨域 CORS。
- 路径参数必须使用 URL 编码，特别是 Codex 的 `projectName` 可能是完整 Windows 路径。
- JSON 请求使用 `Content-Type: application/json`，请求体上限 10 MB。
- `:cli` 当前只接受 `claude` 或 `codex`。
- 一般参数错误返回 400、资源不存在返回 404、未捕获错误返回 500。
- 备份执行、WebDAV 测试和恢复的运行时失败通常仍返回 HTTP 200，并在 JSON 中返回 `ok: false`；调用方必须检查 `ok`。

## CLI 与项目

### `GET /api/cli`

返回已注册的适配器名称：

```json
["claude", "codex"]
```

### `GET /api/cli/:cli/projects`

列出项目。

```json
[
  {
    "name": "D--claudecode",
    "displayPath": "D:\\claudecode",
    "sessionCount": 28,
    "latestSession": 1782305846992,
    "cli": "claude"
  }
]
```

Claude 项目对象当前可能不含 `cli` 字段；Codex 项目含 `cli: "codex"`。调用方不应依赖该字段判断当前标签。

### `GET /api/cli/:cli/project/:projectName/sessions`

查询参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `showHidden` | `false` | 只有字符串 `true` 才包含标记为 hidden 且仍存在于磁盘的会话 |

```json
[
  {
    "id": "67ba5fed-fa06-4755-9566-6cabb77c690e",
    "file": "67ba5fed-fa06-4755-9566-6cabb77c690e.jsonl",
    "filePath": "C:\\Users\\...\\67ba5fed-fa06-4755-9566-6cabb77c690e.jsonl",
    "projectName": "D--claudecode",
    "title": "第一条有效用户消息",
    "subtitle": "67ba5fed-fa06-4755-9566-6cabb77c690e",
    "messageCount": 437,
    "lastActivity": 1782305846992,
    "cli": "claude",
    "alias": null,
    "favorite": false,
    "hidden": false,
    "forkedFrom": null
  }
]
```

删除操作会把源文件移走，因此已删除会话通常不会因为 `showHidden=true` 重新出现；该参数主要对仍存在但元数据被标记 hidden 的会话有效。

## 会话读取与搜索

### `GET /api/cli/:cli/session/:sessionId?projectName=...`

返回前端预览使用的消息数组。Claude 返回容错解析后的原始对象；Codex 会转换为 Claude-like 结构。

```json
[
  {
    "type": "user",
    "message": {
      "role": "user",
      "content": [
        { "type": "text", "text": "你好" }
      ]
    },
    "timestamp": "2026-06-24T12:09:35.342Z"
  }
]
```

统一内容块主要包括 `text`、`tool_use`、`tool_result`、`thinking`。找不到会话时返回 404。

### `GET /api/cli/:cli/project/:projectName/search?q=...&regex=false`

| 参数 | 必需 | 说明 |
|---|---|---|
| `q` | 是 | 空白查询返回 `[]` |
| `regex` | 否 | 字符串 `true` 时把 `q` 作为不区分大小写的正则 |

正常返回：

```json
[
  { "sessionId": "...", "title": "...", "matchCount": 5 }
]
```

无效正则当前返回 HTTP 200：

```json
{ "error": "正则表达式无效: ..." }
```

## cc-manager 元数据

### `GET /api/meta/:sessionId`

返回对应元数据；不存在时返回 `{}`。

### `POST /api/meta/:sessionId`

只接受以下字段，多余字段忽略：

```json
{
  "alias": "易记名称",
  "favorite": true,
  "hidden": false,
  "forkedFrom": "source-id",
  "cli": "claude",
  "projectName": "D--claudecode"
}
```

服务会自动写入 `sessionId` 与 `updatedAt`。

### `GET /api/favorites?cli=claude`

返回 `meta.json` 中收藏的元数据记录。省略 `cli` 时返回所有 CLI；结果不保证源会话文件仍存在。

## 会话写操作

### `POST /api/session/:cli/:sessionId/fork`

请求：

```json
{ "projectName": "D--claudecode" }
```

成功响应：

```json
{
  "ok": true,
  "newSessionId": "...",
  "newFilePath": "...",
  "message": "Fork 成功"
}
```

源会话不存在返回 404；缺少 `projectName` 或适配器不支持 Fork 返回 400。

### `GET /api/session/:cli/:sessionId/raw?projectName=...`

返回未 normalize 的 JSONL 行，供编辑器使用：

```json
{
  "cli": "codex",
  "sessionId": "...",
  "lines": [
    { "type": "session_meta", "payload": { "id": "..." } }
  ]
}
```

### `POST /api/session/:cli/:sessionId/edit`

请求：

```json
{
  "projectName": "D--claudecode",
  "lines": [
    { "type": "user", "message": { "role": "user", "content": "修改后文本" } }
  ]
}
```

服务把 `lines` 作为新会话写回，不验证每行的完整业务结构；调用方必须保留对应 CLI 的原始格式。成功响应与 Fork 相同，但消息为“已保存为新会话（源未改动）”。

### `POST /api/session/:cli/:sessionId/delete`

请求：

```json
{ "projectName": "D--claudecode" }
```

成功返回：

```json
{
  "ok": true,
  "trashPath": "D:\\claudecode\\trash\\...jsonl",
  "message": "已移动到 trash"
}
```

实现是排他复制到 trash 后删除源文件，再更新 hidden 元数据。

### `GET /api/session/:cli/:sessionId/export?projectName=...`

返回 Markdown 文件，不是 JSON：

- `Content-Type: text/markdown; charset=utf-8`
- `Content-Disposition: attachment; filename="<编码后的标题>.md"`

### `POST /api/session/:cli/:sessionId/open`

请求：

```json
{ "projectName": "D--claudecode" }
```

成功：

```json
{
  "ok": true,
  "message": "已在新终端打开（D:\\claudecode）",
  "cwd": "D:\\claudecode",
  "cmd": "... --resume ...",
  "cliPath": "..."
}
```

会话不存在返回 404；工作目录、ID 或 CLI 可执行文件无效时返回 400。

## 备份配置与执行

### `GET /api/backup/status`

```json
{
  "gitAvailable": true,
  "repoConfigured": true,
  "repoUrl": "https://github.com/USER/REPO.git",
  "branch": "main",
  "backupTarget": "local",
  "webdavUrl": null,
  "webdavUsername": "",
  "webdavConfigured": false,
  "localBackupDir": null,
  "lastBackupAt": 1782305846992,
  "lastRestoreAt": null,
  "autoIntervalMin": 1440,
  "workspaceExists": true
}
```

不会返回 token 或 WebDAV 密码。

### `POST /api/backup/config`

接受字段：

```json
{
  "repoUrl": "https://github.com/USER/REPO.git",
  "branch": "main",
  "autoIntervalMin": 1440,
  "backupTarget": "local",
  "webdavUrl": "",
  "webdavUsername": "",
  "localBackupDir": ""
}
```

`backupTarget` 的当前值为 `local`、`github`、`webdav`、`all`；内部仍兼容旧值 `both`。设置 `repoUrl` 时会初始化内部 Git 工作区并设置/清除 `origin`；失败返回 400，配置不会写入。成功返回合并默认值后的完整配置对象，其中还包含内部状态字段。

### `POST /api/backup/run`

无请求体要求。按当前配置执行一次手动备份：

```json
{
  "ok": true,
  "message": "local: 已备份到 ...",
  "timestamp": "2026-07-26-09-20-01-123",
  "results": [
    { "target": "local", "ok": true, "message": "已备份到 ..." }
  ]
}
```

`ok` 只有在本轮所有目标都成功时为 true。至少一个目标成功时才更新 `lastBackupAt`。如果已有备份或恢复运行，返回 `{ "ok": false, "error": "正在执行..." }`。

### `POST /api/backup/webdav-test`

使用**已保存配置**发送 `PROPFIND /`。响应：

```json
{ "ok": true, "message": "WebDAV 连接正常" }
```

或：

```json
{ "ok": false, "error": "WebDAV 连接失败: ..." }
```

## 历史与恢复

### `GET /api/backup/history?page=1&pageSize=20`

`pageSize` 在路由层限制为 1–100。返回 Git 与本地历史合并后的分页对象：

```json
{
  "entries": [
    {
      "id": "C:\\Users\\...\\cc-manager-local-backups\\2026-07-26-09-20-01-123",
      "type": "local",
      "hash": "2026-07-26-09-20-01-123",
      "timestamp": 1785038401000,
      "message": "本地备份 2026-07-26-09-20-01-123"
    },
    {
      "id": "<commit sha>",
      "type": "git",
      "hash": "<commit sha>",
      "timestamp": 1785038401000,
      "message": "backup 2026-07-26-09-20-01-123"
    }
  ],
  "total": 42,
  "page": 1,
  "pageSize": 20,
  "totalPages": 3
}
```

### `POST /api/backup/restore`

Git 来源：

```json
{ "hash": "0123456789abcdef...", "cli": "claude", "mode": "incremental" }
```

本地来源：

```json
{ "localPath": "C:\\Users\\...\\cc-manager-local-backups\\...", "cli": "codex", "mode": "merge" }
```

| 字段 | 说明 |
|---|---|
| `hash` / `localPath` | 二选一；同时提供时本地路径优先 |
| `cli` | 可省略；省略时恢复备份中存在的两种 CLI |
| `mode` | `incremental`（默认）、`merge`、`full` |

成功：

```json
{
  "ok": true,
  "message": "已从 ... 恢复，恢复前已备份到 ...",
  "safetyBackup": "C:\\Users\\...\\pre-restore-..."
}
```

参数格式错误返回 400；备份缺失、路径越界、工作区错误等运行时失败返回 HTTP 200 + `{ "ok": false, "error": "..." }`。
