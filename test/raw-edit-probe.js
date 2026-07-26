// 隔离测试 /raw 和 /edit 的耗时与正确性
// 会基于真实会话创建测试副本，必须显式授权。
if (process.env.CC_MANAGER_E2E_ALLOW_REAL_DATA !== '1') {
  console.error('已拒绝运行：请先设置 CC_MANAGER_E2E_ALLOW_REAL_DATA=1');
  process.exit(2);
}

const fs = require('fs');
const { startServer } = require('../server/server');
const PORT = 17999;
const s = startServer(PORT);

setTimeout(async () => {
  try {
    const projs = await fetch(`http://localhost:${PORT}/api/cli/claude/projects`).then(r => r.json());
    const p = projs[0];
    const sess = await fetch(`http://localhost:${PORT}/api/cli/claude/project/${encodeURIComponent(p.name)}/sessions`).then(r => r.json());
    const sid = sess[0].id;
    console.log('测试 /raw for', sid.slice(0, 12));

    const t0 = Date.now();
    const raw = await fetch(`http://localhost:${PORT}/api/session/claude/${encodeURIComponent(sid)}/raw?projectName=${encodeURIComponent(p.name)}`).then(r => r.json());
    console.log('/raw 返回', raw.lines && raw.lines.length, '行, 耗时', Date.now() - t0, 'ms');

    console.log('测试 /edit...');
    const t1 = Date.now();
    const ed = await fetch(`http://localhost:${PORT}/api/session/claude/${sid}/edit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectName: p.name, lines: raw.lines })
    }).then(r => r.json());
    console.log('/edit ok=', ed.ok, '耗时', Date.now() - t1, 'ms', ed.error || ('newId=' + (ed.newSessionId || '').slice(0, 8)));

    if (ed.newFilePath) {
      const trashName = `${Date.now()}_edittest.jsonl`;
      fs.copyFileSync(ed.newFilePath, 'D:\\claudecode\\trash\\' + trashName);
      fs.unlinkSync(ed.newFilePath);
      console.log('已清理测试文件 ->', trashName);
    }
  } catch (e) { console.log('错误:', e.message); }
  s.server.close();
  if (s.backupTimer) clearInterval(s.backupTimer);
  process.exit(0);
}, 1000);
