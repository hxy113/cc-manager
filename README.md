<p align="center">
  <h1 align="center">cc-manager</h1>
  <p align="center">本地 AI CLI 会话管理与备份工具</p>
  <p align="center">
    支持 <b>Claude Code</b> · <b>Codex CLI</b>
  </p>
  <p align="center">
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow" alt="License"></a>
    <a href="https://github.com/hxy113/cc-manager/releases"><img src="https://img.shields.io/github/v/release/hxy113/cc-manager" alt="Version"></a>
    <a href="https://github.com/hxy113/cc-manager/commits/main"><img src="https://img.shields.io/github/last-commit/hxy113/cc-manager" alt="Last Commit"></a>
    <img src="https://img.shields.io/github/repo-size/hxy113/cc-manager" alt="Repo Size">
  </p>
</p>

---

**cc-manager** 是一个本地 Web UI 工具，用于浏览、管理和备份 **Claude Code** 和 **Codex CLI** 的本地会话记录。

### 它能做什么

| 场景 | 怎么做 |
|------|--------|
| 在 `D:\claudecode` 下聊了一大堆，想翻某条记录 | 打开 cc-manager，按项目找到会话，右侧直接预览 |
| 会话太多了，找不到了 | 搜索标题 + 内容，还支持正则 |
| 某个回复挺好用的，想在此基础上重开一局 | Fork 当前会话，生成新的 sessionId |
| 怕对话丢了怎么办 | 三路备份：本地目录 + GitHub 私有仓库 + WebDAV，默认全自动 |

---

## 功能

- **三栏 UI**：左侧选 CLI + 项目 → 中间列会话 → 右侧预览聊天（用户输入蓝底，AI 回复绿底，工具结果灰底折叠）
- **跨项目会话管理**：Claude 按原路径分项目（`D:\claudecode`、`D:\Qt\...`），Codex 按工作目录聚合
- **内容搜索**：默认搜索标题+内容全文，支持正则模式
- **用户输入导航**：长对话时打开侧栏，点击跳转到任意用户输入位置
- **别名 / 收藏**：给会话起易记名，收藏置顶
- **Fork**：复制会话为新副本，改造旧对话时不影响原版
- **安全删除**：文件移至 `trash/`（带时间戳），物理保留可恢复
- **三路备份**：本地文件 + GitHub 私有仓库 + WebDAV，一键或自动
- **Markdown 导出**：把单条对话导出为 `.md` 文件
- **纯浏览器端界面**：零构建工具链，打开即用

---

## 快速开始

### 前提

- [Node.js](https://nodejs.org/) >= 18
- 本地已有 Claude Code 或 Codex CLI 的使用记录（有 .jsonl 会话文件）

### 运行

```bash
# 克隆 / 下载
git clone https://github.com/hxy113/cc-manager.git
cd cc-manager

# 安装依赖
npm install

# 启动
npm start

# 浏览器打开
open http://localhost:17890
```

> 默认端口 17890，可通过 `npm start -- 9000` 指定其他端口。

---

## 界面概览

```
+------------------------------------------------------+
| cc-manager  [状态] [一键备份] [恢复] [设置]          |
+----------+-------------------+------------------------+
| Claude   |  排序    搜索     |  会话内容预览           |
| Codex    |                  |                         |
|          |  怎么改路径       |  USER                  |
| 项目列表  |  爬虫方案         |  如何更改Windows...   |
| D:\code  |  安卓程序         |                         |
| D:\qt    |  已删除会话       |  ASSISTANT             |
|          |                  |  你可以通过设置...      |
+----------+-------------------+------------------------+
| 用户输入导航  <- 点击展开，快速跳转                    |
+------------------------------------------------------+
```

### 三栏说明

| 区域 | 内容 |
|------|------|
| **左栏** | 顶部切换 Claude / Codex；下面列出该 CLI 下的所有项目文件夹（显示原路径） |
| **中栏** | 选中某项目后列出所有会话；支持按时间、名称、消息数排序；搜索框支持标题+内容+正则 |
| **右栏** | 单击会话后预览完整聊天记录，user/assistant/tool 按角色分色渲染 |

---

## 备份配置

cc-manager 提供三种备份方式，可在 UI 的设置面板中配置：

| 方式 | 配置 | 特点 |
|------|------|------|
| **本地文件** | 默认即可 | 零依赖，一定会成功，备份到 `~/cc-manager-local-backups/` |
| **GitHub 仓库** | 填入仓库 URL | 版本化管理，可回滚任意历史版本；需环境变量 `CC_MANAGER_GH_TOKEN` |
| **WebDAV** | 填入服务器 URL + 用户名 | 可对接自建云盘（Nextcloud、ownCloud 等）；密码设环境变量 `CC_MANAGER_WEBDAV_PASS` |

备份目标可选「本地」「GitHub」「WebDAV」「全部」四种模式。默认「本地文件」，开箱即用。

备份周期可在设置中调整（默认 60 分钟），也可随时点顶栏的「一键备份」手动触发。

> 安全设计：GitHub token 和 WebDAV 密码仅通过环境变量读取，代码不硬编码。

---

## 项目结构

```
cc-manager/
├── server/               # 后端（Node.js + Express）
│   ├── index.js          # CLI 入口（ui / backup / restore 子命令）
│   ├── server.js         # HTTP 服务器 + 自动备份定时器
│   ├── routes.js         # REST API 路由
│   ├── store.js          # 元数据持久化 + Markdown 导出
│   ├── backup.js         # 三路备份（本地/GitHub/WebDAV）+ 恢复
│   └── adapters/
│       ├── claude.js     # Claude 会话适配器
│       └── codex.js      # Codex 会话适配器
├── web/                  # 前端（纯 HTML + CSS + JS）
│   └── index.html        # 三栏单页应用
├── package.json
├── LICENSE (MIT)
└── README.md
```

---

## 技术栈

| 层 | 选型 | 理由 |
|----|------|------|
| 后端 | Node.js + Express | 跨平台，零额外运行时，npm 生态 |
| 前端 | 原生 HTML + CSS + JS | 零构建依赖，clone 即用，无需 webpack/vite |
| 数据源 | .jsonl 文件 | Claude Code / Codex CLI 原生存储格式，直接读取 |
| 备份 Git | 内嵌 git 工作区 | 版本管理，增量 commit，可回滚到任意历史点 |

---

## 许可证

[MIT](LICENSE) (c) 2026 cc-manager contributors
