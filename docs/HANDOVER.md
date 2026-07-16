# cc-manager 开发全程纪要

本文档记录 cc-manager 从零到可用的全过程，供新接手的 AI 快速理解项目上下文、架构决策和已知坑位。

> 生成日期：2026-07-17
> 生成上下文：与用户 @hxy113 的一次完整对话，从需求沟通 → 设计 → 编码 → 测试 → 上 GitHub → 修复一系列 bug → 写文档的全流程。

---

## 一、项目定位

cc-manager 是一个**本地 Web UI 工具**，用于浏览、管理和备份 **Claude Code** 和 **Codex CLI** 的本地会话记录（`.jsonl` 文件）。

**核心价值**：对话记录是本地明文文件，没有版本保护，用户怕被清理/误删。cc-manager 提供图形界面来管理和备份这些文件。

**不做**的边界（已跟用户确认）：
- 不做多渠道负载均衡/渠道切换（已有 ccswitch）
- 不做代理 API、接管 CLI 通信
- 不做云同步（备份到 git 已是版本化管理）

---

## 二、技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 后端 | Node.js + Express | 跨平台，用户机器已有 Node.js |
| 前端 | 纯 HTML + CSS + JS | 零构建依赖，clone 即用，无需 webpack/vite |
| 数据源 | 直接读 `.jsonl` 文件 | Claude Code / Codex CLI 原生格式 |
| 备份 | 内嵌 git 工作区 + 目录复制 | 版本化管理，增量 commit，可回滚 |
| 测试 | Node 内置 `assert` | 零外部依赖 |

**关键约束**：用户运行环境是 **Windows 10**，所有 Windows 路径/命令的特殊性必须考虑。

---

## 三、项目结构

```
D:\claudecode\cc-manager\
├── server/
│   ├── index.js           CLI 入口（ui / backup / restore 子命令）
│   ├── server.js          Express HTTP 服务 + 自动备份定时器 + 全局异常保护
│   ├── routes.js          REST API 路由
│   ├── store.js           元数据持久化 + 配置 + Markdown 导出
│   ├── backup.js          三路备份（本地 / GitHub / WebDAV）+ 恢复
│   └── adapters/
│       ├── claude.js      Claude 会话适配器（路径反解、消息解析、搜索）
│       └── codex.js       Codex 会话适配器（格式差异抹平）
├── web/
│   └── index.html         三栏单页 SPA（左栏 CLI+项目 / 中栏会话列表 / 右栏预览）
├── test/
│   └── run.js             19 个单元测试
├── docs/
│   ├── ARCHITECTURE.md    架构文档
│   └── API.md             API 参考
├── package.json
├── LICENSE (MIT)
└── README.md
```

---

## 四、核心架构决策

### 4.1 适配器模式

三家 CLI（Claude / Codex）的本地存储格式不同，通过适配器抹平差异。每个适配器统一暴露：

```js
getProjects()                    // → [{name, displayPath, sessionCount}]
getSessions(projectName)         // → [{id, title, subtitle, filePath, messageCount, lastActivity, cli}]
getSessionContent(sessionId)     // → [{type, message: {role, content}, timestamp}]
searchSessionText(query, opts)   // → [{sessionId, title, matchCount}]
```

### 4.2 数据格式差异

| | Claude | Codex |
|---|---|---|
| 项目分目录 | `D--claudecode` = `D:\claudecode` | 从 `session_meta.cwd` 反推 |
| 文件名 | `<uuid>.jsonl` | `rollout-<ts>-<uuid>.jsonl`（按日期分） |
| 消息结构 | `msg.message.content` | `line.payload.content`（需 normalize） |
| 内容块 | `text` / `tool_use` / `tool_result` / `thinking` | `input_text` / `output_text` / `tool_use` / `tool_result` |

`codex.js` 的 `normalizeContent()` 把 Codex 格式转成 Claude-like 格式，前端和导出复用同一套渲染。

### 4.3 备份三路

- **本地**：复制到 `~/cc-manager-local-backups/<timestamp>/`，零依赖，一定成功
- **GitHub**：独立 git 工作区 `~/.cc-manager/backup-workspace/`，commit + push
- **WebDAV**：HTTP PUT 上传到自建云盘

备份目标可选 `local` / `github` / `webdav` / `all`，默认 `local`。

### 4.4 恢复三模式

恢复前**自动备份当前状态**到 `pre-restore-<timestamp>/`。

- **incremental**（默认）：仅复制目标不存在的文件，不动已有的
- **merge**：备份有则覆盖，备份无则保留，d est 独有不删
- **full**：完全用备份替换

---

## 五、已发现并修复的 bug（按发现顺序）

