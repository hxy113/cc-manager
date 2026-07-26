const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const store = require('./store');

const SYNC_FORMAT = 'cc-manager-sync-v1';
const SYNC_MANIFEST = '.sync-manifest.json';
const SYNC_REPO_DIR = '.cc-manager-sync';
const SYNC_CHUNK_SIZE = 4 * 1024 * 1024;

function copyDirectory(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
  return true;
}

function defaultLocalBackupDir() {
  return path.join(os.homedir(), 'cc-manager-local-backups');
}

function getLocalBackupRoots(config = store.getConfig()) {
  return [...new Set([config.localBackupDir, defaultLocalBackupDir()].filter(Boolean).map(p => path.resolve(p)))];
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

function isBackupDirectory(dir) {
  return fs.existsSync(path.join(dir, 'claude-sessions')) ||
    fs.existsSync(path.join(dir, 'codex-sessions')) ||
    fs.existsSync(path.join(dir, '.diff-ref')) ||
    fs.existsSync(path.join(dir, SYNC_MANIFEST));
}

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
    copyDirectory(claudeProjects, dest);
  }

  // 复制 Codex 会话
  const codexSessions = path.join(os.homedir(), '.codex', 'sessions');
  if (fs.existsSync(codexSessions)) {
    const dest = path.join(store.BACKUP_WORKSPACE, 'codex-sessions');
    copyDirectory(codexSessions, dest);
  }

  // 复制 cc-manager 自身元数据
  const metaFile = path.join(store.CC_MANAGER_DIR, 'meta.json');
  if (fs.existsSync(metaFile)) {
    fs.copyFileSync(metaFile, path.join(store.BACKUP_WORKSPACE, 'cc-manager-meta.json'));
  }
}

// ========== Git 操作 ==========

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function gitAvailable() {
  try { execFileSync('git', ['--version'], { encoding: 'utf-8', timeout: 5000 }); return true; }
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
    ensureBackupGit();
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!repoUrl) {
    try { runGit(['remote', 'remove', 'origin'], store.BACKUP_WORKSPACE); }
    catch (e) { /* 没有 remote 正常 */ }
    return { ok: true };
  }
  try {
    let hasOrigin = false;
    try {
      runGit(['remote', 'get-url', 'origin'], store.BACKUP_WORKSPACE);
      hasOrigin = true;
    } catch (e) { /* 尚未设置 origin */ }
    runGit(['remote', hasOrigin ? 'set-url' : 'add', 'origin', repoUrl], store.BACKUP_WORKSPACE);
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
  const baseDir = config.localBackupDir || defaultLocalBackupDir();
  const backupDir = path.join(baseDir, timestamp);
  try {
    fs.mkdirSync(backupDir, { recursive: true });

    const src = store.BACKUP_WORKSPACE;
    if (fs.existsSync(src)) {
      copyDirectory(src, backupDir);
      return { ok: true, message: `已备份到 ${backupDir}` };
    }
    return { ok: false, error: '备份工作区不存在' };
  } catch (e) {
    return { ok: false, error: '本地备份失败: ' + e.message };
  }
}

function toManifestPath(prefix, relative) {
  return [prefix, ...relative.split(path.sep)].filter(Boolean).join('/');
}

function isSafeManifestPath(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0')) return false;
  if (path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative) return false;
  return relative === 'cc-manager-meta.json' ||
    relative.startsWith('claude-sessions/') || relative.startsWith('codex-sessions/');
}

function readSyncManifest(snapshotDir) {
  const manifestPath = path.join(snapshotDir, SYNC_MANIFEST);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); }
  catch (e) { throw new Error(`同步快照清单不可读: ${e.message}`); }
  if (!manifest || manifest.format !== SYNC_FORMAT || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('同步快照清单格式无效');
  }
  for (const [relative, entry] of Object.entries(manifest.files)) {
    if (!isSafeManifestPath(relative) || !entry || !Array.isArray(entry.chunks) ||
        !/^[0-9a-f]{64}$/i.test(entry.sha256 || '') || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`同步快照文件记录无效: ${relative}`);
    }
    let chunkBytes = 0;
    for (const chunk of entry.chunks) {
      if (!chunk || !/^[0-9a-f]{64}$/i.test(chunk.sha256 || '') ||
          !Number.isSafeInteger(chunk.size) || chunk.size < 0 || chunk.size > SYNC_CHUNK_SIZE) {
        throw new Error(`同步快照数据块记录无效: ${relative}`);
      }
      chunkBytes += chunk.size;
    }
    if (chunkBytes !== entry.size) throw new Error(`同步快照文件大小不匹配: ${relative}`);
  }
  if (manifest.deleted && !Array.isArray(manifest.deleted)) throw new Error('同步快照回收站记录无效');
  for (const item of manifest.deleted || []) {
    if (!item || !isSafeManifestPath(item.path)) throw new Error('同步快照回收站路径无效');
  }
  return manifest;
}

