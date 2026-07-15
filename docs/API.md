# cc-manager API 参考

所有接口返回 JSON，前缀 `/api`。基础地址 `http://localhost:17890`。

## CLI 与项目

### `GET /api/cli`
列出支持的 CLI。

**返回**：`["claude", "codex"]`

### `GET /api/cli/:cli/projects`
列出某 CLI 下所有项目文件夹。

**返回**：
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

### `GET /api/cli/:cli/project/:projectName/sessions?showHidden=false`
列出某项目下所有会话。

**参数**：
- `showHidden`：是否包含已隐藏（已删除）的会话，默认 `false`

**返回**：
```json
[
  {
    "id": "67ba5fed-fa06-4755-9566-6cabb77c690e",
    "file": "67ba5fed-....jsonl",
    "filePath": "C:\\Users\\...\\67ba5fed-....jsonl",
    "projectName": "D--claudecode",
    "title": "我才知道你claudecode里面的聊天记录...",
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

**标题优先级**：第一条真正用户消息 > history.jsonl 最后记录 > sessionId 前 8 位。

## 会话内容

### `GET /api/cli/:cli/session/:sessionId?projectName=...`
取某会话完整内容（消息数组）。

**返回**：消息数组，每条：
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "你好"   // string 或 content 块数组
  },
  "timestamp": "2026-06-24T12:09:35.342Z"
}
```

content 块类型：`text` / `tool_use` / `tool_result` / `thinking`。

## 搜索

### `GET /api/cli/:cli/project/:projectName/search?q=...&regex=false`
全文搜索会话内容。

**参数**：
- `q`：搜索词
- `regex`：`true` 时把 q 当正则

**返回**：
```json
[
  { "sessionId": "...", "title": "...", "matchCount": 5 }
]
```

无效正则返回 `{ "error": "正则表达式无效: ..." }`。

## 元数据（别名/收藏/fork）

### `GET /api/meta/:sessionId`
取某会话的元数据。

### `POST /api/meta/:sessionId`
更新元数据。body 字段（均可选）：`alias` / `favorite` / `hidden` / `forkedFrom` / `cli` / `projectName`。

### `GET /api/favorites?cli=...`
取收藏列表，可按 cli 过滤。

## 会话操作

### `POST /api/session/:cli/:sessionId/fork`
Fork 会话。body：`{ "projectName": "..." }`。

复制原会话为新 sessionId，原会话不动。

### `POST /api/session/:cli/:sessionId/delete`
删除会话（移到 trash）。body：`{ "projectName": "..." }`。

跨盘符时用复制+删除，不报 EXDEV。

### `GET /api/session/:cli/:sessionId/export?projectName=...`
导出为 Markdown。返回 `Content-Type: text/markdown`，文件名用会话标题（URL 编码）。

## 备份

### `GET /api/backup/status`
取备份配置与状态。

### `POST /api/backup/config`
更新配置。body 字段：`repoUrl` / `branch` / `autoIntervalMin` / `backupTarget` / `webdavUrl` / `webdavUsername` / `localBackupDir`。

`backupTarget` 可选：`local` / `github` / `webdav` / `all`。

### `POST /api/backup/run`
执行一次备份。返回每路结果：
```json
{
  "ok": true,
  "message": "local: 已备份到 ...; github: 推送完成",
  "timestamp": "2026-06-24-20-01-59",
  "results": [
    { "target": "local", "ok": true, "message": "已备份到 ..." }
  ]
}
```

### `GET /api/backup/history?limit=20`
取备份历史（git log）。

**返回**：
```json
[
  { "hash": "f649a2f...", "timestamp": 1782305846000, "message": "backup 2026-06-24-20-01-59" }
]
```

### `POST /api/backup/restore`
从某 commit 恢复。body：`{ "hash": "...", "cli": "claude", "mode": "incremental" }`。

`mode` 可选：`incremental`（默认，仅补缺）/ `merge`（覆盖+保留）/ `full`（完全覆盖）。

恢复前自动备份当前状态到 `~/cc-manager-local-backups/pre-restore-<时间戳>/`。

### `POST /api/backup/webdav-test`
测试 WebDAV 连接。

## 环境变量

| 变量 | 用途 |
|------|------|
| `CC_MANAGER_GH_TOKEN` | GitHub 推送认证（不写进代码） |
| `CC_MANAGER_WEBDAV_PASS` | WebDAV 密码（不写进代码） |
