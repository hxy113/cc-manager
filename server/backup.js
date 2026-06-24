const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const store = require('./store');

// ========== 构建备份工作区的快照 ==========

function buildBackupSnapshot() {
  store.ensureDir(store.BACKUP_WORKSPACE);

  // 清理旧快照（保留 .git）
  const gitDir = path.join(store.BACKUP_WORKSPACE, '.git');
  const entries = fs.readdirSync(store.BACKUP_WORKSPACE);
  for (const entry of entries) {
    const full = path.join(store.BACKUP_WORKSPACE, entry);
    if (full !== gitDir) fs.rmSync(full, { recursive: true, force: true });
  }

  // 复制 Claude 会话
  const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
  if (fs.existsSync(claudeProjects)) {
    const dest = path.join(store.BACKUP_WORKSPACE, 'claude-sessions');
    try {
      execSync(`xcopy "${claudeProjects}" "${dest}" /E /I /Q /Y > nul 2>&1`, { timeout: 30000 });
    } catch (e) { /* xcopy 可能失败 */ }
  }

  // 复制 Codex 会话
  const codexSessions = path.join(os.homedir(), '.codex', 'sessions');
  if (fs.existsSync(codexSessions)) {
    const dest = path.join(store.BACKUP_WORKSPACE, 'codex-sessions');
    try {
      execSync(`xcopy "${codexSessions}" "${dest}" /E /I /Q /Y > nul 2>&1`, { timeout: 30000 });
    } catch (e) { /* 同上 */ }
  }

  // 复制 cc-manager 自身元数据
  const metaFile = path.join(store.CC_MANAGER_DIR, 'meta.json');
  if (fs.existsSync(metaFile)) {
    fs.copyFileSync(metaFile, path.join(store.BACKUP_WORKSPACE, 'cc-manager-meta.json'));
  }
}

// ========== Git 操作 ==========

function runGit(args, cwd) {
  const cmd = `git ${args.join(' ')}`;
  return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 30000 });
}

function gitAvailable() {
  try { execSync('git --version', { encoding: 'utf-8', timeout: 5000 }); return true; }
  catch (e) { return false; }
}

