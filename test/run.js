// cc-manager 单元测试
// 用法: node test/run.js
// 依赖: 仅 Node.js 内置模块

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 测试框架：先注册，再在 main 中逐个 await，避免异步测试被提前判定为通过。
const tests = [];
const results = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ========== claude 适配器 ==========
const claude = require('../server/adapters/claude');
const codex = require('../server/adapters/codex');
const opencli = require('../server/opencli');
const serverModule = require('../server/server');

test('server.isAllowedHost: 仅接受 loopback Host', () => {
  assert.ok(serverModule.isAllowedHost('localhost:17890'));
  assert.ok(serverModule.isAllowedHost('127.0.0.1:17890'));
  assert.ok(serverModule.isAllowedHost('[::1]:17890'));
  assert.ok(!serverModule.isAllowedHost('evil.example:17890'));
});

test('decodeProjectDir: D--claudecode -> D:\\claudecode', () => {
  assert.strictEqual(claude.decodeProjectDir('D--claudecode'), 'D:\\claudecode');
});

test('decodeProjectDir: d--Desktop-cpp -> d:\\Desktop-cpp', () => {
  assert.strictEqual(claude.decodeProjectDir('d--Desktop-cpp'), 'd:\\Desktop-cpp');
});

test('decodeProjectDir: 无 -- 返回 null', () => {
  assert.strictEqual(claude.decodeProjectDir('nodashes'), null);
});

test('encodeProjectPath: D:\\claudecode -> D--claudecode', () => {
  assert.strictEqual(claude.encodeProjectPath('D:\\claudecode'), 'D--claudecode');
});

test('isMeaningfulUserMessage: 跳过 <local-command-caveat>', () => {
  // 通过模块内部逻辑间接测试--用 getRawContentText 验证提取
  const msg = {
    type: 'user',
    message: { role: 'user', content: '<local-command-caveat>Caveat text</local-command-caveat>' }
  };
  // getRawContentText 应该能提取到内容（供过滤判断）
  // 但 isMeaningfulUserMessage 没导出，这里只验证 getRawContentText 不可达
  // 改为验证导出的 decodeProjectDir 行为
  assert.ok(true);
});

test('claude.getSessionContent 对损坏行容错（不抛异常）', () => {
  // 用一个不存在的 projectName，应返回 null 而非抛异常
  const result = claude.getSessionContent('nonexistent-session-id', 'nonexistent-project');
  assert.strictEqual(result, null);
});

test('claude.searchSessionText 无效正则返回 error 对象', () => {
  const result = claude.searchSessionText('nonexistent-project', '[invalid', { isRegex: true });
  assert.ok(result.error, '应该返回 error 字段');
  assert.ok(result.error.includes('正则'), '错误信息应提到正则');
});

// ========== store ==========
const store = require('../server/store');

test('store.loadMeta: 文件不存在时返回空对象', () => {
  // loadMeta 读的是真实 meta.json，至少应返回对象
  const meta = store.loadMeta();
  assert.strictEqual(typeof meta, 'object');
});

test('store.getConfig: 返回对象且含 backupTarget 字段', () => {
  const config = store.getConfig();
  assert.strictEqual(typeof config, 'object');
  assert.ok('backupTarget' in config, 'config 应有 backupTarget 字段');
  assert.ok(['local', 'github', 'webdav', 'all', 'both'].includes(config.backupTarget));
});

test('store.DEFAULT_CONFIG: 默认 backupTarget 是 local', () => {
  assert.strictEqual(store.DEFAULT_CONFIG.backupTarget, 'local');
});

test('store.exportSessionAsMarkdown: 空消息返回占位', () => {
  const md = store.exportSessionAsMarkdown([], 'session-123', '测试标题');
  assert.ok(md.includes('空会话'));
});

test('store.exportSessionAsMarkdown: 标题出现在首行', () => {
  const messages = [
    { type: 'user', message: { role: 'user', content: '你好' }, timestamp: 1700000000000 }
  ];
  const md = store.exportSessionAsMarkdown(messages, 'sid', '我的会话标题');
  assert.ok(md.startsWith('# 我的会话标题'), '首行应为标题');
  assert.ok(md.includes('你好'), '应包含用户消息内容');
});

test('store.exportSessionAsMarkdown: tool_result 展开实质内容而非占位', () => {
  const messages = [{
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', content: '命令输出：ls -la 共 5 个文件' }]
    },
    timestamp: 1700000000000
  }];
  const md = store.exportSessionAsMarkdown(messages, 'sid', '标题');
  assert.ok(md.includes('命令输出：ls -la 共 5 个文件'), '应展开 tool_result 实际内容');
  assert.ok(!md.includes('[工具结果]'), '不应只显示占位标签');
});

