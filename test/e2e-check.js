// 全面端到端验证：所有 API + copy-on-write 安全性 + fork 合法性 + open
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = 17997;
const BASE = `http://localhost:${PORT}`;
const LOGFILE = 'D:\\Temp\\e2e-progress.txt';
try { fs.writeFileSync(LOGFILE, ''); } catch(e) {}
function log(msg) { const line = msg + '\n'; try { fs.appendFileSync(LOGFILE, line); } catch(e) {} fs.writeSync(1, line); }
const results = [];
function ok(name, cond, detail='') { results.push({name, ok: !!cond, detail}); log((cond?'✓':'✗')+' '+name+(detail?'  '+detail:'')); }

let s = null;
// 兜底：任何未处理 rejection 立即失败退出（避免被 server 的 handler 吞掉静默挂起）
process.on('unhandledRejection', (e) => { log('未处理 rejection: ' + (e && e.message)); if (s && s.server) s.server.close(); process.exit(1); });

async function jget(p) { return fetch(BASE+p).then(r=>r.json()); }
async function jpost(p, body) { return fetch(BASE+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()); }

// 用于清理测试产生的新会话文件（移到 trash，不直接删）
function moveToTrash(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const trashDir = 'D:\\claudecode\\trash';
    if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, {recursive:true});
    const ts = new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14);
    const dest = path.join(trashDir, `${ts}_test_${path.basename(filePath)}`);
    fs.copyFileSync(filePath, dest);
    fs.unlinkSync(filePath);
  } catch(e) { log('  (清理失败:', e.message+')'); }
}

function fileHash(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0,16);
}

