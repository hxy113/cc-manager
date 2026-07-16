// 在新终端窗口把会话打开到对应 CLI（claude --resume / codex resume）
// 设计要点：
// - sessionId 严格校验（仅字母数字连字符），杜绝命令注入
// - cwd 解析后校验存在性，不存在则报错而非盲目启动
// - 用 detached spawn 创建新控制台窗口，cwd 直接落到工程目录，
//   命令本身无 cd/&&/管道，规避 Windows cmd 引号与特殊字符陷阱
const fs = require('fs');
const { spawn } = require('child_process');
const claudeAdapter = require('./adapters/claude');

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

// 构造 resume 命令字符串（sessionId 已校验为白名单字符，无 shell 特殊字符）
function buildOpenCommand(cli, sessionId) {
  if (cli === 'claude') return `claude --resume ${sessionId}`;
  if (cli === 'codex') return `codex resume ${sessionId}`;
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

  try {
    // Windows: detached 创建新控制台窗口，cwd 落到工程目录；/k 保留窗口便于看错误
    const child = spawn('cmd', ['/k', cmd], {
      cwd,
      detached: true,
      stdio: 'ignore',
      shell: false
    });
    child.unref();
    return { ok: true, message: `已在新终端打开（${cwd}）`, cwd, cmd };
  } catch (e) {
    return { ok: false, error: '启动终端失败：' + e.message };
  }
}

module.exports = { openSession, resolveCwd, buildOpenCommand, isValidSessionId };