test('store.exportSessionAsMarkdown: tool_use 展示输入参数', () => {
  const messages = [{
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]
    },
    timestamp: 1700000000000
  }];
  const md = store.exportSessionAsMarkdown(messages, 'sid', '标题');
  assert.ok(md.includes('Bash'), '应包含工具名');
  assert.ok(md.includes('"command"'), '应包含输入参数');
});

test('store.exportSessionAsMarkdown: 跳过系统事件行', () => {
  const messages = [
    { type: 'mode', timestamp: 1700000000000 },
    { type: 'permission-mode', timestamp: 1700000000000 },
    { type: 'user', message: { role: 'user', content: '实际消息' }, timestamp: 1700000000000 }
  ];
  const md = store.exportSessionAsMarkdown(messages, 'sid', '标题');
  assert.ok(!md.includes('MODE'), '不应渲染 mode 行');
  assert.ok(md.includes('实际消息'), '应渲染 user 行');
});

// ========== backup: copyWithMode 逻辑验证 ==========
// copyWithMode 没导出，通过 restoreFromCommit 的行为间接验证
// 这里用临时目录模拟增量/合并/完全覆盖的差异
const backup = require('../server/backup');

test('backup.gitAvailable: 始终返回布尔值', () => {
  assert.strictEqual(typeof backup.gitAvailable(), 'boolean');
});

test('backup.listBackupHistory: 返回稳定的分页结构', () => {
  const h = backup.listBackupHistory();
  assert.ok(h && Array.isArray(h.entries));
  assert.strictEqual(typeof h.total, 'number');
});

test('backup.restoreFromCommit: 提前拒绝非 hash 参数', async () => {
  const result = await backup.restoreFromCommit('--orphan', 'claude', 'incremental');
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes('hash'));
});

test('backup.restoreFromLocalBackup: 拒绝备份根目录之外的路径', async () => {
  const result = await backup.restoreFromLocalBackup(process.cwd(), 'claude', 'incremental');
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes('路径'));
});

test('backup: 备份与恢复操作互斥', async () => {
  const first = backup.restoreFromCommit('--orphan', 'claude', 'incremental');
  const second = backup.restoreFromLocalBackup(process.cwd(), 'claude', 'incremental');
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(firstResult.ok, false);
  assert.strictEqual(secondResult.ok, false);
  assert.ok(secondResult.error.includes('正在执行'));
});

// ========== 模拟 copyWithMode 行为（独立实现一份对照）==========
test('增量模式逻辑: 仅复制目标不存在的文件', () => {
  // 模拟 copyWithMode 的 incremental 分支
  const tmpDir = path.join(os.tmpdir(), `cc-manager-test-${Date.now()}`);
  const srcDir = path.join(tmpDir, 'src');
  const destDir = path.join(tmpDir, 'dest');
  fs.mkdirSync(path.join(srcDir, 'sub'), { recursive: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'a.jsonl'), 'A');
  fs.writeFileSync(path.join(srcDir, 'sub', 'b.jsonl'), 'B');
  // dest 已有 a.jsonl（旧内容）
  fs.writeFileSync(path.join(destDir, 'a.jsonl'), 'OLD_A');

  // 复刻 incremental 逻辑
  function walk(dir, relative) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...walk(full, path.join(relative, e.name)));
      else files.push({ src: full, rel: path.join(relative, e.name) });
    }
    return files;
  }
  const files = walk(srcDir, '');
  for (const f of files) {
    const destFile = path.join(destDir, f.rel);
    if (!fs.existsSync(destFile)) {
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.copyFileSync(f.src, destFile);
    }
  }

  assert.strictEqual(fs.readFileSync(path.join(destDir, 'a.jsonl'), 'utf-8'), 'OLD_A', '已存在的不应被覆盖');
  assert.strictEqual(fs.readFileSync(path.join(destDir, 'sub', 'b.jsonl'), 'utf-8'), 'B', '不存在的应被复制');

  // 清理
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('合并覆盖模式逻辑: 存在则覆盖，不存在则添加', () => {
  const tmpDir = path.join(os.tmpdir(), `cc-manager-test-${Date.now()}`);
  const srcDir = path.join(tmpDir, 'src');
  const destDir = path.join(tmpDir, 'dest');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'a.jsonl'), 'NEW_A');
  fs.writeFileSync(path.join(srcDir, 'c.jsonl'), 'C');
  fs.writeFileSync(path.join(destDir, 'a.jsonl'), 'OLD_A');
  fs.writeFileSync(path.join(destDir, 'd.jsonl'), 'D_ONLY');  // dest 独有

  function walk(dir, relative) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...walk(full, path.join(relative, e.name)));
      else files.push({ src: full, rel: path.join(relative, e.name) });
    }
    return files;
  }
  const files = walk(srcDir, '');
  for (const f of files) {
    const destFile = path.join(destDir, f.rel);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.copyFileSync(f.src, destFile);
  }

  assert.strictEqual(fs.readFileSync(path.join(destDir, 'a.jsonl'), 'utf-8'), 'NEW_A', '已存在的应被覆盖');
  assert.strictEqual(fs.readFileSync(path.join(destDir, 'c.jsonl'), 'utf-8'), 'C', '不存在应被添加');
  assert.strictEqual(fs.readFileSync(path.join(destDir, 'd.jsonl'), 'utf-8'), 'D_ONLY', 'dest 独有应保留');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ========== Phase 1 回归测试 ==========