// init workspace git 仓库（首次使用时由 backup --init 调用）
function gitInit() {
  if (!gitAvailable()) return { ok: false, error: '需要安装 git（https://git-scm.com/downloads）' };
  store.ensureDir(store.BACKUP_WORKSPACE);
  try {
    runGit(['init', '-b', 'main'], store.BACKUP_WORKSPACE);
    runGit(['config', 'user.name', 'cc-manager'], store.BACKUP_WORKSPACE);
    runGit(['config', 'user.email', 'cc-manager@local'], store.BACKUP_WORKSPACE);
    // 写入 .gitignore
    fs.writeFileSync(path.join(store.BACKUP_WORKSPACE, '.gitignore'), 'node_modules/\n.DS_Store\n');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 设置远程仓库
function gitSetRemote(repoUrl) {
  try {
    runGit(['remote', 'remove', 'origin'], store.BACKUP_WORKSPACE);
  } catch (e) { /* 没有 remote 正常 */ }
  try {
    runGit(['remote', 'add', 'origin', repoUrl], store.BACKUP_WORKSPACE);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 执行一次增量备份（支持 GitHub 和/或 WebDAV）
function runBackup() {
  const config = store.getConfig();

  try {
    buildBackupSnapshot();
    const timestamp = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 19);
    let results = [];

    if (config.backupTarget === 'github' || config.backupTarget === 'both') {
      if (!config.repoUrl) {
        results.push({ target: 'github', ok: false, error: '未配置仓库 URL' });
      } else {
        const gitResult = doGitBackup(config, timestamp);
        results.push({ target: 'github', ...gitResult });
      }
    }

    if (config.backupTarget === 'webdav' || config.backupTarget === 'both') {
      if (!config.webdavUrl) {
        results.push({ target: 'webdav', ok: false, error: '未配置 WebDAV URL' });
      } else {
        const webdavResult = doWebdavBackup(config, timestamp);
        results.push({ target: 'webdav', ...webdavResult });
      }
    }

    config.lastBackupAt = Date.now();
    store.updateConfig({ lastBackupAt: config.lastBackupAt });

    // 汇总结果
    const allOk = results.every(r => r.ok);
    const messages = results.map(r => r.target + ': ' + (r.message || r.error || '?'));
    return { ok: allOk, message: messages.join('; '), timestamp, results };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function doGitBackup(config, timestamp) {
  if (!fs.existsSync(path.join(store.BACKUP_WORKSPACE, '.git'))) {
    return { ok: false, error: '本地 git 仓库未初始化' };
  }
  try {
    runGit(['add', '-A'], store.BACKUP_WORKSPACE);
    const status = runGit(['status', '--porcelain'], store.BACKUP_WORKSPACE);
    if (!status.trim()) {
      return { ok: true, message: '无变更，跳过', skipped: true };
    }
    runGit(['commit', '-m', `backup ${timestamp}`], store.BACKUP_WORKSPACE);

    const token = process.env.CC_MANAGER_GH_TOKEN || '';
    if (token) {
      const authedUrl = config.repoUrl.replace('https://', `https://${token}@`);
      try {
        runGit(['push', authedUrl, config.branch], store.BACKUP_WORKSPACE);
        return { ok: true, message: `推送完成 (${timestamp})` };
      } catch (e) {
        try {
          runGit(['push', 'origin', config.branch], store.BACKUP_WORKSPACE);
          return { ok: true, message: `推送完成 (${timestamp})` };
        } catch (e2) {
          return { ok: true, message: `本地已提交 (${timestamp})`, pushError: e2.message };
        }
      }
    }
    return { ok: true, message: `本地已提交 (${timestamp})` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ========== WebDAV 操作 ==========

// 用 https/http 模块发 WebDAV 请求
function webdavRequest(method, urlPath, baseUrl, auth, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const mod = url.protocol === 'https:' ? require('https') : require('http');
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: { 'User-Agent': 'cc-manager' }
    };
    if (auth) {
      const b64 = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      opts.headers.Authorization = `Basic ${b64}`;
    }
    if (body) {
      opts.headers['Content-Length'] = Buffer.byteLength(body);
      opts.headers['Content-Type'] = 'application/octet-stream';
    }

    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, statusText: res.statusMessage, data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('WebDAV 请求超时')); });
    if (body) req.write(body);
    req.end();
  });
}

// 确保远程目录存在（递归 MKCOL）
async function webdavEnsureDir(dirPath, baseUrl, auth) {
  const parts = dirPath.replace(/\\/g, '/').split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += '/' + part;
    try {
      const res = await webdavRequest('MKCOL', current, baseUrl, auth);
      // 405 = already exists (MKCOL on existing dir), 201 = created
      if (res.status !== 201 && res.status !== 405 && res.status !== 301) {
        // 可能 MKCOL 不支持——部分服务器只认 PROPFIND + PUT
      }
    } catch (e) { /* 网络错误跳过 */ }
  }
}

// WebDAV 备份：上传整个备份工作区
async function doWebdavBackup(config, timestamp) {
  const baseUrl = config.webdavUrl.replace(/\/+$/, '');
  const auth = { username: config.webdavUsername || '', password: process.env.CC_MANAGER_WEBDAV_PASS || '' };
  const backupDir = `cc-manager-backup-${timestamp}`;

  try {
    await webdavEnsureDir(backupDir, baseUrl, auth);

    // 遍历 backup-workspace 并上传
    const files = [];
    function walk(dir, relative) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '.git') walk(full, relative + '/' + entry.name);
        } else {
          files.push({ local: full, remote: backupDir + '/' + relative.replace(/\\/g, '/') + '/' + entry.name });
        }
      }
    }
    walk(store.BACKUP_WORKSPACE, '');

    let uploaded = 0;
    for (const f of files) {
      try {
        const content = fs.readFileSync(f.local, 'utf-8');
        const res = await webdavRequest('PUT', f.remote, baseUrl, auth, content);
        if (res.status >= 200 && res.status < 300) uploaded++;
      } catch (e) { /* 单个文件失败跳过 */ }
    }

    return { ok: uploaded > 0, message: `上传了 ${uploaded}/${files.length} 个文件到 WebDAV`, uploaded };
  } catch (e) {
    return { ok: false, error: 'WebDAV 备份失败: ' + e.message };
  }
}

// 测试 WebDAV 连接
async function webdavTestConnection() {
  const config = store.getConfig();
  if (!config.webdavUrl) return { ok: false, error: '未配置 WebDAV URL' };

  const auth = { username: config.webdavUsername || '', password: process.env.CC_MANAGER_WEBDAV_PASS || '' };
  try {
    const res = await webdavRequest('PROPFIND', '/', config.webdavUrl, auth);
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, message: 'WebDAV 连接正常' };
    }
    return { ok: false, error: `WebDAV 返回 ${res.status}: ${res.statusText}` };
  } catch (e) {
    return { ok: false, error: 'WebDAV 连接失败: ' + e.message };
  }
}

async function doLocalBackup(config, timestamp) {
  // 默认路径：~/cc-manager-local-backups/YYYY-MM-DD_HHmmss/
  const baseDir = config.localBackupDir || path.join(os.homedir(), 'cc-manager-local-backups');
  const backupDir = path.join(baseDir, timestamp);
  try {
    fs.mkdirSync(backupDir, { recursive: true });

    // 用 xcopy 复制（和 buildBackupSnapshot 同样策略）
    const src = store.BACKUP_WORKSPACE;
    if (fs.existsSync(src)) {
      execSync(`xcopy "${src}" "${backupDir}" /E /I /Q /Y > nul 2>&1`, { timeout: 30000 });
      return { ok: true, message: `已备份到 ${backupDir}` };
    }
    return { ok: false, error: '备份工作区不存在' };
  } catch (e) {
    return { ok: false, error: '本地备份失败: ' + e.message };
  }
}

