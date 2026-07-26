const express = require('express');
const path = require('path');
const routes = require('./routes');
const store = require('./store');
const backup = require('./backup');

const DEFAULT_PORT = 17890;
const LOOPBACK_HOST = '127.0.0.1';

function isAllowedHost(hostHeader) {
  if (typeof hostHeader !== 'string') return false;
  const host = hostHeader.trim().toLowerCase();
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) || /^\[::1\](:\d+)?$/.test(host);
}

function startServer(port, options = {}) {
  port = port || DEFAULT_PORT;

  const app = express();
  app.disable('x-powered-by');
  // 这是能删除、编辑和恢复本地会话的管理服务。拒绝非 loopback Host，
  // 避免局域网暴露和 DNS rebinding 借浏览器调用本地 API。
  app.use((req, res, next) => {
    if (!isAllowedHost(req.headers.host)) {
      return res.status(403).json({ error: '仅允许从本机访问' });
    }
    next();
  });
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(__dirname, '..', 'web')));

  // REST API
  app.use(routes);

  // 兜底：返回前端 index.html（SPA）
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'web', 'index.html'));
  });

  // Express 全局错误处理必须放在所有路由之后。
  app.use((err, req, res, next) => {
    console.error('[express error]', err?.message?.slice(0, 200));
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err?.message || '内部错误' });
  });

  const server = app.listen(port, LOOPBACK_HOST, () => {
    console.log(`cc-manager UI 已启动: http://localhost:${port}`);
    console.log(`按 Ctrl+C 停止服务`);
  });

  // 自动备份定时器
  const config = store.getConfig();
  let backupTimer = null;
  if (options.enableAutoBackup !== false && config.autoIntervalMin > 0) {
    const intervalMs = config.autoIntervalMin * 60 * 1000;
    backupTimer = setInterval(async () => {
      const ts = new Date().toLocaleString();
      process.stdout.write(`[${ts}] 自动备份... `);
      try {
        const r = await backup.asyncRunBackup(true);
        if (r.results && r.results.length) {
          const parts = r.results.map(res =>
            (res.ok ? '✓' : '✗') + res.target + ':' + (res.message || res.error || '?').slice(0, 50)
          );
          console.log(parts.join(' | '));
        } else {
          console.log(r.message || (r.ok ? '完成' : '失败'));
        }
      } catch (e) {
        console.error('失败:', e.message);
      }
    }, intervalMs);
    console.log(`自动备份: 每 ${config.autoIntervalMin} 分钟一次（增量模式）`);
  }

  return { app, server, backupTimer };
}

module.exports = { startServer, DEFAULT_PORT, LOOPBACK_HOST, isAllowedHost };