这是最重要的部分——新 AI 接手的首要任务是避免重复踩坑。

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | 预览内容全部为空 | `renderPreview` 读 `msg.content`，但 Claude jsonl 的内容在 `msg.message.content` | 改为读嵌套结构 |
| 2 | tool_result 只显示"📎 工具结果"占位符 | 把长内容塞 `title` 属性，浏览器弹巨型 tooltip | 改可折叠 `<details>` 展真实内容 |
| 3 | 点击某些会话时屏幕蒙灰 | `title` 属性塞入数百 KB 命令输出，浏览器弹 tooltip 覆盖全屏 | 移除 title 属性 |
| 4 | Gemini 引用残留导致 server 启动崩溃 | `routes.js` 里 `require('./adapters/gemini')`，但文件已删 | 移除 require 行 |
| 5 | 空蓝框嵌套后续消息 | `tool_use` 渲染在 `contentText` 里，空框产生嵌套视觉 | 分离渲染结构 |
| 6 | 备份历史始终为空 | `git log --format=%H\|%ct\|%s` 里 `\|` 被 Windows CMD 解释为管道 | 改为 `execFileSync('git', args)` 绕过 shell |
| 7 | 恢复提示"没有备份历史" | backup-workspace 的 `.git` 没初始化 | `buildBackupSnapshot` 自动 `git init` |
| 8 | `runGit` 部分命令在 Windows server 中 ENOENT | `execSync` 内部调 `cmd.exe`，某些 PATH 环境找不到 | 改为 `execFileSync` 直接 spawn git |
| 9 | 增量恢复验证时退出码问题 | `git diff-index --cached --name-only HEAD` 返回 exit 1 无变更时 | 改用 `git status --porcelain` |
| 10 | `path is not defined` 删除报错 | `routes.js` 顶部缺少 `const path = require('path')` | 补 import |
| 11 | EXDEV cross-device link not permitted | `fs.renameSync` 跨盘符（C 盘 → D 盘）不行 | 改为 `copyFileSync` + `unlinkSync` |
| 12 | 导出 Markdown 内容千篇一律 | `extractContent` 对 `tool_result` 只输出 `[工具结果]` 标签 | 展开实际内容 |
| 13 | 导出文件名是 uuid 乱码 | Content-Disposition 直接用了 sessionId | 改为会话标题（URL 编码） |
| 14 | 备份 history git commit 静默失败 | `asyncRunBackup` 中 `wd` 变量未定义（第 332 行） | 补 `const wd = store.BACKUP_WORKSPACE` |
| 15 | 活跃会话最后一行写一半时预览全空 | `getSessionContent` 用 `.map(JSON.parse)` 单行失败整条崩 | 改为逐行 try-catch |

**模式总结**：bug 集中在三个方向——
- **Windows 兼容**：`execSync` vs `execFileSync`、跨盘符、CRLF
- **缺失 require**：`path`、引用变量未定义
- **数据结构假设**：Claude jsonl 的 `msg.message.content` vs `msg.content` 不分

---

## 六、已知待办 / 可扩展方向

- [ ] **Gemini 适配器**：用户本地无 Gemini CLI 数据，适配器已删，需要时可重写
- [ ] **Mac/Linux 移植**：`xcopy` 改为 `cp -r`，`2>nul` 改为 `2>/dev/null`
- [ ] **CI/CD**：可以加 GitHub Actions 跑 `npm test`
- [ ] **npm 发布**：如果用户想 `npm install -g cc-manager` 直接安装
- [ ] **会话内容搜索高亮**：搜索结果只显示匹配数，没展示匹配片段
- [ ] **大文件优化**：`getSessions` 读整个 jsonl 文件来计数，大会话（>5000 条）可能慢
- [ ] **WebDAV 恢复**：目前只支持从 git commit 恢复，不支持从 WebDAV 备份恢复

---

## 七、运行方式

```bash
cd D:\claudecode\cc-manager
npm install          # 安装依赖（express + cors + chokidar）
npm start            # 启动 http://localhost:17890
npm test             # 跑单元测试
```

---

## 八、Git 托管

- GitHub 公开仓库：`https://github.com/hxy113/cc-manager`
- 当前最新 commit 哈希：`89e889a`
- 提交历史已抹过一次（用户要求），现有 7 条干净 commit
- token 通过 `CC_MANAGER_GH_TOKEN` 环境变量传入，不写进代码

---

## 九、用户偏好（与 AI 协作）

这些是从对话中总结的用户偏好，用于指导后续协作：

- 用户是 GitHub 新丁，git 概念需要边做边解释
- 前端 emoji 作为功能按钮可以保留，但 README 和 git commit 等对外地方不要用
- 文件不允许 `rm`，删除操作改为带时间戳名称移到 `D:\claudecode\trash\`
- 修改文件前旧版备份到 trash
- 所有 GitHub 账号级操作（建库、推送）需要用户亲手敲命令，AI 不代劳
- 用户希望任何恢复操作前先自动备份当前状态
- 默认备份目标是本地，不依赖外部服务
- 中文为主要交流语言，代码注释中英混用（中文注释在逻辑复杂处）

---

## 十、项目数据路径（用户本地）

| 用途 | 路径 |
|------|------|
| Claude 会话 | `C:\Users\ASUS\.claude\projects\` |
| Codex 会话 | `C:\Users\ASUS\.codex\sessions\` |
| cc-manager 元数据 | `C:\Users\ASUS\.cc-manager\` |
| 本地备份 | `C:\Users\ASUS\cc-manager-local-backups\` |
| 回收站 | `D:\claudecode\trash\` |
