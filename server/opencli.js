// 在新终端窗口把会话打开到对应 CLI（claude --resume / codex resume）
// 设计要点：
// - sessionId 严格校验（仅字母数字连字符），杜绝命令注入
// - cwd 解析后校验存在性，不存在则报错而非盲目启动
// - 用 detached spawn 创建新控制台窗口，cwd 直接落到工程目录，
//   命令本身无 cd/&&/管道，规避 Windows cmd 引号与特殊字符陷阱
// - 模块加载时自动解析 claude / codex 的绝对路径，避免新终端 PATH 继承不全
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const claudeAdapter = require('./adapters/claude');

// ========== 解析 CLI 绝对路径 ==========
let _claudePath = null;
let _codexPath = null;

function resolveFullPath(name) {
  try {
    const out = execFileSync('cmd', ['/c', 'where', name], { encoding: 'utf-8', timeout: 5000 });
    // 取第一条实际路径（去掉 .cmd 后缀以确保 cmd.exe 能执行）
    let p = out.trim().split('\n')[0].trim();
    if (!p) return null;
    // where 可能返回不带 .exe 的结果（如 D:\npm\codex）；cmd 的 PATHEXT 能解析，但用全名更稳
    return p;
  } catch (e) { return null; }
}

// 模块加载时解析一次，后续复用
_claudePath = resolveFullPath('claude');
_codexPath = resolveFullPath('codex');

// 安全白名单：sessionId 只允许字母、数字、下划线、连字符
const SAFE_ID = /^[a-zA-Z0-9_-]{8,}$/;
function isValidSessionId(id) {
  return typeof id === 'string' && SAFE_ID.test(id);
}

// 解析会话对应的工程目录（新终端要落到这里再 resume）
function resolveCwd(cli, projectName) {
  if (!projectName) return { error: '缺少 projectName' };
  if (cli === 'claude') {
    // claude 的 projectName 是编码后的目录名（如 D--claudecode），需反解
    const cwd = claudeAdapter.decodeProjectDir(projectName);
    if (!cwd) return { error: '无法解析项目目录：' + projectName };
    return { cwd };
  }
  if (cli === 'codex') {
    // codex 的 projectName 本身就是 cwd；'(未关联项目)' 表示无 cwd
    if (projectName === '(未关联项目)') return { error: '该会话无关联工作目录，无法打开' };
    return { cwd: projectName };
  }
  return { error: '未知 CLI：' + cli };
}

// 构造 resume 命令字符串（使用绝对路径，避免新控制台 PATH 继承问题）
function buildOpenCommand(cli, sessionId) {
  if (cli === 'claude') {
    const cliPath = _claudePath || 'claude';
    return `${cliPath} --resume ${sessionId}`;
  }
  if (cli === 'codex') {
    const cliPath = _codexPath || 'codex';
    return `${cliPath} resume ${sessionId}`;
  }
  return null;
}

// 在新终端窗口打开会话
function openSession(cli, sessionId, projectName) {
  if (!isValidSessionId(sessionId)) return { ok: false, error: '会话 ID 不合法' };
  const { cwd, error } = resolveCwd(cli, projectName);
  if (error) return { ok: false, error };
  if (!fs.existsSync(cwd)) return { ok: false, error: '工作目录不存在：' + cwd };
  const cmd = buildOpenCommand(cli, sessionId);
  if (!cmd) return { ok: false, error: '未知 CLI：' + cli };

  // 检查 cli 是否已解析到路径
  if (cli === 'claude' && !_claudePath) {
    return { ok: false, error: '未找到 claude 可执行文件（不在 PATH 中）' };
  }
  if (cli === 'codex' && !_codexPath) {
    return { ok: false, error: '未找到 codex 可执行文件（不在 PATH 中）' };
  }

  try {
    // Windows: detached 创建新控制台窗口，cwd 落到工程目录；/k 保留窗口便于看错误
    const child = spawn('cmd', ['/k', cmd], {
      cwd,
      detached: true,
      stdio: 'ignore',
      shell: false
    });
    child.unref();
    return { ok: true, message: `已在新终端打开（${cwd}）`, cwd, cmd, cliPath: cli === 'claude' ? _claudePath : _codexPath };
  } catch (e) {
    return { ok: false, error: '启动终端失败：' + e.message };
  }
}

module.exports = { openSession, resolveCwd, buildOpenCommand, isValidSessionId, resolveFullPath, getClaudePath: ()=>_claudePath, getCodexPath: ()=>_codexPath };
