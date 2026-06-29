const express = require('express');
const claude = require('./adapters/claude');
const codex = require('./adapters/codex');
const store = require('./store');
const backup = require('./backup');

const router = express.Router();

// ========== 适配器查找 ==========
const adapters = { claude, codex };

// ========== CLI 列表 ==========
router.get('/api/cli', (req, res) => {
  res.json(Object.keys(adapters));
});

// ========== 项目列表 ==========
router.get('/api/cli/:cli/projects', (req, res) => {
  const adapter = adapters[req.params.cli];
  if (!adapter) return res.status(404).json({ error: '未知 CLI' });
  try {
    const projects = adapter.getProjects();
    res.json(projects);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 会话列表 ==========
router.get('/api/cli/:cli/project/:projectName/sessions', (req, res) => {
  const adapter = adapters[req.params.cli];
  if (!adapter) return res.status(404).json({ error: '未知 CLI' });
  try {
    let sessionList = adapter.getSessions(req.params.projectName);
    // 注入元数据（别名/收藏）
    const meta = store.loadMeta();
    sessionList = sessionList.map(s => {
      const m = meta[s.id] || {};
      return {
        ...s,
        alias: m.alias || null,
        favorite: !!m.favorite,
        hidden: !!m.hidden,
        forkedFrom: m.forkedFrom || null
      };
    });
    // 隐藏的会话默认不返回，除非传 showHidden=true
    if (!req.query.showHidden) {
      sessionList = sessionList.filter(s => !s.hidden);
    }
    res.json(sessionList);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 会话内容 ==========
router.get('/api/cli/:cli/session/:sessionId', (req, res) => {
  const adapter = adapters[req.params.cli];
  if (!adapter) return res.status(404).json({ error: '未知 CLI' });
  try {
    const projectName = req.query.projectName || undefined;
    const content = adapter.getSessionContent(req.params.sessionId, projectName);
    if (!content) return res.status(404).json({ error: '会话未找到' });
    res.json(content);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 搜索会话内容 ==========
router.get('/api/cli/:cli/project/:projectName/search', (req, res) => {
  const adapter = adapters[req.params.cli];
  if (!adapter) return res.status(404).json({ error: '未知 CLI' });
  if (!adapter.searchSessionText) return res.status(400).json({ error: '该 CLI 不支持全文搜索' });
  try {
    const q = req.query.q || '';
    if (!q.trim()) return res.json([]);
    const isRegex = req.query.regex === 'true';
    const result = adapter.searchSessionText(req.params.projectName, q.trim(), { isRegex });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 元数据操作 ==========

// 获取单个会话元数据
router.get('/api/meta/:sessionId', (req, res) => {
  res.json(store.getMeta(req.params.sessionId) || {});
});

// 更新元数据（别名/收藏/hidden/fork）
router.post('/api/meta/:sessionId', (req, res) => {
  const allowedFields = ['alias', 'favorite', 'hidden', 'forkedFrom', 'cli', 'projectName'];
  const updates = {};
  for (const key of allowedFields) {
    if (req.body && req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  }
  const result = store.updateMeta(req.params.sessionId, updates);
  res.json(result);
});

// 获取收藏列表
router.get('/api/favorites', (req, res) => {
  const cli = req.query.cli || undefined;
  res.json(store.getFavorites(cli));
});

// ========== Fork ==========
router.post('/api/session/:cli/:sessionId/fork', (req, res) => {
  const adapter = adapters[req.params.cli];
  if (!adapter) return res.status(404).json({ error: '未知 CLI' });

  try {
    const projectName = req.body.projectName;
    const content = adapter.getSessionContent(req.params.sessionId, projectName);
    if (!content) return res.status(404).json({ error: '源会话未找到' });

    // 找源文件路径
    const sessions = adapter.getSessions(projectName);
    const srcSession = sessions.find(s => s.id === req.params.sessionId);
    if (!srcSession) return res.status(404).json({ error: '源会话记录未找到' });

    const fs = require('fs');
    const path = require('path');

    // 生成新的 sessionId（Node 18+ 支持 randomUUID）
    const crypto = require('crypto');
    const newId = crypto.randomUUID();

    // 在新文件名中写入，所有消息的 sessionId 替换为新 ID
    const srcDir = path.dirname(srcSession.filePath);
    const newFilePath = path.join(srcDir, `${newId}.jsonl`);

    const lines = content.map(msg => {
      const updated = { ...msg };
      if (updated.sessionId) updated.sessionId = newId;
      return JSON.stringify(updated);
    });
    fs.writeFileSync(newFilePath, lines.join('\n'), 'utf-8');

    // 记录 fork 关系元数据
    store.updateMeta(newId, {
      forkedFrom: req.params.sessionId,
      cli: req.params.cli,
      projectName: projectName,
      timestamp: Date.now()
    });

    res.json({ ok: true, newSessionId: newId, message: 'Fork 成功' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 删除（移到 trash）==========
router.post('/api/session/:cli/:sessionId/delete', (req, res) => {
  const adapter = adapters[req.params.cli];
  if (!adapter) return res.status(404).json({ error: '未知 CLI' });

  try {
    const projectName = req.body.projectName;
    const sessions = adapter.getSessions(projectName);
    const session = sessions.find(s => s.id === req.params.sessionId);
    if (!session) return res.status(404).json({ error: '会话未找到' });

    const trashDir = path.join(require('path').dirname(require.main.filename), '..', '..', 'trash');
    require('./store').ensureDir(trashDir);

    const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const trashName = `${ts}_${path.basename(session.file)}`;
    const trashPath = path.join(trashDir, trashName);

    require('fs').renameSync(session.filePath, trashPath);
    store.updateMeta(req.params.sessionId, { hidden: true });

    res.json({ ok: true, trashPath, message: '已移动到 trash' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 导出会话为 Markdown ==========
router.get('/api/session/:cli/:sessionId/export', (req, res) => {
  const adapter = adapters[req.params.cli];
  if (!adapter) return res.status(404).json({ error: '未知 CLI' });

  try {
    const projectName = req.query.projectName;
    const content = adapter.getSessionContent(req.params.sessionId, projectName);
    if (!content) return res.status(404).json({ error: '会话未找到' });

    // 找到会话标题
    let sessionTitle = req.params.sessionId;
    if (projectName) {
      const sessions = adapter.getSessions(projectName);
      const found = sessions.find(s => s.id === req.params.sessionId);
      if (found && found.title) sessionTitle = found.title;
    }

    const md = store.exportSessionAsMarkdown(content, req.params.sessionId, sessionTitle);

    // 文件名：标题去掉非法字符 + .md。非 ASCII 字符用 encodeURI 处理
    const safeName = encodeURIComponent(sessionTitle.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80)) || req.params.sessionId.slice(0, 8);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.md"`);
    res.send(md);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 备份相关 ==========

// 获取备份状态
router.get('/api/backup/status', (req, res) => {
  const config = store.getConfig();
  res.json({
    gitAvailable: backup.gitAvailable(),
    repoConfigured: !!config.repoUrl,
    repoUrl: config.repoUrl || null,
    backupTarget: config.backupTarget || 'local',
    webdavUrl: config.webdavUrl || null,
    webdavConfigured: !!config.webdavUrl,
    localBackupDir: config.localBackupDir || null,
    lastBackupAt: config.lastBackupAt,
    lastRestoreAt: config.lastRestoreAt,
    autoIntervalMin: config.autoIntervalMin,
    workspaceExists: require('fs').existsSync(store.BACKUP_WORKSPACE)
  });
});

// 更新备份配置
router.post('/api/backup/config', (req, res) => {
  const allowed = ['repoUrl', 'branch', 'autoIntervalMin', 'backupTarget', 'webdavUrl', 'webdavUsername', 'localBackupDir'];
  const updates = {};
  for (const key of allowed) {
    if (req.body && req.body[key] !== undefined) updates[key] = req.body[key];
  }
  const config = store.updateConfig(updates);
  if (updates.repoUrl) {
    backup.gitSetRemote(updates.repoUrl);
  }
  res.json(config);
});

// 执行备份
router.post('/api/backup/run', async (req, res) => {
  try {
    const result = await backup.asyncRunBackup();
    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 测试 WebDAV 连接
router.post('/api/backup/webdav-test', async (req, res) => {
  try {
    const result = await backup.webdavTestConnection();
    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 备份历史
router.get('/api/backup/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json(backup.listBackupHistory(limit));
});

// 从某 commit 恢复
router.post('/api/backup/restore', async (req, res) => {
  const { hash, cli, mode } = req.body || {};
  if (!hash) return res.status(400).json({ error: '需要 hash 参数' });
  try {
    const result = await backup.restoreFromCommit(hash, cli, mode || 'incremental');
    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
