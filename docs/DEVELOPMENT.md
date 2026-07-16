# cc-manager 开发指南

面向接手开发者的精简开发规范。架构与数据流见 [ARCHITECTURE.md](./ARCHITECTURE.md)，历史踩坑见 [HANDOVER.md](./HANDOVER.md)。

## 环境与命令

```bash
npm install          # 安装依赖（express + cors）
npm start            # 启动 http://localhost:17890
npm test             # 跑单元测试（纯 Node assert，无外部依赖）
```

- 改了后端代码**必须重启 server**，Node 不热重载。
- 端口被占用会静默失败，换端口：`node server/index.js ui 17891`。

## 核心安全不变量（最重要）

1. **只读源数据**：cc-manager 从不写入 Claude/Codex 的会话文件，只读取。唯一的"写"是删除（移到 trash）。
2. **修改会话 = copy-on-write**：Fork 和编辑都**永不覆盖原文件**，总是用新 sessionId 写新文件。这保证已存在的对话只有读取，没有就地修改，与 CLI 并发写入零竞争。
3. **恢复前必先备份**：任何恢复操作前，先把当前状态复制到 `~/cc-manager-local-backups/pre-restore-<时间戳>/`。
4. **Windows 兼容**：`runGit` 必须用 `execFileSync('git', args)` 直接 spawn，不要改回 `execSync`（`%`/`|` 会被 cmd.exe 解释）。跨盘符不能用 `renameSync`，用 `copyFileSync`+`unlinkSync`。

## 适配器模式

每个 CLI 适配器（`server/adapters/<cli>.js`）统一暴露：

| 方法 | 作用 |
|------|------|
| `getProjects()` | 项目列表 |
| `getSessions(projectName)` | 会话列表（含 `filePath`、`file`、`title`） |
| `getSessionContent(sessionId, projectName)` | 会话内容（**前端渲染用**，codex 会 normalize 成 Claude-like） |
| `getRawLines(sessionId, projectName)` | 会话**原始行**（**fork/编辑用**，不 normalize，保留原格式） |
| `writeFork(rawLines, srcFilePath, newId)` | 用新 id 写新文件，返回 `{newFilePath, newId}`（永不覆盖源） |
| `searchSessionText(projectName, query, {isRegex})` | 全文搜索 |

**关键区分**：`getSessionContent` 给前端看（codex 转成统一格式）；`getRawLines` 给 fork/编辑用（保留原格式才能写回合法文件）。两者不要混用。

添加新适配器：实现上述方法 → 在 `routes.js` 的 `adapters` 对象注册 → 在 `web/index.html` 的 `renderCliTabs` 加 tab。

## 备份目标选择

`backup.selectBackupTargets(target)` 是纯函数，决定跑哪些目标：

- `local` / `github` / `webdav` → 单项目标
- `all` → github + webdav + local
- `both` → 向后兼容（github + webdav）
- 未知/空值 → 兜底 `local`（**永不静默空跑**）

CLI（`cc-manager backup`）和 UI（一键备份）都走 `asyncRunBackup`，共用这套逻辑。

## 测试规范

- 测试在 `test/run.js`，用 Node 内置 `assert`，零依赖。
- **修 bug 必加回归测试**，测试名带 bug 编号或现象。
- 涉及文件 IO 的逻辑优先抽成纯函数或接受路径参数（如 `wipeWorkspace(dir)`、`copyWithMode(src,dest,mode)`、`selectBackupTargets(target)`），避免依赖真实的 `~/.claude` 路径。
- 临时文件用 `os.tmpdir()`，结束 `fs.rmSync` 清理。

## Git 提交规范

- 提交信息用中文，带前缀：`fix:` / `feat:` / `chore:` / `docs:` / `test:`。
- README、commit message 等对外文本不用 emoji（UI 按钮里的 emoji 可保留）。
- 一个逻辑改动一个 commit，不要把多个无关修复塞一个 commit。
- 账号级操作（建库、push）由用户亲手敲，或在本会话明确授权后由 AI 执行。
- 永不 force push，永不删远程分支。