async function asyncRunBackup() {
  const config = store.getConfig();
  buildBackupSnapshot();
  const timestamp = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 19);
  let results = [];

  // 判断是否应该运行某个目标
  const should = (target) => {
    if (config.backupTarget === 'all') return true;
    if (config.backupTarget === target) return true;
    return false;
  };
  // 'both' 向后兼容：运行 github + webdav
  const isBoth = config.backupTarget === 'both';
  if (should('github') || isBoth) {
    results.push({ target: 'github', ...(config.repoUrl ? doGitBackup(config, timestamp) : { ok: false, error: '未配置仓库 URL' }) });
  }
  if (should('webdav') || isBoth) {
    if (config.webdavUrl) {
      const r = await doWebdavBackup(config, timestamp);
      results.push({ target: 'webdav', ...r });
    } else {
      results.push({ target: 'webdav', ok: false, error: '未配置 WebDAV URL' });
    }
  }
  if (should('local') || config.backupTarget === 'all') {
    results.push({ target: 'local', ...(await doLocalBackup(config, timestamp)) });
  }
  // 默认（未配置 target 或无效值）至少跑本地备份
  if (!results.length) {
    results.push({ target: 'local', ...(await doLocalBackup(config, timestamp)) });
  }

  store.updateConfig({ lastBackupAt: Date.now() });
  const allOk = results.every(r => r.ok);
  const messages = results.map(r => r.target + ': ' + (r.message || r.error || '?'));
  return { ok: allOk, message: messages.join('; '), timestamp, results };
}

// 列出备份历史（git log）
function listBackupHistory(limit = 20) {
  if (!fs.existsSync(path.join(store.BACKUP_WORKSPACE, '.git'))) {
    return [];
  }
  try {
    const log = runGit(['log', `--format=%H|%ct|%s`, `-${limit}`], store.BACKUP_WORKSPACE);
    return log.trim().split('\n').filter(Boolean).map(line => {
      const [hash, ts, ...msgParts] = line.split('|');
      return { hash, timestamp: parseInt(ts) * 1000, message: msgParts.join('|') };
    });
  } catch (e) { return []; }
}

// 从某个 commit 恢复
function restoreFromCommit(hash, cli) {
  if (!fs.existsSync(path.join(store.BACKUP_WORKSPACE, '.git'))) {
    return { ok: false, error: '备份仓库不存在' };
  }
  try {
    // 检出到临时目录
    const tmpRestore = path.join(store.CC_MANAGER_DIR, 'restore-tmp');
    if (fs.existsSync(tmpRestore)) fs.rmSync(tmpRestore, { recursive: true, force: true });
    fs.mkdirSync(tmpRestore, { recursive: true });

    // 使用 git archive 或 checkout 提取文件
    runGit([`-C`, store.BACKUP_WORKSPACE, `archive`, hash, `--format=tar`], tmpRestore);
    // Windows 没有 tar，改用 checkout-index 方法
    const oldCwd = process.cwd();
    process.chdir(store.BACKUP_WORKSPACE);
    try {
      execSync(`git checkout ${hash} -- .`, { timeout: 10000, cwd: store.BACKUP_WORKSPACE });
      // 现在工作区处于指定 commit 状态，复制回原始位置
      if (!cli || cli === 'claude') {
        const src = path.join(store.BACKUP_WORKSPACE, 'claude-sessions');
        const dest = path.join(os.homedir(), '.claude', 'projects');
        if (fs.existsSync(src)) {
          execSync(`xcopy "${src}" "${dest}" /E /I /Q /Y > nul 2>&1`, { timeout: 30000 });
        }
      }
      if (!cli || cli === 'codex') {
        const src = path.join(store.BACKUP_WORKSPACE, 'codex-sessions');
        const dest = path.join(os.homedir(), '.codex', 'sessions');
        if (fs.existsSync(src)) {
          execSync(`xcopy "${src}" "${dest}" /E /I /Q /Y > nul 2>&1`, { timeout: 30000 });
        }
      }
      // 恢复当前工作区
      runGit(['checkout', '--', '.'], store.BACKUP_WORKSPACE);
    } finally {
      process.chdir(oldCwd);
    }

    store.updateConfig({ lastRestoreAt: Date.now() });
    return { ok: true, message: `已从 commit ${hash.slice(0, 8)} 恢复` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  buildBackupSnapshot,
  gitInit,
  gitSetRemote,
  runBackup,
  asyncRunBackup,
  listBackupHistory,
  restoreFromCommit,
  gitAvailable,
  webdavTestConnection
};
