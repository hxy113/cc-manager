# 变更记录

本文件记录 cc-manager 的开发变更，便于接手者了解演进。详细历史踩坑见 [HANDOVER.md](./HANDOVER.md)。

## 2026-07-26：自动备份改为内容寻址同步

- 默认本地定时备份由 `mtime` diff 链改为完整清单 + 4 MiB SHA-256 内容寻址块；相同块跨文件、跨快照复用，活跃大对话末尾追加不再反复保存整文件。
- 未变化文件通过 `size + mtime + ctime + dev/ino` 复用上一份已验证清单，避免每轮重新读取全部历史；变化文件仍按内容哈希。
- 删除成为清单中的 `deleted` 回收站事件：路径退出活动视图，但旧快照和旧内容对象永久保留；`full` 恢复不会再让已删除会话从基准层复活。
- 快照使用 staging + 原子重命名发布，成功后才推进 `lastAutoBackupDir`；无内容变化不发布空快照。
- 同步恢复增加路径、大小、块哈希和整文件哈希校验；完整恢复失败时把半成品移入安全目录并回滚原活动目录。
- 继续读取已有完整目录和 `.diff-ref` 链，不要求迁移旧备份。
- 新增块级去重、追加写、纯删除、tombstone、对象保留、full 恢复、路径穿越、缺失源目录和损坏对象回归测试；测试总数增至 51。

## 2026-07-26：接管稳定化

### 文档治理

- 新增文档导航、完整用户指南和已知限制清单，明确 README、API、架构、开发规范、变更记录和历史交接纪要的职责。
- 重写 API 参考，覆盖全部 HTTP 路由、分页历史、本地恢复、原始行、编辑、打开 CLI、状态码和失败语义。
- 重写架构说明，纠正“源数据只读”“三家 CLI”“手动增量备份”等过时描述，并记录适配器、diff 链、full 归档、互斥和安全边界。
- 增加文档链接与路由覆盖测试，防止新增接口后文档继续漂移。

### 契约修复

- `showHidden` 现在只有显式传 `true` 才生效，`showHidden=false` 不再意外显示隐藏会话。
- 备份状态补充 `branch` 和 `webdavUsername`，设置面板重新打开时不再显示错误默认值。
- UI 首次保存 Git URL 时会初始化内部仓库并设置远程；远程设置失败会返回 400，不再静默保存半完成配置。
- CLI 帮助补齐远程/首次推送/WebDAV 环境变量，并把手动备份、恢复命令描述改为真实行为。

### 安全与正确性

- 服务仅监听 `127.0.0.1`，拒绝非 loopback Host，并移除任意来源 CORS。
- Claude 项目目录增加真实路径边界校验，阻断 `projectName` 路径穿越。
- 前端不再把会话 ID 拼入内联 JavaScript；项目名、路径、ID、错误信息统一转义。
- 恢复接口校验 commit hash、CLI、模式和本地备份根目录；git 工作区在异常路径下也会回到 HEAD。
- Codex JSONL 改为逐行容错，活跃会话的半截末行不会让整份会话变空。
- Fork 使用排他创建，避免极端 ID 冲突覆盖已有会话；删除到 trash 增加随机后缀避免同名覆盖。

### 备份与恢复

- 目录复制改用 Node `fs.cpSync`，去掉 `xcopy` 和 shell 拼接，复制失败不再被静默吞掉。
- 自动 Git/WebDAV 备份会刷新工作区，不再上传陈旧快照；自动增量备份也包含元数据变更。
- 备份与恢复增加进程内互斥，定时任务、手动操作和恢复不会再并发改写同一工作区。
- 备份历史支持自定义本地目录、Codex-only 快照和 `auto-*` 快照；CLI 恢复命令适配分页返回结构。
- `full` 恢复现在真正替换活动目录，旧目录移动到恢复前安全快照中，不直接删除。

### 工程

- 测试框架改为逐个 `await`，异步测试不再提前误报通过；回归测试现为 47/47，并完成真实 UI 只读冒烟测试。
- 移除未使用的 `cors`，并清理锁文件中遗留的 `chokidar`/`readdirp`。
- 新增 GitHub Actions CI（Windows/Linux × Node 18/22）、Dependabot、CODEOWNERS、Issue/PR 模板、贡献指南与安全策略。
- 新增 `.editorconfig`、`.gitattributes` 和敏感/生成文件忽略规则，统一 LF 并降低凭据误提交风险。
- 主分支首轮 CI 全部通过；Dependabot 验证出 Express 5 不兼容，自动版本更新策略改为忽略 Express semver-major，待专门迁移。

## 2026-07-17 Phase 3：完整版修改会话（copy-on-write）

### 新增

- **feat: 完整版会话编辑器，copy-on-write 永不覆盖源文件**
  - 安全设计：编辑 → 用新 sessionId 写新文件，源文件只读不动。与 Claude Code / Codex CLI 的并发写入零竞争。
  - 后端 `GET /api/session/:cli/:sessionId/raw`：取会话原始行（codex 不 normalize），供编辑器加载。
  - 后端 `POST /api/session/:cli/:sessionId/edit`：接收修改后的行数组，通过 `writeFork` 写入新文件，记录 `forkedFrom + edited` 元数据。
  - 前端编辑器（嵌入在预览区）：
    - 编辑文本：用户输入和 AI 回复的全文直接编辑，`tool_use`/`tool_result`/`thinking` 块只读展示。
    - 插入消息：在选中位置插入空用户消息或 AI 消息（Claude 和 Codex 都支持恰当的格式构造）。
    - 删除：单条删除（卡片上 🗑）或批量删除（勾选 → 🗑 删除选中）。
    - 重排：↑ ↓ 按钮移动消息顺序。
    - 剪切/粘贴：选中多条 → ✂️ 剪切（深拷贝到剪贴板）→ 📋 粘贴到末尾或选中位置之后。
    - 退出确认：编辑中切换项目/CLI/会话时弹出确认对话框防止误丢。
    - 保存：全部操作完成后 💾 保存为新会话 → 自动跳转到新会话预览。
  - 编辑中预览头按钮（导出/删除/打开/编辑）隐藏，工具栏替换。
  - 会话列表 hover 操作区加 📝 图标。

### 测试

- **test: 37 个测试**（+1：`POST /edit 缺少 lines 返回 400`）。

## 2026-07-17 Phase 2：一键打开会话到 CLI

### 新增

- **feat: 一键在新终端打开会话到对应 CLI**（`server/opencli.js`、`routes.js`、`web/index.html`）
  - Claude 会话：`claude --resume <id>`；Codex 会话：`codex resume <id>`，均在会话所属工程目录的新终端窗口启动。
  - 会话列表 hover 操作区与预览头各加一个「📂 打开」按钮。
  - 安全：sessionId 白名单校验（仅字母数字连字符，防命令注入）；工程目录不存在时拒绝启动。
  - 实现：`spawn('cmd', ['/k', cmd], {cwd, detached:true})` 由 detached 创建新控制台窗口、cwd 直接落工程目录，命令本身无 `cd`/`&&`/管道，规避 Windows cmd 引号与特殊字符陷阱。

### 测试

- **test: 36 个测试**（+6：`isValidSessionId`、`buildOpenCommand`、`resolveCwd` 各路径、`openSession` 拒绝非法 id）。

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