function findPreviousSyncSnapshot(baseDir, preferredName) {
  const root = path.resolve(baseDir);
  let realRoot;
  try { realRoot = fs.realpathSync(root); }
  catch (e) { return null; }
  const candidates = [];
  if (preferredName && path.basename(preferredName) === preferredName) candidates.push(preferredName);
  try {
    const names = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('auto-'))
      .map(entry => entry.name).sort().reverse();
    candidates.push(...names);
  } catch (e) { /* 首次备份时目录可能不存在 */ }
  for (const name of [...new Set(candidates)]) {
    const candidate = path.resolve(root, name);
    let realCandidate;
    try { realCandidate = fs.realpathSync(candidate); }
    catch (e) { continue; }
    if (!isPathInside(realRoot, realCandidate) || !fs.existsSync(path.join(realCandidate, SYNC_MANIFEST))) continue;
    try { return { dir: realCandidate, manifest: readSyncManifest(realCandidate) }; }
    catch (e) { /* 损坏快照不能作为新快照的父级 */ }
  }
  return null;
}

function collectSyncSourceFiles(sourceRoots) {
  const files = [];
  for (const source of sourceRoots) {
    if (!source || !source.path || !fs.existsSync(source.path)) continue;
    if (source.file) {
      const stat = fs.statSync(source.path);
      if (stat.isFile()) files.push({ source: source.path, relative: source.prefix, stat });
      continue;
    }
    function walk(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (e) { throw new Error(`无法扫描同步源目录 ${dir}: ${e.message}`); }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const relative = toManifestPath(source.prefix, path.relative(source.path, full));
          files.push({ source: full, relative, stat: fs.statSync(full) });
        }
      }
    }
    walk(source.path);
  }
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  return files;
}

