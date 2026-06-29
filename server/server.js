const express = require('express');
const cors = require('cors');
const path = require('path');
const routes = require('./routes');
const store = require('./store');
const backup = require('./backup');

// 全局异常保护——不因任何意外错误崩溃进程
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message?.slice(0, 200));
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.message?.slice(0, 200));
});

const DEFAULT_PORT = 17890;

function startServer(port) {
  port = port || DEFAULT_PORT;

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(__dirname, '..', 'web')));

  // REST API
  app.use(routes);

  // Express 全局错误处理
  app.use((err, req, res, next) => {
    console.error('[express error]', err?.message?.slice(0, 200));
    res.status(500).json({ error: err?.message || '内部错误' });
  });

  // 兜底：返回前端 index.html（SPA）
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'web', 'index.html'));
  });

  const server = app.listen(port, () => {
    console.log(`cc-manager UI 已启动: http://localhost:${port}`);
    console.log(`按 Ctrl+C 停止服务`);
  });

  // 自动备份定时器
  const config = store.getConfig();
  let backupTimer = null;
  if (config.autoIntervalMin > 0) {
    const intervalMs = config.autoIntervalMin * 60 * 1000;
    backupTimer = setInterval(async () => {
      const ts = new Date().toLocaleString();
      process.stdout.write(`[${ts}] 自动备份... `);
      try {
        const r = await backup.asyncRunBackup();
        if (r.results && r.results.length) {
          const parts = r.results.map(res =>
            (res.ok ? '✓' : '✗') + res.target + ':' + (res.message || res.error || '?').slice(0, 40)
          );
          console.log(parts.join(' | '));
        } else {
          console.log(r.message || (r.ok ? '完成' : '失败'));
        }
      } catch (e) {
        console.error('失败:', e.message);
      }
    }, intervalMs);
    console.log(`自动备份: 每 ${config.autoIntervalMin} 分钟一次`);
  }

  return { app, server, backupTimer };
}

module.exports = { startServer, DEFAULT_PORT };