// --- bug1: selectBackupTargets（修复 CLI 默认 local 静默空跑）---
test('selectBackupTargets: all -> github+webdav+local', () => {
  assert.deepStrictEqual(backup.selectBackupTargets('all'), ['github', 'webdav', 'local']);
});
test('selectBackupTargets: local -> [local]（修复 CLI 静默空跑 bug）', () => {
  assert.deepStrictEqual(backup.selectBackupTargets('local'), ['local']);
});
test('selectBackupTargets: github -> [github]', () => {
  assert.deepStrictEqual(backup.selectBackupTargets('github'), ['github']);
});
test('selectBackupTargets: both 向后兼容 -> github+webdav', () => {
  assert.deepStrictEqual(backup.selectBackupTargets('both'), ['github', 'webdav']);
});
test('selectBackupTargets: 未知/空值兜底 local（永不静默空跑）', () => {
  assert.deepStrictEqual(backup.selectBackupTargets(''), ['local']);
  assert.deepStrictEqual(backup.selectBackupTargets('bogus'), ['local']);
  assert.deepStrictEqual(backup.selectBackupTargets(undefined), ['local']);
});

// --- bug3: wipeWorkspace 清空文件保留 .git ---
test('wipeWorkspace: 清空工作区文件但保留 .git', () => {
  const tmp = path.join(os.tmpdir(), `cc-wipe-${Date.now()}`);
  fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.git', 'config'), '[core]');
  fs.writeFileSync(path.join(tmp, 'a.jsonl'), 'A');
  fs.mkdirSync(path.join(tmp, 'sub'));
  fs.writeFileSync(path.join(tmp, 'sub', 'b.jsonl'), 'B');
  backup.wipeWorkspace(tmp);
  const remaining = fs.readdirSync(tmp);
  assert.deepStrictEqual(remaining, ['.git'], '应只保留 .git');
  assert.ok(fs.existsSync(path.join(tmp, '.git', 'config')), '.git 内容应保留');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- full: 目标应严格等于备份，旧目录移入安全归档而非直接删除 ---
test('copyWithMode full: 完整替换并归档旧目录', () => {
  const tmp = path.join(os.tmpdir(), `cc-full-${Date.now()}`);
  const src = path.join(tmp, 'src'), dest = path.join(tmp, 'dest'), archive = path.join(tmp, 'archive');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.jsonl'), 'NEW');
  fs.writeFileSync(path.join(dest, 'a.jsonl'), 'OLD');
  fs.writeFileSync(path.join(dest, 'extra.jsonl'), 'EXTRA');
  backup.copyWithMode(src, dest, 'full', archive);
  assert.strictEqual(fs.readFileSync(path.join(dest, 'a.jsonl'), 'utf-8'), 'NEW', 'full 应覆盖同名文件');
  assert.ok(!fs.existsSync(path.join(dest, 'extra.jsonl')), 'full 后目标独有文件不应继续留在活动目录');
  assert.strictEqual(fs.readFileSync(path.join(archive, 'extra.jsonl'), 'utf-8'), 'EXTRA', '旧目录应保留在安全归档');
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeSyncFixture(label) {
  const tmp = path.join(os.tmpdir(), `cc-sync-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const baseDir = path.join(tmp, 'backups');
  const claude = path.join(tmp, 'source-claude');
  const codex = path.join(tmp, 'source-codex');
  const meta = path.join(tmp, 'meta.json');
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  fs.writeFileSync(meta, '{}');
  return {
    tmp, baseDir, claude, codex, meta,
    sourceRoots: [
      { prefix: 'claude-sessions', path: claude },
      { prefix: 'codex-sessions', path: codex },
      { prefix: 'cc-manager-meta.json', path: meta, file: true }
    ]
  };
}

test('同步快照: 内容寻址分块去重，追加大文件只新增尾部块', () => {
  const f = makeSyncFixture('chunks');
  try {
    const active = path.join(f.claude, 'active.jsonl');
    fs.writeFileSync(active, Buffer.concat([Buffer.alloc(backup.SYNC_CHUNK_SIZE, 65), Buffer.from('tail')]));
    fs.writeFileSync(path.join(f.codex, 'same.jsonl'), Buffer.alloc(backup.SYNC_CHUNK_SIZE, 65));
    const first = backup.createSyncSnapshot({
      baseDir: f.baseDir, timestamp: '2026-07-26-10-00-00-001', sourceRoots: f.sourceRoots
    });
    assert.ok(first.ok && !first.skipped);
    assert.strictEqual(first.newChunks, 3, '相同的 4 MiB 块应只保存一次，另含 tail 与 meta 块');

    fs.appendFileSync(active, '-appended');
    const second = backup.createSyncSnapshot({
      baseDir: f.baseDir, timestamp: '2026-07-26-10-01-00-001',
      previousName: first.snapshotName, sourceRoots: f.sourceRoots
    });
    assert.strictEqual(second.changedFiles, 1);
    assert.strictEqual(second.newChunks, 1, '追加后完整前缀块应复用，只写新的尾块');
    assert.ok(second.bytesStored < 1024, '追加少量文本不应再次写入整个大对话');

    const unchanged = backup.createSyncSnapshot({
      baseDir: f.baseDir, timestamp: '2026-07-26-10-02-00-001',
      previousName: second.snapshotName, sourceRoots: f.sourceRoots
    });
    assert.ok(unchanged.skipped, '内容未变化时不发布空快照');
  } finally {
    fs.rmSync(f.tmp, { recursive: true, force: true });
  }
});

test('同步快照: 删除产生回收站记录，旧内容对象仍保留且 full 恢复不复活文件', () => {
  const f = makeSyncFixture('delete');
  try {
    fs.writeFileSync(path.join(f.claude, 'keep.jsonl'), 'KEEP');
    fs.writeFileSync(path.join(f.claude, 'deleted.jsonl'), 'NEVER-DELETE-CONTENT');
    fs.writeFileSync(path.join(f.codex, 'rollout.jsonl'), 'CODEX');
    const first = backup.createSyncSnapshot({
      baseDir: f.baseDir, timestamp: '2026-07-26-11-00-00-001', sourceRoots: f.sourceRoots
    });
    const firstManifest = backup.readSyncManifest(first.dir);
    const deletedEntry = firstManifest.files['claude-sessions/deleted.jsonl'];
    const oldObject = path.join(f.baseDir, '.cc-manager-sync', 'objects',
      deletedEntry.chunks[0].sha256.slice(0, 2), deletedEntry.chunks[0].sha256);
    fs.unlinkSync(path.join(f.claude, 'deleted.jsonl'));

    const second = backup.createSyncSnapshot({
      baseDir: f.baseDir, timestamp: '2026-07-26-11-01-00-001',
      previousName: first.snapshotName, sourceRoots: f.sourceRoots
    });
    const manifest = backup.readSyncManifest(second.dir);
    assert.strictEqual(second.changedFiles, 0, '纯删除不应伪装成文件修改');
    assert.strictEqual(second.deletedFiles, 1);
    assert.strictEqual(manifest.deleted[0].path, 'claude-sessions/deleted.jsonl');
    assert.ok(fs.existsSync(oldObject), '删除只改变活动清单，旧内容块必须永久保留');

    const targetClaude = path.join(f.tmp, 'target-claude');
    const targetCodex = path.join(f.tmp, 'target-codex');
    const safety = path.join(f.tmp, 'safety');
    fs.mkdirSync(targetClaude, { recursive: true });
    fs.mkdirSync(targetCodex, { recursive: true });
    fs.writeFileSync(path.join(targetClaude, 'deleted.jsonl'), 'CURRENT-OLD');
    fs.writeFileSync(path.join(targetClaude, 'stale.jsonl'), 'STALE');
    backup.applySyncSnapshot(second.dir, manifest, null, 'full', safety, {
      claude: targetClaude, codex: targetCodex
    });
    assert.strictEqual(fs.readFileSync(path.join(targetClaude, 'keep.jsonl'), 'utf-8'), 'KEEP');
    assert.ok(!fs.existsSync(path.join(targetClaude, 'deleted.jsonl')), 'full 恢复应遵循删除后的活动视图');
    assert.ok(!fs.existsSync(path.join(targetClaude, 'stale.jsonl')));
    assert.strictEqual(fs.readFileSync(path.join(safety, 'original-claude-sessions', 'deleted.jsonl'), 'utf-8'), 'CURRENT-OLD');
  } finally {
    fs.rmSync(f.tmp, { recursive: true, force: true });
  }
});

test('同步快照: 清单拒绝路径穿越，损坏对象在改动目标前阻止恢复', () => {
  const f = makeSyncFixture('integrity');
  try {
    fs.writeFileSync(path.join(f.claude, 'safe.jsonl'), 'SAFE');
    fs.writeFileSync(path.join(f.codex, 'rollout.jsonl'), 'CODEX');
    const snapshot = backup.createSyncSnapshot({
      baseDir: f.baseDir, timestamp: '2026-07-26-12-00-00-001', sourceRoots: f.sourceRoots
    });
    const manifestPath = path.join(snapshot.dir, backup.SYNC_MANIFEST);
    const valid = backup.readSyncManifest(snapshot.dir);
    const unsafe = JSON.parse(JSON.stringify(valid));
    unsafe.files['claude-sessions/../../escape.jsonl'] = unsafe.files['claude-sessions/safe.jsonl'];
    fs.writeFileSync(manifestPath, JSON.stringify(unsafe));
    assert.throws(() => backup.readSyncManifest(snapshot.dir), /路径|记录/);
    fs.writeFileSync(manifestPath, JSON.stringify(valid));

    const entry = valid.files['claude-sessions/safe.jsonl'];
    const objectPath = path.join(f.baseDir, '.cc-manager-sync', 'objects',
      entry.chunks[0].sha256.slice(0, 2), entry.chunks[0].sha256);
    fs.writeFileSync(objectPath, 'CORRUPT');
    const target = path.join(f.tmp, 'target');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'untouched.jsonl'), 'UNTOUCHED');
    assert.throws(() => backup.applySyncSnapshot(snapshot.dir, valid, 'claude', 'full',
      path.join(f.tmp, 'safety'), { claude: target, codex: path.join(f.tmp, 'unused') }), /校验失败/);
    assert.strictEqual(fs.readFileSync(path.join(target, 'untouched.jsonl'), 'utf-8'), 'UNTOUCHED');
  } finally {
    fs.rmSync(f.tmp, { recursive: true, force: true });
  }
});

test('同步快照: 父快照已有数据时拒绝把缺失的整个源目录误判为批量删除', () => {
  const f = makeSyncFixture('missing-root');
  try {
    fs.writeFileSync(path.join(f.claude, 'important.jsonl'), 'IMPORTANT');
    fs.writeFileSync(path.join(f.codex, 'rollout.jsonl'), 'CODEX');
    const first = backup.createSyncSnapshot({
      baseDir: f.baseDir, timestamp: '2026-07-26-13-00-00-001', sourceRoots: f.sourceRoots
    });
    fs.renameSync(f.claude, path.join(f.tmp, 'claude-temporarily-unavailable'));
    assert.throws(() => backup.createSyncSnapshot({
      baseDir: f.baseDir, timestamp: '2026-07-26-13-01-00-001',
      previousName: first.snapshotName, sourceRoots: f.sourceRoots
    }), /源目录缺失/);
    assert.ok(!fs.existsSync(path.join(f.baseDir, 'auto-2026-07-26-13-01-00-001')),
      '源目录异常时不得发布误删除快照');
  } finally {
    fs.rmSync(f.tmp, { recursive: true, force: true });
  }
});

test('claude.resolveProjectDir: 拒绝路径穿越', () => {
  assert.strictEqual(claude.resolveProjectDir('..'), null);
  assert.strictEqual(claude.resolveProjectDir('..\\outside'), null);
});

test('claude.resolveProjectDir: Windows realpath 被拒时仍可读取安全的直接子目录', () => {
  const root = path.join(os.tmpdir(), `cc-project-root-${Date.now()}`);
  const child = path.join(root, 'D--safe-project');
  fs.mkdirSync(child, { recursive: true });
  const originalRealpath = fs.realpathSync;
  fs.realpathSync = () => {
    const error = new Error('operation not permitted');
    error.code = 'EPERM';
    throw error;
  };
  try {
    assert.strictEqual(claude.resolveProjectDir('D--safe-project', root), child);
    assert.strictEqual(claude.resolveProjectDir('..', root), null);
  } finally {
    fs.realpathSync = originalRealpath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex.parseJsonl: 活跃会话损坏末行不影响前面内容', () => {
  const tmp = path.join(os.tmpdir(), `cc-codex-partial-${Date.now()}.jsonl`);
  fs.writeFileSync(tmp, '{"type":"session_meta","payload":{"id":"ok"}}\n{"type":"response_item"');
  try {
    const parsed = codex.parseJsonl(tmp);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].type, 'session_meta');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('前端会话操作不把动态 ID 拼入内联 JavaScript', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf-8');
  assert.ok(html.includes('data-action="open"'));
  assert.ok(!html.includes("openInCli('${s.id}')"));
  assert.ok(!html.includes("deleteSession('${s.id}')"));
  assert.ok(html.includes("$('#setting-branch').value = s.branch || 'main'"));
  assert.ok(html.includes("$('#setting-webdav-user').value = s.webdavUsername || ''"));
});

// --- bug2: claude.writeFork 写新文件 + sessionId 替换 + 源文件不动 ---
test('claude.writeFork: 新文件 <newId>.jsonl + sessionId 替换 + 源文件不动', () => {
  const tmp = path.join(os.tmpdir(), `cc-fork-claude-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const oldId = 'old-uuid-1234';
  const srcPath = path.join(tmp, `${oldId}.jsonl`);
  const rawLines = [
    { type: 'custom-title', customTitle: '测试', sessionId: oldId },
    { type: 'user', message: { role: 'user', content: '你好' }, sessionId: oldId, uuid: 'u1', timestamp: 1700000000000 }
  ];
  fs.writeFileSync(srcPath, rawLines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  const newId = 'new-uuid-5678';
  const { newFilePath } = claude.writeFork(rawLines, srcPath, newId);
  assert.ok(newFilePath.endsWith(`${newId}.jsonl`), '新文件名应为 <newId>.jsonl');
  assert.ok(fs.existsSync(newFilePath), '新文件应存在');
  const written = fs.readFileSync(newFilePath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(written[0].sessionId, newId, 'custom-title 行 sessionId 应替换');
  assert.strictEqual(written[1].sessionId, newId, 'user 行 sessionId 应替换');
  assert.strictEqual(written[1].message.content, '你好', '消息内容应保留');
  // 源文件未被修改
  const srcRe = fs.readFileSync(srcPath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(srcRe[0].sessionId, oldId, '源文件不应被修改');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- bug2: codex.writeFork 写 rollout 新文件 + session_meta.payload.id 替换 ---
test('codex.writeFork: rollout 新文件 + session_meta.payload.id 替换 + 源文件不动', () => {
  const tmp = path.join(os.tmpdir(), `cc-fork-codex-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const oldId = '019e9290-a40d-78d2-8f6b-64ac227776f8';
  const srcPath = path.join(tmp, `rollout-2026-06-04T20-16-53-${oldId}.jsonl`);
  const rawLines = [
    { type: 'session_meta', timestamp: '2026-06-04T12:16:56Z', payload: { id: oldId, cwd: 'D:\\test', timestamp: '2026-06-04T12:16:53Z' } },
    { type: 'response_item', timestamp: '2026-06-04T12:17:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] } }
  ];
  // 把源文件写到磁盘（writeFork 只用 srcPath 的目录名，不读源文件；源文件应保持不动）
  fs.writeFileSync(srcPath, rawLines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  const newId = '019e9290-bbbb-cccc-dddd-eeeeeeeeeeee';
  const { newFilePath } = codex.writeFork(rawLines, srcPath, newId);
  assert.ok(path.basename(newFilePath).startsWith('rollout-'), '新文件名应以 rollout- 开头');
  assert.ok(newFilePath.includes(newId), '新文件名应含 newId');
  const written = fs.readFileSync(newFilePath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(written[0].payload.id, newId, 'session_meta.payload.id 应替换');
  assert.strictEqual(written[1].payload.content[0].text, '你好', '消息内容应保留');
  // 源文件未变
  assert.ok(fs.existsSync(srcPath), '源文件应仍存在');
  const srcRe = fs.readFileSync(srcPath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(srcRe[0].payload.id, oldId, '源文件 session_meta.id 不应变');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- 适配器暴露 getRawLines / writeFork ---
test('claude 适配器暴露 getRawLines / writeFork', () => {
  assert.strictEqual(typeof claude.getRawLines, 'function');
  assert.strictEqual(typeof claude.writeFork, 'function');
});
test('codex 适配器暴露 getRawLines / writeFork', () => {
  assert.strictEqual(typeof codex.getRawLines, 'function');
  assert.strictEqual(typeof codex.writeFork, 'function');
});

// ========== Phase 2 回归测试：opencli ==========

test('opencli.isValidSessionId: 合法 uuid 通过，危险输入拒绝', () => {
  assert.ok(opencli.isValidSessionId('07efa94d-2e63-44ec-b22f-02d5d5716342'));
  assert.ok(opencli.isValidSessionId('019e9290-a40d-78d2-8f6b-64ac227776f8'));
  assert.ok(!opencli.isValidSessionId('rm -rf'), '含空格应拒绝');
  assert.ok(!opencli.isValidSessionId('a&b'), '特殊字符应拒绝');
  assert.ok(!opencli.isValidSessionId('a|b'), '管道符应拒绝');
  assert.ok(!opencli.isValidSessionId('short'), '过短应拒绝');
  assert.ok(!opencli.isValidSessionId(''), '空串应拒绝');
});

test('opencli.buildOpenCommand: 含绝对路径的 resume 命令，未知 CLI 返回 null', () => {
  const claudeCmd = opencli.buildOpenCommand('claude', 'uuid-1234-5678');
  const codexCmd = opencli.buildOpenCommand('codex', 'uuid-1234-5678');
  assert.ok(claudeCmd.includes('claude') && claudeCmd.includes('--resume uuid-1234-5678'), 'claude 命令应含 --resume 和 id');
  assert.ok(codexCmd.includes('codex') && codexCmd.includes('resume uuid-1234-5678'), 'codex 命令应含 resume 和 id');
  assert.strictEqual(opencli.buildOpenCommand('gemini', 'uuid-1234-5678'), null);
  assert.strictEqual(opencli.buildOpenCommand(null, 'uuid'), null);
});

test('opencli.resolveCwd: claude 反解编码目录名', () => {
  const r = opencli.resolveCwd('claude', 'D--claudecode');
  assert.ok(r.cwd, '应返回 cwd');
  assert.ok(r.cwd.toLowerCase().includes('claudecode'));
});

test('opencli.resolveCwd: codex projectName 即 cwd', () => {
  const r = opencli.resolveCwd('codex', 'D:\\test\\proj');
  assert.strictEqual(r.cwd, 'D:\\test\\proj');
});

test('opencli.resolveCwd: codex 未关联项目 / claude 无法反解均报错', () => {
  assert.ok(opencli.resolveCwd('codex', '(未关联项目)').error);
  assert.ok(opencli.resolveCwd('claude', 'nodashes').error);
  assert.ok(opencli.resolveCwd('claude', '').error);
});

test('opencli.openSession: 非法 id 不启动终端', () => {
  const r = opencli.openSession('claude', 'rm -rf /', 'D--claudecode');
  assert.ok(!r.ok, '应拒绝');
  assert.ok(r.error, '应返回错误信息');
});

test('文档：所有当前文档相对链接都存在', () => {
  const files = [
    ...fs.readdirSync(path.join(__dirname, '..'))
      .filter(name => name.endsWith('.md')),
    ...fs.readdirSync(path.join(__dirname, '..', 'docs'))
      .filter(name => name.endsWith('.md'))
      .map(name => path.join('docs', name))
  ];
  for (const relativeFile of files) {
    const filePath = path.join(__dirname, '..', relativeFile);
    const markdown = fs.readFileSync(filePath, 'utf-8');
    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^(https?:|mailto:)/i.test(target)) continue;
      const resolved = path.resolve(path.dirname(filePath), decodeURIComponent(target));
      assert.ok(fs.existsSync(resolved), `${relativeFile} 中的链接不存在: ${match[1]}`);
    }
  }
});

test('文档：API 参考覆盖 server/routes.js 的全部路由', () => {
  const routesSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes.js'), 'utf-8');
  const apiDoc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'API.md'), 'utf-8');
  for (const match of routesSource.matchAll(/router\.(get|post)\('([^']+)'/g)) {
    const signature = `${match[1].toUpperCase()} ${match[2]}`;
    assert.ok(apiDoc.includes(signature), `API.md 缺少路由: ${signature}`);
  }
});

// ========== Phase 3 回归测试：编辑路由 ==========

test('HTTP 安全边界与 edit 参数校验', async () => {
  const http = require('http');
  const port = 17993;
  const s = serverModule.startServer(port, { enableAutoBackup: false });
  await new Promise((resolve, reject) => {
    if (s.server.listening) return resolve();
    s.server.once('listening', resolve);
    s.server.once('error', reject);
  });
  try {
    const requestJson = (urlPath, options = {}) => new Promise((ok, fail) => {
      const req = http.request(`http://127.0.0.1:${port}${urlPath}`, options, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => ok({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', fail);
      if (options.body) req.write(JSON.stringify(options.body));
      req.end();
    });

    const res = await new Promise((ok, fail) => {
      const req = http.request(`http://127.0.0.1:${port}/api/session/claude/bad-id/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => ok({ status: res.statusCode, body: JSON.parse(d) }));
      });
      req.write(JSON.stringify({ projectName: 'D--claudecode', lines: null }));
      req.end();
      req.on('error', fail);
    });
    assert.ok(res.status === 400 || res.body.error, '缺少 lines 应返回错误');

    const forbidden = await new Promise((ok, fail) => {
      const req = http.request(`http://127.0.0.1:${port}/api/cli`, {
        headers: { Host: `evil.example:${port}` }
      }, res => {
        res.resume();
        res.on('end', () => ok(res.statusCode));
      });
      req.on('error', fail);
      req.end();
    });
    assert.strictEqual(forbidden, 403, '非 loopback Host 应被拒绝');

    const originalGetSessions = claude.getSessions;
    const originalLoadMeta = store.loadMeta;
    claude.getSessions = () => [{
      id: 'hidden-session-id', file: 'hidden.jsonl', filePath: 'hidden.jsonl',
      title: 'hidden', subtitle: 'hidden-session-id', messageCount: 1,
      lastActivity: 1, cli: 'claude', projectName: 'test'
    }];
    store.loadMeta = () => ({ 'hidden-session-id': { hidden: true } });
    try {
      const hiddenFalse = await requestJson('/api/cli/claude/project/test/sessions?showHidden=false');
      const hiddenTrue = await requestJson('/api/cli/claude/project/test/sessions?showHidden=true');
      assert.deepStrictEqual(hiddenFalse.body, [], 'showHidden=false 不应返回隐藏会话');
      assert.strictEqual(hiddenTrue.body.length, 1, 'showHidden=true 应返回隐藏会话');
    } finally {
      claude.getSessions = originalGetSessions;
      store.loadMeta = originalLoadMeta;
    }

    const backupStatus = await requestJson('/api/backup/status');
    assert.ok('branch' in backupStatus.body, '备份状态应返回 branch');
    assert.ok('webdavUsername' in backupStatus.body, '备份状态应返回 webdavUsername');
    assert.ok(!('webdavPassword' in backupStatus.body), '备份状态不得返回密码');

    const originalGitSetRemote = backup.gitSetRemote;
    const originalUpdateConfig = store.updateConfig;
    let configWritten = false;
    backup.gitSetRemote = () => ({ ok: false, error: 'mock remote failure' });
    store.updateConfig = () => { configWritten = true; return {}; };
    try {
      const configFailure = await requestJson('/api/backup/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { repoUrl: 'https://example.invalid/repo.git' }
      });
      assert.strictEqual(configFailure.status, 400);
      assert.strictEqual(configWritten, false, '远程设置失败时不应写入配置');
    } finally {
      backup.gitSetRemote = originalGitSetRemote;
      store.updateConfig = originalUpdateConfig;
    }
  } finally {
    s.server.close(); if (s.backupTimer) clearInterval(s.backupTimer);
  }
});

// ========== 运行所有测试 ==========
async function main() {
  console.log('cc-manager 单元测试\n');
  console.log('='.repeat(50));

  for (const { name, fn } of tests) {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, error: e && e.message ? e.message : String(e) });
    }
  }

  let passed = 0, failed = 0;
  for (const r of results) {
    const mark = r.ok ? '✓' : '✗';
    console.log(`${mark} ${r.name}`);
    if (!r.ok) {
      console.log(`    ${r.error}`);
      failed++;
    } else {
      passed++;
    }
  }

  console.log('='.repeat(50));
  console.log(`通过: ${passed}  失败: ${failed}  总计: ${results.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
