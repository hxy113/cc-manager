const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');
const store = require('./store');

// ========== 构建备份工作区的快照 ==========

// 清空工作区文件但保留 .git（备份工作区是可随时重建的镜像，非用户数据）
function wipeWorkspace(dir) {
  const workspace = dir || store.BACKUP_WORKSPACE;
  const gitDir = path.join(workspace, '.git');
  let entries;
  try { entries = fs.readdirSync(workspace); } catch (e) { return; }
  for (const entry of entries) {
    const full = path.join(workspace, entry);
    if (full !== gitDir) fs.rmSync(full, { recursive: true, force: true });
  }
}

function ensureBackupGit() {
  // 确保备份工作区是一个 git 仓库
  if (!fs.existsSync(path.join(store.BACKUP_WORKSPACE, '.git'))) {
    store.ensureDir(store.BACKUP_WORKSPACE);
    runGit(['init', '-b', 'main'], store.BACKUP_WORKSPACE);
    runGit(['config', 'user.name', 'cc-manager'], store.BACKUP_WORKSPACE);
    runGit(['config', 'user.email', 'cc-manager@local'], store.BACKUP_WORKSPACE);
    // 初次空提交，让 git log 可以工作
    runGit(['commit', '--allow-empty', '-m', 'backup workspace initialized'], store.BACKUP_WORKSPACE);
  }
}

function buildBackupSnapshot() {
  ensureBackupGit();
  store.ensureDir(store.BACKUP_WORKSPACE);

  // 清理旧快照（保留 .git）
  wipeWorkspace();

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
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 30000 });
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

// 纯函数：根据 backupTarget 决定要跑哪些备份目标（便于单元测试）
// 'all' -> github+webdav+local；'both'（向后兼容）-> github+webdav；
// 单项目标按字面值；未知/未配置 -> 兜底本地（保证不会静默空跑）
function selectBackupTargets(target) {
  if (target === 'all') return ['github', 'webdav', 'local'];
  if (target === 'both') return ['github', 'webdav'];
  if (['github', 'webdav', 'local'].includes(target)) return [target];
  return ['local'];
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

  // 用统一的纯函数决定目标列表（保证默认/未知配置不会静默空跑）
  const targets = selectBackupTargets(config.backupTarget);
  for (const t of targets) {
    if (t === 'github') {
      results.push({ target: 'github', ...(config.repoUrl ? doGitBackup(config, timestamp) : { ok: false, error: '未配置仓库 URL' }) });
    } else if (t === 'webdav') {
      if (config.webdavUrl) {
        const r = await doWebdavBackup(config, timestamp);
        results.push({ target: 'webdav', ...r });
      } else {
        results.push({ target: 'webdav', ok: false, error: '未配置 WebDAV URL' });
      }
    } else if (t === 'local') {
      results.push({ target: 'local', ...(await doLocalBackup(config, timestamp)) });
    }
  }

  // 无论哪种备份方式，都对 workspace git 做一次提交以便恢复历史可查
  try {
    const wd = store.BACKUP_WORKSPACE;
    runGit(['add', '-A'], wd);
    const raw = runGit(['status', '--porcelain'], wd);
    if (raw.trim()) {
      runGit(['commit', '-m', `backup ${timestamp}`], wd);
    }
  } catch (e) {
    // workspace git 提交失败不影响备份本身
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
    // Windows CMD 会把 | 解释为管道，所以用逗号分隔再替换
    const log = runGit(['log', `--format=%H__%ct__%s`, `-${limit}`], store.BACKUP_WORKSPACE);
    return log.trim().split('\n').filter(Boolean).map(line => {
      const [hash, ts, ...msgParts] = line.split('__');
      return { hash, timestamp: parseInt(ts) * 1000, message: msgParts.join('__') };
    });
  } catch (e) { return []; }
}