(async () => {
  // 启动服务器
  const { startServer } = require('../server/server');
  s = startServer(PORT);
  await new Promise(r => setTimeout(r, 1000));

  log('========== 后端 API + 安全性验证 ==========\n');

  // 1. /api/cli
  const clis = await jget('/api/cli');
  ok('GET /api/cli 返回 claude+codex', Array.isArray(clis) && clis.includes('claude') && clis.includes('codex'), JSON.stringify(clis));

  // 2. 项目列表
  const claudeProjs = await jget('/api/cli/claude/projects');
  ok('GET claude/projects 有数据', claudeProjs.length > 0, `${claudeProjs.length} 个项目`);
  const proj = claudeProjs[0];
  ok('项目含 name/displayPath/sessionCount', proj.name && proj.displayPath && 'sessionCount' in proj);

  // 3. 会话列表
  const sessions = await jget(`/api/cli/claude/project/${encodeURIComponent(proj.name)}/sessions`);
  ok('GET sessions 有数据', sessions.length > 0, `${sessions.length} 个会话`);
  const sess = sessions[0];
  ok('会话含 id/filePath/title/file', sess.id && sess.filePath && sess.title && sess.file, `id=${sess.id.slice(0,8)}`);

  // 4. 会话内容
  const content = await jget(`/api/cli/claude/session/${sess.id}?projectName=${encodeURIComponent(proj.name)}`);
  ok('GET session content 有数据', Array.isArray(content) && content.length > 0, `${content.length} 行`);

  // 5. 原始行
  const raw = await jget(`/api/session/claude/${sess.id}/raw?projectName=${encodeURIComponent(proj.name)}`);
  ok('GET /raw 返回 lines 数组', Array.isArray(raw.lines) && raw.lines.length > 0, `${raw.lines.length} 行`);
  ok('/raw 行数与 content 一致', raw.lines.length === content.length);

  // ========= copy-on-write 安全性测试（最关键）=========
  log('\n--- copy-on-write 安全性（edit 必须不碰原文件）---');
  const origFile = sess.filePath;
  const hashBefore = fileHash(origFile);
  const mtimeBefore = fs.statSync(origFile).mtimeMs;

  // 修改第一条 user 消息的文本
  const editedLines = raw.lines.map(line => {
    if (line.type === 'user' && line.message && typeof line.message.content === 'string') {
      return {...line, message: {...line.message, content: '[EDIT-TEST] ' + line.message.content}};
    }
    if (line.type === 'user' && line.message && Array.isArray(line.message.content)) {
      return {...line, message: {...line.message, content: line.message.content.map(b => b.type==='text' ? {...b, text:'[EDIT-TEST] '+(b.text||'')} : b)}};
    }
    return line;
  });
  const editRes = await jpost(`/api/session/claude/${sess.id}/edit`, {projectName: proj.name, lines: editedLines});
  ok('POST /edit 返回 ok', editRes.ok, editRes.error || `newId=${(editRes.newSessionId||'').slice(0,8)}`);

  // 关键：原文件未变
  const hashAfter = fileHash(origFile);
  const mtimeAfter = fs.statSync(origFile).mtimeMs;
  ok('★原文件 SHA256 未变', hashBefore === hashAfter, `${hashBefore} == ${hashAfter}`);
  ok('★原文件 mtime 未变', mtimeBefore === mtimeAfter);

  // 新文件存在
  const newId = editRes.newSessionId;
  const newFile = path.join(path.dirname(origFile), newId + '.jsonl');
  ok('★新会话文件已创建', fs.existsSync(newFile), path.basename(newFile));

  // 新会话可读且含修改
  const newContent = await jget(`/api/cli/claude/session/${newId}?projectName=${encodeURIComponent(proj.name)}`);
  const hasEditMark = Array.isArray(newContent) && JSON.stringify(newContent).includes('[EDIT-TEST]');
  ok('★新会话内容含编辑标记', hasEditMark);

  // 元数据 forkedFrom
  const meta = await jget(`/api/meta/${newId}`);
  ok('新会话元数据 forkedFrom 指向原会话', meta.forkedFrom === sess.id, meta.forkedFrom?.slice(0,8));

  // 清理测试新会话
  moveToTrash(newFile);
  ok('已清理测试新会话文件', !fs.existsSync(newFile));

  // ========= fork 测试 =========
  log('\n--- fork 测试 ---');
  const forkRes = await jpost(`/api/session/claude/${sess.id}/fork`, {projectName: proj.name});
  ok('POST /fork 返回 ok', forkRes.ok, forkRes.error || `newId=${(forkRes.newSessionId||'').slice(0,8)}`);
  const forkFile = path.join(path.dirname(origFile), forkRes.newSessionId + '.jsonl');
  ok('fork 新文件存在', fs.existsSync(forkFile));
  ok('fork 后原文件未变', fileHash(origFile) === hashBefore);
  // fork 的文件可被适配器读回
  const forkContent = await jget(`/api/cli/claude/session/${forkRes.newSessionId}?projectName=${encodeURIComponent(proj.name)}`);
  ok('fork 新会话可读', Array.isArray(forkContent) && forkContent.length > 0, `${forkContent.length} 行`);
  moveToTrash(forkFile);
  ok('已清理 fork 测试文件', !fs.existsSync(forkFile));

  // ========= open 测试（不实际开窗，验证返回） =========
  log('\n--- open 测试 ---');
  const openRes = await jpost(`/api/session/claude/${sess.id}/open`, {projectName: proj.name});
  ok('POST /open 返回 ok', openRes.ok, openRes.error || '');
  ok('open 命令含绝对路径', openRes.cliPath && openRes.cmd.includes(openRes.cliPath), openRes.cmd?.slice(0,60));
  ok('open 命令含 --resume', openRes.cmd && openRes.cmd.includes('--resume'));
  ok('open cwd 是工程目录', openRes.cwd && openRes.cwd.toLowerCase().includes('claudecode'), openRes.cwd);

  // open 不存在的会话 -> 404
  const openBad = await jpost(`/api/session/claude/nonexistent-id-12345/open`, {projectName: proj.name});
  ok('open 不存在会话被拒绝', !openBad.ok || openBad.error, openBad.error);

  // ========= 备份测试 =========
  log('\n--- 备份测试 ---');
  const backupRes = await jpost('/api/backup/run', {});
  ok('POST /backup/run 返回 ok', backupRes.ok, backupRes.error || '');
  const localTarget = (backupRes.results||[]).find(r=>r.target==='local');
  ok('备份含 local 目标', localTarget && localTarget.ok, localTarget?.message?.slice(0,50));

  // ========= codex 测试（如有数据）=========
  log('\n--- codex 适配器测试 ---');
  const codexProjs = await jget('/api/cli/codex/projects');
  if (codexProjs.length > 0) {
    const cproj = codexProjs[0];
    const csessions = await jget(`/api/cli/codex/project/${encodeURIComponent(cproj.name)}/sessions`);
    ok('codex 会话列表有数据', csessions.length > 0, `${csessions.length} 个`);
    if (csessions.length > 0) {
      const csess = csessions[0];
      const ccontent = await jget(`/api/cli/codex/session/${csess.id}?projectName=${encodeURIComponent(cproj.name)}`);
      ok('codex 会话内容可读', Array.isArray(ccontent), `${ccontent.length} 行`);
      const craw = await jget(`/api/session/codex/${csess.id}/raw?projectName=${encodeURIComponent(cproj.name)}`);
      ok('codex /raw 返回行数组', Array.isArray(craw.lines), `${craw.lines.length} 行`);
      // codex fork 测试
      const cforkRes = await jpost(`/api/session/codex/${csess.id}/fork`, {projectName: cproj.name});
      ok('codex fork 返回 ok', cforkRes.ok, cforkRes.error || '');
      if (cforkRes.ok && cforkRes.newFilePath) {
        ok('codex fork 文件存在', fs.existsSync(cforkRes.newFilePath), path.basename(cforkRes.newFilePath));
        // 关键：fork 文件能被 codex 适配器读回（验证格式合法）
        const cforkContent = await jget(`/api/cli/codex/session/${cforkRes.newSessionId}?projectName=${encodeURIComponent(cproj.name)}`);
        ok('★codex fork 文件可被适配器读回（格式合法）', Array.isArray(cforkContent) && cforkContent.length > 0, `${cforkContent.length} 行`);
        moveToTrash(cforkRes.newFilePath);
      }
    }
  } else {
    ok('codex 无数据（跳过）', true);
  }

  // ========= 汇总 =========
  log('\n========== 汇总 ==========');
  const passed = results.filter(r=>r.ok).length;
  const failed = results.filter(r=>!r.ok).length;
  log(`通过: ${passed}  失败: ${failed}  总计: ${results.length}`);
  if (failed > 0) {
    log('失败项:');
    results.filter(r=>!r.ok).forEach(r=>log('  ✗ '+r.name+(r.detail?'  '+r.detail:'')));
  }
  s.server.close();
  if (s.backupTimer) clearInterval(s.backupTimer);
  process.exit(failed > 0 ? 1 : 0);
})();
