# cc-manager 开发指南

本文规定当前仓库的开发与验证方式。先阅读[文档导航](./README.md)、[架构说明](./ARCHITECTURE.md)和[已知限制](./KNOWN_LIMITATIONS.md)。

## 环境

- Node.js 18+
- npm
- Git（只在 Git 备份和仓库操作中需要）
- 主要验证平台：Windows 10/11 + PowerShell

```powershell
npm install
npm start
npm test
```

后端没有热重载，修改 `server/*` 后必须重启。指定测试端口：

```powershell
node server/index.js ui 17891
```

## 代码边界

### 会话文件

- 浏览、搜索和导出不得写会话文件。
- Fork/编辑必须 copy-on-write：创建新 ID、新文件，使用排他创建，不覆盖源会话。
- 删除必须先成功复制到 trash，再删除源文件。
- 恢复是明确授权的目录级写操作，执行前必须创建安全快照。
- Claude/Codex 活跃会话可能正在追加；JSONL 解析必须逐行容错。

### HTTP

- 服务保持绑定 `127.0.0.1`，并保留 loopback Host 校验。
- 不要重新开放任意 CORS；这是可修改本地文件的管理 API。
- 动态路径段由前端 `encodeURIComponent`，动态 HTML 文本必须转义。
- 新增写接口时同时考虑参数白名单、资源归属校验、幂等/冲突和恢复策略。

### 文件与进程

- Git 命令使用 `execFileSync('git', args)`，不要拼 shell 字符串。
- 目录复制使用 Node 文件 API，不回退到 `xcopy`/`cp` shell 命令。
- 跨盘移动不能假设 `rename` 成功；删除路径当前采用复制后删除。
- 不要吞掉未捕获异常继续运行；进程级未知异常可能意味着状态不可信。
- 用户现有工作树改动不属于本任务时不得覆盖或清理。

## 适配器

适配器必须实现：

```js
getProjects()
getSessions(projectName)
getSessionContent(sessionId, projectName)
searchSessionText(projectName, query, { isRegex })
getRawLines(sessionId, projectName)
writeFork(rawLines, srcFilePath, newId)
```

规则：

- `getSessionContent` 返回前端统一结构，可以 normalize；
- `getRawLines` 必须保留上游原始结构；
- `writeFork` 只能接收 raw lines，不能把 normalized 内容写回；
- 会话查找应精确匹配 ID和项目，不能用路径子串匹配；
- 项目路径必须被限制在上游会话根目录内。

新增适配器后需要同步：

1. `server/routes.js` 的 `adapters`；
2. 前端 CLI 标签；
3. `ARCHITECTURE.md` 数据格式；
4. `USER_GUIDE.md` 用户可见行为；
5. 适配器解析、搜索、Fork 的回归测试。

## 备份与恢复

- `selectBackupTargets` 是目标选择的单一实现；未知值必须安全回退。
- 工作区是可重建镜像，`.git` 必须保留。
- 自动本地 diff 和完整工作区是两种不同格式，不要混用。
- 任何本地恢复路径都必须先验证真实路径属于允许的备份根目录。
- Git checkout 后的工作区复原必须放在 `finally` 路径。
- 备份/恢复保持进程内互斥；未来增加跨进程锁时应覆盖异常退出。
- 修复 diff 链时必须考虑基准缺失、环、越界引用、Codex-only、删除 tombstone 和 full 恢复。

## 测试

`npm test` 运行 `test/run.js`。测试注册后在 `main()` 中逐个 `await`，不要恢复为“调用 async 函数但不等待”的模式。

要求：

- 修复 bug 必须增加能复现现象的回归测试；
- 文件测试使用 `os.tmpdir()`，不要依赖用户真实会话；
- 对外部工具只断言返回类型或可控行为，不假设每台机器都安装 Git/CLI；
- HTTP 测试启动服务时传 `{ enableAutoBackup: false }`；
- full 恢复在临时目录测试，并验证旧目录被归档；
- 前端至少做脚本语法检查；涉及交互时再做本地只读 UI 冒烟测试。

以下脚本会接触真实用户数据，不属于普通测试：

```powershell
$env:CC_MANAGER_E2E_ALLOW_REAL_DATA='1'
node test/e2e-check.js
node test/raw-edit-probe.js
```

`e2e-check.js` 只有在额外设置 `CC_MANAGER_E2E_ALLOW_OPEN=1` 时才真正打开 CLI 窗口。运行这些脚本前必须确认副作用和清理路径。

## 文档维护

- 当前行为写入 `README.md`、`USER_GUIDE.md`、`API.md`、`ARCHITECTURE.md`、`KNOWN_LIMITATIONS.md`。
- 历史行为写入 `CHANGELOG.md`；不要为了让旧记录“看起来当前”而改写历史语义。
- `HANDOVER.md` 是 2026-07-17 档案，不得再作为当前事实来源。
- 新增/删除路由必须同步 `API.md`；配置默认值变化必须同步用户指南；备份语义变化必须同步用户指南、架构和限制。
- 文档中的默认值应能追溯到代码常量，不写“通常”“默认全自动”一类无法验证的宣传语。
- 相对链接应从所在 Markdown 文件解析正确；提交前运行链接与代码符号检查。

## Git 与提交

- 提交信息使用 `fix:` / `feat:` / `test:` / `docs:` / `chore:` 前缀，正文中文即可。
- 一个逻辑改动一个 commit；不要把无关格式化混入功能修复。
- 不 force push，不擅自删除远程分支。
- 账号级 GitHub 操作由用户执行，除非当次会话明确授权。
- 按项目约定，修改重要文件前把旧版保存到 `D:\claudecode\trash\`。

## GitHub 工程约定

- `.github/workflows/ci.yml` 在 Windows/Linux、Node 18/22 上运行 `npm ci` 与 `npm test`。
- Dependabot 每月检查 npm 与 GitHub Actions 依赖；Express 大版本升级需要单独迁移和验证，因此自动版本 PR 忽略 semver-major，安全更新不受该规则影响。
- PR 必须填写验证、文档、安全与风险清单；会话数据不得作为公开测试附件。
- `CODEOWNERS` 当前由 `@hxy113` 负责全部路径。
- `SECURITY.md` 规定漏洞优先私密报告；公开 issue 不得包含会话、凭据或私有源码。
- `main` 是当前唯一受支持分支；建立稳定发布节奏前不添加自动 Release 流水线。