// 从某个 commit 恢复（mode: incremental / merge / full）
async function restoreFromCommit(hash, cli, mode) {
  if (!fs.existsSync(path.join(store.BACKUP_WORKSPACE, '.git'))) {
    return { ok: false, error: '备份仓库不存在' };
  }
  mode = mode || 'incremental';  // 默认增量

  try {
    // 1. 恢复前安全备份当前状态
    const safeTs = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 19);
    const backupDir = path.join(os.homedir(), 'cc-manager-local-backups', `pre-restore-${safeTs}`);
    const claudeSrc = path.join(os.homedir(), '.claude', 'projects');
    const codexSrc = path.join(os.homedir(), '.codex', 'sessions');
    fs.mkdirSync(backupDir, { recursive: true });
    if (fs.existsSync(claudeSrc)) {
      execSync(`xcopy "${claudeSrc}" "${path.join(backupDir, 'claude-sessions')}" /E /I /Q /Y > nul 2>&1`, { timeout: 30000 });
    }
    if (fs.existsSync(codexSrc)) {
      execSync(`xcopy "${codexSrc}" "${path.join(backupDir, 'codex-sessions')}" /E /I /Q /Y > nul 2>&1`, { timeout: 30000 });
    }

    // 2. 清空工作区（保留 .git）后检出目标 commit
    //    先清空保证工作区严格等于该 commit，不会残留后续备份新增的文件
    wipeWorkspace();
    runGit(['checkout', hash, '--', '.'], store.BACKUP_WORKSPACE);

    // 3. 根据模式复制
    const claudeSrcBackup = path.join(store.BACKUP_WORKSPACE, 'claude-sessions');
    const codexSrcBackup = path.join(store.BACKUP_WORKSPACE, 'codex-sessions');

    if (!cli || cli === 'claude') {
      copyWithMode(claudeSrcBackup, claudeSrc, mode);
    }
    if (!cli || cli === 'codex') {
      copyWithMode(codexSrcBackup, codexSrc, mode);
    }

    // 4. 恢复工作区到当前分支（HEAD）
    //    git checkout <hash> -- . 会同时改 index+worktree，git checkout -- . 只从（已被污染的）index 还原，无法回到 HEAD
    //    必须用 git reset --hard HEAD 才能把 index+worktree 都恢复到最新备份
    try {
      runGit(['reset', '--hard', 'HEAD'], store.BACKUP_WORKSPACE);
    } catch (e) { /* 忽略 */ }

    store.updateConfig({ lastRestoreAt: Date.now() });
    return {
      ok: true,
      message: `已从 ${hash.slice(0, 8)} ${mode}恢复，恢复前已备份到 ${backupDir}`,
      safetyBackup: backupDir
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 按模式复制文件
function copyWithMode(srcDir, destDir, mode) {
  if (!fs.existsSync(srcDir)) return;

  const files = [];
  function walk(dir, relative) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, path.join(relative, entry.name));
      } else {
        files.push({ src: full, rel: path.join(relative, entry.name) });
      }
    }
  }
  walk(srcDir, '');

  for (const f of files) {
    const destFile = path.join(destDir, f.rel);
    switch (mode) {
      case 'incremental':
        // 仅当目标不存在时复制
        if (!fs.existsSync(destFile)) {
          fs.mkdirSync(path.dirname(destFile), { recursive: true });
          fs.copyFileSync(f.src, destFile);
        }
        break;
      case 'merge':
        // 存在就覆盖，不存在就添加；目标有但备份无的不动
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.copyFileSync(f.src, destFile);
        break;
      case 'full':
        // 完全覆盖（xcopy /Y 行为）
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.copyFileSync(f.src, destFile);
        break;
    }
  }
}

module.exports = {
  buildBackupSnapshot,
  gitInit,
  gitSetRemote,
  asyncRunBackup,
  listBackupHistory,
  restoreFromCommit,
  gitAvailable,
  webdavTestConnection,
  selectBackupTargets,
  copyWithMode,
  wipeWorkspace
};