function writeDurableExclusive(filePath, content) {
  const fd = fs.openSync(filePath, 'wx');
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function storeFileAsChunks(filePath, objectRoot, maxBytes) {
  const fd = fs.openSync(filePath, 'r');
  const fileHash = crypto.createHash('sha256');
  const chunks = [];
  let bytesStored = 0;
  let newChunks = 0;
  let totalBytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(SYNC_CHUNK_SIZE);
    let bytesRead;
    do {
      const remaining = Math.max(0, maxBytes - totalBytes);
      if (!remaining) break;
      bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (!bytesRead) break;
      totalBytes += bytesRead;
      const content = Buffer.from(buffer.subarray(0, bytesRead));
      fileHash.update(content);
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      const objectPath = path.join(objectRoot, sha256.slice(0, 2), sha256);
      if (!fs.existsSync(objectPath)) {
        fs.mkdirSync(path.dirname(objectPath), { recursive: true });
        const tempPath = `${objectPath}.part-${process.pid}-${crypto.randomUUID()}`;
        writeDurableExclusive(tempPath, content);
        try {
          fs.renameSync(tempPath, objectPath);
          bytesStored += bytesRead;
          newChunks++;
        } catch (e) {
          if (!fs.existsSync(objectPath)) throw e;
          const collisionDir = path.join(path.dirname(objectRoot), 'trash', 'object-collisions');
          fs.mkdirSync(collisionDir, { recursive: true });
          fs.renameSync(tempPath, path.join(collisionDir, path.basename(tempPath)));
        }
      }
      chunks.push({ sha256, size: bytesRead });
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: fileHash.digest('hex'), chunks, size: totalBytes, bytesStored, newChunks };
}

function sameFileState(a, b) {
  return !!a && !!b && a.size === b.size && a.sha256 === b.sha256;
}

function sourceIdentity(stat) {
  return `${stat.dev || 0}:${stat.ino || 0}`;
}

function canReuseHashedFile(previous, stat) {
  return !!previous && previous.size === stat.size &&
    previous.mtimeMs === stat.mtimeMs && previous.ctimeMs === stat.ctimeMs &&
    previous.sourceIdentity === sourceIdentity(stat) &&
    Array.isArray(previous.chunks) && /^[0-9a-f]{64}$/i.test(previous.sha256 || '');
}

function defaultSyncSources() {
  return [
    { prefix: 'claude-sessions', path: path.join(os.homedir(), '.claude', 'projects') },
    { prefix: 'codex-sessions', path: path.join(os.homedir(), '.codex', 'sessions') },
    { prefix: 'cc-manager-meta.json', path: path.join(store.CC_MANAGER_DIR, 'meta.json'), file: true }
  ];
}

// 定时本地备份使用内容寻址快照：完整清单 + 仅新增的数据块 + 删除回收站记录。
function createSyncSnapshot({ baseDir, timestamp, previousName, sourceRoots = defaultSyncSources() }) {
  const root = path.resolve(baseDir);
  const repoDir = path.join(root, SYNC_REPO_DIR);
  const objectRoot = path.join(repoDir, 'objects');
  fs.mkdirSync(objectRoot, { recursive: true });

  const previous = findPreviousSyncSnapshot(root, previousName);
  const previousFiles = previous ? previous.manifest.files : {};
  for (const source of sourceRoots) {
    if (!source.file && source.path && !fs.existsSync(source.path) &&
        Object.keys(previousFiles).some(relative => relative.startsWith(source.prefix + '/'))) {
      throw new Error(`同步源目录缺失，拒绝把整类会话移入回收站: ${source.path}`);
    }
  }
  const currentFiles = {};
  let bytesStored = 0;
  let newChunks = 0;
  let changedFiles = 0;
  let reusedFiles = 0;
  let hashedFiles = 0;

  for (const file of collectSyncSourceFiles(sourceRoots)) {
    const previousEntry = previousFiles[file.relative];
    if (canReuseHashedFile(previousEntry, file.stat)) {
      currentFiles[file.relative] = previousEntry;
      reusedFiles++;
      continue;
    }
    const stored = storeFileAsChunks(file.source, objectRoot, file.stat.size);
    hashedFiles++;
    const entry = {
      size: stored.size,
      mtimeMs: file.stat.mtimeMs,
      ctimeMs: file.stat.ctimeMs,
      sourceIdentity: sourceIdentity(file.stat),
      sha256: stored.sha256,
      chunks: stored.chunks
    };
    currentFiles[file.relative] = entry;
    bytesStored += stored.bytesStored;
    newChunks += stored.newChunks;
    if (sameFileState(previousFiles[file.relative], entry)) reusedFiles++;
    else changedFiles++;
  }

  const deleted = Object.keys(previousFiles)
    .filter(relative => !currentFiles[relative])
    .sort()
    .map(relative => ({
      path: relative,
      deletedAt: new Date().toISOString(),
      previousSnapshot: previous.manifest.snapshotId,
      previousSha256: previousFiles[relative].sha256
    }));

  if (previous && changedFiles === 0 && deleted.length === 0) {
    return {
      ok: true, skipped: true, message: '无内容变更，跳过',
      dir: previous.dir, snapshotName: path.basename(previous.dir), bytesStored, newChunks,
      changedFiles: 0, reusedFiles, hashedFiles, deletedFiles: 0
    };
  }

  const snapshotName = `auto-${timestamp}`;
  const finalDir = path.join(root, snapshotName);
  if (fs.existsSync(finalDir)) throw new Error(`同步快照已存在: ${snapshotName}`);
  const stagingRoot = path.join(repoDir, 'staging');
  const stagingDir = path.join(stagingRoot, `${snapshotName}-${crypto.randomUUID()}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  const manifest = {
    format: SYNC_FORMAT,
    snapshotId: snapshotName,
    createdAt: new Date().toISOString(),
    parentSnapshot: previous ? previous.manifest.snapshotId : null,
    chunkSize: SYNC_CHUNK_SIZE,
    files: currentFiles,
    deleted,
    stats: {
      files: Object.keys(currentFiles).length,
      changedFiles, hashedFiles,
      reusedFiles,
      deletedFiles: deleted.length,
      newChunks,
      bytesStored
    }
  };
  writeDurableExclusive(path.join(stagingDir, SYNC_MANIFEST), JSON.stringify(manifest, null, 2));
  fs.renameSync(stagingDir, finalDir);
  return {
    ok: true,
    message: `同步快照：${changedFiles} 个变化，${deleted.length} 个移入回收站，新增 ${newChunks} 个数据块（${bytesStored} 字节）`,
    dir: finalDir, snapshotName, bytesStored, newChunks, changedFiles,
    reusedFiles, hashedFiles, deletedFiles: deleted.length
  };
}

async function doSyncBackup(config, timestamp) {
  const baseDir = config.localBackupDir || defaultLocalBackupDir();
  try {
    return createSyncSnapshot({ baseDir, timestamp, previousName: config.lastAutoBackupDir || '' });
  } catch (e) {
    return { ok: false, error: '同步备份失败: ' + e.message };
  }
}

let activeOperation = null;

function runExclusiveOperation(label, task) {
  if (activeOperation) {
    return Promise.resolve({ ok: false, error: `正在执行${activeOperation.label}，请稍后重试` });
  }
  const promise = Promise.resolve().then(task);
  activeOperation = { label, promise };
  return promise.finally(() => {
    if (activeOperation && activeOperation.promise === promise) activeOperation = null;
  });
}

function asyncRunBackup(isAuto) {
  return runExclusiveOperation('备份', () => runBackup(isAuto));
}

async function runBackup(isAuto) {
  const config = store.getConfig();
  const timestamp = new Date().toISOString().replace(/[T:.Z]/g, '-').replace(/-+$/, '');
  let results = [];
  let newAutoSnapshot = '';
  let snapshotReady = false;

  function ensureSnapshot() {
    if (!snapshotReady) {
      buildBackupSnapshot();
      snapshotReady = true;
    }
  }

  if (!isAuto) ensureSnapshot();

  const targets = selectBackupTargets(config.backupTarget);
  for (const t of targets) {
    if (t === 'github') {
      // Git/WebDAV 自动备份同样必须刷新工作区，不能上传上一次的陈旧快照。
      ensureSnapshot();
      results.push({ target: 'github', ...(config.repoUrl ? doGitBackup(config, timestamp) : { ok: false, error: '未配置仓库 URL' }) });
    } else if (t === 'webdav') {
      ensureSnapshot();
      if (config.webdavUrl) {
        const r = await doWebdavBackup(config, timestamp);
        results.push({ target: 'webdav', ...r });
      } else {
        results.push({ target: 'webdav', ok: false, error: '未配置 WebDAV URL' });
      }
    } else if (t === 'local') {
      if (isAuto) {
        const r = await doSyncBackup(config, timestamp);
        results.push({ target: 'local', ...r });
        if (r.ok && !r.skipped && r.snapshotName) newAutoSnapshot = r.snapshotName;
      } else {
        ensureSnapshot();
        results.push({ target: 'local', ...(await doLocalBackup(config, timestamp)) });
      }
    }
  }

  // 只有快照完成原子发布后，才推进同步仓库的父快照指针。
  if (isAuto && newAutoSnapshot) {
    store.updateConfig({ lastAutoBackupDir: newAutoSnapshot });
  }

  // 只要本轮实际构建过 workspace，就把快照记录进本地 git 历史。
  if (snapshotReady) {
    try {
      const wd = store.BACKUP_WORKSPACE;
      runGit(['add', '-A'], wd);
      const raw = runGit(['status', '--porcelain'], wd);
      if (raw.trim()) {
        runGit(['commit', '-m', `backup ${timestamp}`], wd);
      }
    } catch (e) {
      // workspace git 提交失败不影响已经完成的其他备份目标
    }
  }

  const allOk = results.every(r => r.ok);
  if (results.some(r => r.ok)) store.updateConfig({ lastBackupAt: Date.now() });
  const messages = results.map(r => r.target + ': ' + (r.message || r.error || '?'));
  return { ok: allOk, message: messages.join('; '), timestamp, results };
}

// 列出备份历史——合并两个来源，支持分页
function listBackupHistory({ page = 1, pageSize = 20 } = {}) {
  page = Number.isFinite(Number(page)) ? Math.max(1, Math.floor(Number(page))) : 1;
  pageSize = Number.isFinite(Number(pageSize)) ? Math.max(1, Math.min(100, Math.floor(Number(pageSize)))) : 20;
  // 第 1 步：收集全部条目（两个来源合并）
  let all = [];

  if (fs.existsSync(path.join(store.BACKUP_WORKSPACE, '.git'))) {
    try {
      // git log 全部拉出来（本地操作，数量不大）
      const log = runGit(['log', '--format=%H__%ct__%s', '--all'], store.BACKUP_WORKSPACE);
      const gitEntries = log.trim().split('\n').filter(Boolean).map(line => {
        const [hash, ts, ...msgParts] = line.split('__');
        return { id: hash, type: 'git', hash, timestamp: parseInt(ts) * 1000, message: msgParts.join('__') };
      });
      all.push(...gitEntries);
    } catch (e) { /* 忽略 */ }
  }

  for (const localDir of getLocalBackupRoots()) {
    if (!fs.existsSync(localDir)) continue;
    try {
      const dirs = fs.readdirSync(localDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && isBackupDirectory(path.join(localDir, e.name)));
      for (const entry of dirs) {
        const name = entry.name;
        let ts = 0;
        const normalizedName = name.replace(/^(pre-restore-|auto-)/, '');
        const p = normalizedName.split('-').map(Number);
        if (p.length >= 6 && !isNaN(p[0])) {
          ts = new Date(p[0], p[1] - 1, p[2], p[3] || 0, p[4] || 0, p[5] || 0).getTime();
        }
        if (ts) {
          all.push({ id: path.join(localDir, name), type: 'local', hash: name, timestamp: ts, message: `本地备份 ${name}` });
        }
      }
    } catch (e) { /* 忽略 */ }
  }

  // 去重 + 按时间降序
  const seen = new Set();
  all = all.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });
  all.sort((a, b) => b.timestamp - a.timestamp);

  // 第 2 步：分页
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = (safePage - 1) * pageSize;
  const entries = all.slice(start, start + pageSize);

  return { entries, total, page: safePage, pageSize, totalPages };
}

function createSafetyBackup() {
  const safeTs = new Date().toISOString().replace(/[T:.Z]/g, '-').replace(/-+$/, '');
  const safeDir = path.join(defaultLocalBackupDir(), `pre-restore-${safeTs}`);
  const claudeSrc = path.join(os.homedir(), '.claude', 'projects');
  const codexSrc = path.join(os.homedir(), '.codex', 'sessions');
  fs.mkdirSync(safeDir, { recursive: true });
  copyDirectory(claudeSrc, path.join(safeDir, 'claude-sessions'));
  copyDirectory(codexSrc, path.join(safeDir, 'codex-sessions'));
  return { safeDir, claudeSrc, codexSrc };
}

function validateRestoreOptions(cli, mode) {
  if (cli && !['claude', 'codex'].includes(cli)) throw new Error('cli 参数无效');
  if (!['incremental', 'merge', 'full'].includes(mode)) throw new Error('mode 参数无效');
}

function resolveAllowedLocalBackup(backupPath) {
  if (typeof backupPath !== 'string' || !backupPath.trim()) return null;
  let realCandidate;
  try { realCandidate = fs.realpathSync(path.resolve(backupPath)); }
  catch (e) { return null; }
  if (!fs.statSync(realCandidate).isDirectory() || !isBackupDirectory(realCandidate)) return null;

  for (const root of getLocalBackupRoots()) {
    try {
      const realRoot = fs.realpathSync(root);
      if (isPathInside(realRoot, realCandidate)) return realCandidate;
    } catch (e) { /* 尚不存在的备份根目录 */ }
  }
  return null;
}

// 从某个 commit 恢复（mode: incremental / merge / full）
function restoreFromCommit(hash, cli, mode) {
  return runExclusiveOperation('恢复', () => runRestoreFromCommit(hash, cli, mode));
}

async function runRestoreFromCommit(hash, cli, mode) {
  mode = mode || 'incremental';  // 默认增量
  try { validateRestoreOptions(cli, mode); }
  catch (e) { return { ok: false, error: e.message }; }
  if (typeof hash !== 'string' || !/^[0-9a-f]{7,64}$/i.test(hash)) {
    return { ok: false, error: '备份 commit hash 无效' };
  }
  if (!fs.existsSync(path.join(store.BACKUP_WORKSPACE, '.git'))) {
    return { ok: false, error: '备份仓库不存在' };
  }

  let workspaceMutated = false;
  let result;
  try {
    // 1. 恢复前安全备份当前状态
    const { safeDir: backupDir, claudeSrc, codexSrc } = createSafetyBackup();

    // 2. 清空工作区（保留 .git）后检出目标 commit
    //    先清空保证工作区严格等于该 commit，不会残留后续备份新增的文件
    wipeWorkspace();
    workspaceMutated = true;
    runGit(['checkout', hash, '--', '.'], store.BACKUP_WORKSPACE);

    // 3. 根据模式复制
    const claudeSrcBackup = path.join(store.BACKUP_WORKSPACE, 'claude-sessions');
    const codexSrcBackup = path.join(store.BACKUP_WORKSPACE, 'codex-sessions');
    if (cli === 'claude' && !fs.existsSync(claudeSrcBackup)) throw new Error('该备份不包含 Claude 会话');
    if (cli === 'codex' && !fs.existsSync(codexSrcBackup)) throw new Error('该备份不包含 Codex 会话');
    if (!cli && !fs.existsSync(claudeSrcBackup) && !fs.existsSync(codexSrcBackup)) {
      throw new Error('该 commit 不包含可恢复的会话');
    }

    if (!cli || cli === 'claude') {
      copyWithMode(claudeSrcBackup, claudeSrc, mode, path.join(backupDir, 'original-claude-sessions'));
    }
    if (!cli || cli === 'codex') {
      copyWithMode(codexSrcBackup, codexSrc, mode, path.join(backupDir, 'original-codex-sessions'));
    }

    store.updateConfig({ lastRestoreAt: Date.now() });
    result = {
      ok: true,
      message: `已从 ${hash.slice(0, 8)} ${mode}恢复，恢复前已备份到 ${backupDir}`,
      safetyBackup: backupDir
    };
  } catch (e) {
    result = { ok: false, error: e.message };
  } finally {
    // checkout 会同时改 index/worktree；无论复制成功与否都必须回到 HEAD。
    if (workspaceMutated) {
      try { runGit(['reset', '--hard', 'HEAD'], store.BACKUP_WORKSPACE); }
      catch (e) {
        result = { ok: false, error: `恢复后无法还原备份工作区: ${e.message}` };
      }
    }
  }
  return result;
}

// 按模式复制文件
function copyWithMode(srcDir, destDir, mode, fullArchiveDir) {
  if (!fs.existsSync(srcDir)) return;
  if (!['incremental', 'merge', 'full'].includes(mode)) throw new Error('mode 参数无效');

  if (mode === 'full') {
    if (fs.existsSync(destDir)) {
      if (!fullArchiveDir) throw new Error('full 模式必须提供原目录归档位置');
      if (fs.existsSync(fullArchiveDir)) throw new Error(`归档位置已存在: ${fullArchiveDir}`);
      fs.mkdirSync(path.dirname(fullArchiveDir), { recursive: true });
      fs.renameSync(destDir, fullArchiveDir);
    }
    fs.mkdirSync(destDir, { recursive: true });
  }

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
        // 目标目录已在遍历前清空，此处复制完整快照。
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.copyFileSync(f.src, destFile);
        break;
    }
  }
}

function syncObjectPath(snapshotDir, sha256) {
  return path.join(path.dirname(snapshotDir), SYNC_REPO_DIR, 'objects', sha256.slice(0, 2), sha256);
}

function verifySyncObjects(snapshotDir, manifest, prefixes) {
  const verified = new Map();
  for (const [relative, entry] of Object.entries(manifest.files)) {
    if (!prefixes.some(prefix => relative.startsWith(prefix + '/'))) continue;
    for (const chunk of entry.chunks) {
      if (verified.has(chunk.sha256)) {
        if (verified.get(chunk.sha256) !== chunk.size) throw new Error(`同步快照数据块大小冲突: ${chunk.sha256.slice(0, 12)}`);
        continue;
      }
      const objectPath = syncObjectPath(snapshotDir, chunk.sha256);
      let content;
      try { content = fs.readFileSync(objectPath); }
      catch (e) { throw new Error(`同步快照缺少数据块 ${chunk.sha256.slice(0, 12)}: ${e.message}`); }
      if (content.length !== chunk.size || crypto.createHash('sha256').update(content).digest('hex') !== chunk.sha256) {
        throw new Error(`同步快照数据块校验失败: ${chunk.sha256.slice(0, 12)}`);
      }
      verified.set(chunk.sha256, chunk.size);
    }
  }
}

function moveAside(existingPath, archivePath) {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  let target = archivePath;
  if (fs.existsSync(target)) target += `-${crypto.randomUUID()}`;
  fs.renameSync(existingPath, target);
  return target;
}

function writeSyncFile(snapshotDir, entry, destFile, archiveFile, failureDir) {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const tempFile = `${destFile}.restore-${crypto.randomUUID()}.part`;
  let fd;
  try {
    fd = fs.openSync(tempFile, 'wx');
    const fileHash = crypto.createHash('sha256');
    for (const chunk of entry.chunks) {
      const content = fs.readFileSync(syncObjectPath(snapshotDir, chunk.sha256));
      fileHash.update(content);
      fs.writeSync(fd, content);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (fileHash.digest('hex') !== entry.sha256) throw new Error(`恢复文件校验失败: ${destFile}`);

    let archived = null;
    if (fs.existsSync(destFile)) archived = moveAside(destFile, archiveFile);
    try {
      fs.renameSync(tempFile, destFile);
    } catch (e) {
      if (archived && !fs.existsSync(destFile)) fs.renameSync(archived, destFile);
      throw e;
    }
  } catch (e) {
    if (fd !== undefined && fd !== null) {
      try { fs.closeSync(fd); } catch (closeError) { /* 保留原始错误 */ }
    }
    if (fs.existsSync(tempFile)) {
      fs.mkdirSync(failureDir, { recursive: true });
      fs.renameSync(tempFile, path.join(failureDir, path.basename(tempFile)));
    }
    throw e;
  }
}

function applySyncSnapshot(snapshotDir, manifest, cli, mode, safeDir, targetRoots) {
  const available = ['claude', 'codex'].filter(name =>
    Object.keys(manifest.files).some(relative => relative.startsWith(`${name}-sessions/`)));
  const selected = cli ? [cli] : available;
  if (!selected.length) throw new Error('该同步快照不包含可恢复的会话');
  const prefixes = selected.map(name => `${name}-sessions`);
  for (const prefix of prefixes) {
    if (!Object.keys(manifest.files).some(relative => relative.startsWith(prefix + '/'))) {
      throw new Error(`该同步快照不包含 ${prefix === 'claude-sessions' ? 'Claude' : 'Codex'} 会话`);
    }
  }
  verifySyncObjects(snapshotDir, manifest, prefixes);

  const completedFull = [];
  try {
    for (const name of selected) {
      const prefix = `${name}-sessions`;
      const destRoot = targetRoots[name];
      const entries = Object.entries(manifest.files)
        .filter(([relative]) => relative.startsWith(prefix + '/'))
        .sort(([a], [b]) => a.localeCompare(b));
      let originalRoot = null;
      if (mode === 'full') {
        originalRoot = path.join(safeDir, `original-${prefix}`);
        if (fs.existsSync(destRoot)) moveAside(destRoot, originalRoot);
        fs.mkdirSync(destRoot, { recursive: true });
      }
      const state = { name, destRoot, originalRoot };
      if (mode === 'full') completedFull.push(state);

      for (const [relative, entry] of entries) {
        const suffix = relative.slice(prefix.length + 1).split('/');
        const destFile = path.join(destRoot, ...suffix);
        if (mode === 'incremental' && fs.existsSync(destFile)) continue;
        const archiveFile = path.join(safeDir, 'overwritten-by-restore', prefix, ...suffix);
        const failureDir = path.join(safeDir, 'failed-restore-files', prefix);
        writeSyncFile(snapshotDir, entry, destFile, archiveFile, failureDir);
      }
    }
  } catch (e) {
    if (mode === 'full') {
      for (const state of completedFull.reverse()) {
        if (fs.existsSync(state.destRoot)) {
          moveAside(state.destRoot, path.join(safeDir, `failed-${state.name}-restore`));
        }
        if (state.originalRoot && fs.existsSync(state.originalRoot)) {
          fs.renameSync(state.originalRoot, state.destRoot);
        }
      }
    }
    throw e;
  }
}

async function runRestoreFromSyncSnapshot(snapshotDir, manifest, cli, mode) {
  let safetyBackup = null;
  try {
    const safety = createSafetyBackup();
    safetyBackup = safety.safeDir;
    applySyncSnapshot(snapshotDir, manifest, cli, mode, safety.safeDir, {
      claude: safety.claudeSrc,
      codex: safety.codexSrc
    });
    store.updateConfig({ lastRestoreAt: Date.now() });
    const deletedCount = (manifest.deleted || []).length;
    return {
      ok: true,
      message: `已从 ${path.basename(snapshotDir)} ${mode}恢复（清单快照，含 ${deletedCount} 条回收站记录），恢复前已备份到 ${safety.safeDir}`,
      safetyBackup: safety.safeDir
    };
  } catch (e) {
    return { ok: false, error: e.message, ...(safetyBackup ? { safetyBackup } : {}) };
  }
}

// 从本地备份目录恢复
function restoreFromLocalBackup(backupPath, cli, mode) {
  return runExclusiveOperation('恢复', () => runRestoreFromLocalBackup(backupPath, cli, mode));
}

async function runRestoreFromLocalBackup(backupPath, cli, mode) {
  mode = mode || 'incremental';
  try { validateRestoreOptions(cli, mode); }
  catch (e) { return { ok: false, error: e.message }; }
  backupPath = resolveAllowedLocalBackup(backupPath);
  if (!backupPath) return { ok: false, error: '本地备份路径无效或不在允许的备份目录中' };

  if (fs.existsSync(path.join(backupPath, SYNC_MANIFEST))) {
    try {
      const manifest = readSyncManifest(backupPath);
      return await runRestoreFromSyncSnapshot(backupPath, manifest, cli, mode);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  const chain = [];
  // 构建链：从当前备份一路向上回溯到全量基准
  let current = backupPath;
  const visited = new Set();
  while (current && !visited.has(current)) {
    visited.add(current);
    chain.push(current);
    const refFile = path.join(current, '.diff-ref');
    if (fs.existsSync(refFile)) {
      try {
        const ref = JSON.parse(fs.readFileSync(refFile, 'utf-8'));
        if (ref.isDiff && ref.refDir && path.basename(ref.refDir) === ref.refDir) {
          const baseDir = path.dirname(backupPath);
          const parent = path.resolve(baseDir, ref.refDir);
          let realParent = null;
          try { realParent = fs.realpathSync(parent); } catch (e) { /* 引用已丢失 */ }
          if (realParent && isPathInside(baseDir, realParent) && isBackupDirectory(realParent)) {
            current = realParent;
            continue;
          }
        }
      } catch (e) { /* ref 损坏，终止回溯 */ }
    }
    break; // 没有 ref 或 ref 非法 → 这是全量基准
  }
  chain.reverse(); // 从最老到最新

  try {
    const hasClaudeBackup = chain.some(dir => fs.existsSync(path.join(dir, 'claude-sessions')));
    const hasCodexBackup = chain.some(dir => fs.existsSync(path.join(dir, 'codex-sessions')));
    if (cli === 'claude' && !hasClaudeBackup) throw new Error('该备份链不包含 Claude 会话');
    if (cli === 'codex' && !hasCodexBackup) throw new Error('该备份链不包含 Codex 会话');
    if (!cli && !hasClaudeBackup && !hasCodexBackup) throw new Error('该备份链不包含可恢复的会话');

    // 安全备份当前状态
    const { safeDir, claudeSrc, codexSrc } = createSafetyBackup();

    // 链式恢复：从全量基准开始，逐层叠加
    let appliedCount = 0;
    let claudeFullApplied = false;
    let codexFullApplied = false;
    for (const dir of chain) {
      const claudeBackup = path.join(dir, 'claude-sessions');
      const codexBackup = path.join(dir, 'codex-sessions');
      // full 对每种 CLI 只在首个有数据的层清空一次，后续 diff 采用 merge 叠加。
      if ((!cli || cli === 'claude') && fs.existsSync(claudeBackup)) {
        const applyMode = mode === 'full' ? (claudeFullApplied ? 'merge' : 'full') : mode;
        copyWithMode(claudeBackup, claudeSrc, applyMode, path.join(safeDir, 'original-claude-sessions'));
        claudeFullApplied = true;
      }
      if ((!cli || cli === 'codex') && fs.existsSync(codexBackup)) {
        const applyMode = mode === 'full' ? (codexFullApplied ? 'merge' : 'full') : mode;
        copyWithMode(codexBackup, codexSrc, applyMode, path.join(safeDir, 'original-codex-sessions'));
        codexFullApplied = true;
      }
      appliedCount++;
    }

    store.updateConfig({ lastRestoreAt: Date.now() });
    const chainInfo = chain.length > 1 ? `（${chain.length} 层链式恢复）` : '';
    return {
      ok: true,
      message: `已从 ${path.basename(backupPath)} ${mode}恢复${chainInfo}，恢复前已备份到 ${safeDir}`,
      safetyBackup: safeDir
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  buildBackupSnapshot,
  gitInit,
  gitSetRemote,
  asyncRunBackup,
  listBackupHistory,
  restoreFromCommit,
  restoreFromLocalBackup,
  gitAvailable,
  webdavTestConnection,
  selectBackupTargets,
  copyWithMode,
  wipeWorkspace,
  createSyncSnapshot,
  readSyncManifest,
  applySyncSnapshot,
  SYNC_FORMAT,
  SYNC_MANIFEST,
  SYNC_CHUNK_SIZE
};
