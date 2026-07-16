# 变更记录

本文件记录 cc-manager 的开发变更，便于接手者了解演进。详细历史踩坑见 [HANDOVER.md](./HANDOVER.md)。

## 2026-07-17 Phase 1：bug 修复 + 工程化基建

### 修复

- **fix: CLI 备份在默认 local 配置下静默失效**（`backup.js`、`index.js`）
  - 根因：旧 `runBackup`（同步版）只处理 `github`/`webdav`/`both`，无 `local` 分支也无兜底，默认 `backupTarget='local'` 时 `cc-manager backup` 返回 `ok:true` 但什么都没备份。
  - 修复：删除 `runBackup`，CLI 改用与 UI 一致的 `asyncRunBackup`；抽出纯函数 `selectBackupTargets(target)` 统一目标选择，未知/空值兜底 `local`，永不静默空跑。
- **fix: Codex Fork 写出无效文件**（`routes.js` fork 路由、`adapters/claude.js`、`adapters/codex.js`）
  - 根因：fork 路由调 `getSessionContent()` 再 stringify 写回；codex 的 `getSessionContent` 返回的是 `normalizeContent()` 转换后的 Claude-like 格式，写回后 codex 适配器自己都读不回。
  - 修复：新增适配器方法 `getRawLines()`（返回原始行）和 `writeFork(rawLines, srcFilePath, newId)`（按各 CLI 命名/字段规则写新文件）。fork 改用原始行，claude/codex 都能产出合法副本。
- **fix: 恢复不是干净的快照还原**（`backup.js` `restoreFromCommit`）
  - 根因：`git checkout <hash> -- .` 后步骤4 用 `git checkout -- .` 还原，但 index 已被改成 `<hash>`，worktree 并未回到当前分支；且未清空工作区导致后续备份新增的文件残留进还原源。
  - 修复：检出前 `wipeWorkspace()` 清空（保留 .git）保证严格等于目标 commit；还原改用 `git reset --hard HEAD`。抽出 `wipeWorkspace(dir)` 公共助手。
  - 注：`copyWithMode` 的 `full` 模式当前为"覆盖同名文件，dest 独有保留"，非物理删除（出于数据安全）；如需"完全替换"语义后续再议。

### 工程

- **chore: 移除废弃依赖 chokidar**（全代码未使用，`package.json` 已剔除；`node_modules/chokidar` 与 `package-lock` 作为无害残留，下次 `npm install` 自动清理）。
- **docs: 新增 `DEVELOPMENT.md`**（安全不变量、适配器模式、测试规范、提交规范）。
- **test: 回归测试 19 -> 30**（`selectBackupTargets`、`wipeWorkspace`、`copyWithMode full`、`claude/codex.writeFork`、适配器方法暴露）。

### 内部改进

- `buildBackupSnapshot` 的清空逻辑抽出为 `wipeWorkspace()`，与 restore 复用。
- `copyWithMode`、`wipeWorkspace`、`selectBackupTargets` 导出供单测。
