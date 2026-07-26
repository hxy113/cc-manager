const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');

function resolveProjectDir(projectName, projectsDir = PROJECTS_DIR) {
  if (typeof projectName !== 'string' || !projectName || path.basename(projectName) !== projectName) {
    return null;
  }
  const root = path.resolve(projectsDir);
  const candidate = path.resolve(root, projectName);
  if (path.dirname(candidate) !== root) return null;
  try {
    const rootStat = fs.lstatSync(root);
    const candidateStat = fs.lstatSync(candidate);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
        !candidateStat.isDirectory() || candidateStat.isSymbolicLink()) return null;
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    return path.dirname(realCandidate) === realRoot ? realCandidate : null;
  } catch (e) {
    // 受限 Windows 运行环境可能允许直接读取目录，却禁止 realpath 遍历用户目录父级。
    // 上面的 basename + dirname + lstat 已确保它是根目录下的真实一级目录。
    if (e && e.code === 'EPERM') return candidate;
    return null;
  }
}

// --- 路径编码反解 ---
// Claude Code 把项目路径编码为目录名：
//   D:\claudecode → D--claudecode
// 规则：: 删除，\ 替换为 --
function decodeProjectDir(dirName) {
  const i = dirName.indexOf('--');
  if (i === -1) return null;
  const drive = dirName.slice(0, i);
  const rest = dirName.slice(i + 2);
  // rest 里的 -- 也可能是真实的目录里的 --，但多数情况是路径分隔
  // 保守策略：只把第一个 -- 当作驱动器分隔
  const tail = rest.split('--').join('\\');
  return drive + ':\\' + tail;
}

// 反向：项目路径 → 目录名（用于反向查找）
function encodeProjectPath(projectPath) {
  return projectPath.replace(/\\/g, '--').replace(':', '');
}

// 从消息 content（string 或 array）中提取原始文本（保留 HTML 标签用于过滤判断）
function getRawContentText(msg) {
  if (!msg || !msg.message) return '';
  const content = msg.message.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text)
      .join(' ');
  }
  return '';
}

// 提取干净文本（剥离 HTML 标签，用于标题显示）
function stripHtml(text) {
  return text.replace(/<[^>]+>/g, '').trim();
}

// 判断是否是"真正的"用户消息（跳过系统附加 / 命令包裹 / caveat）
function isMeaningfulUserMessage(msg) {
  if (msg.type !== 'user') return false;
  if (!msg.message || !msg.message.content) return false;
  const raw = getRawContentText(msg);
  if (!raw) return false;
  // 跳过系统产生的 caveat / local-command-caveat / 命令包裹
  if (/<local-command-caveat>|<caveat>|<command-name>/i.test(raw)) return false;
  return true;
}

// --- 旧版 displayCache（仅作最多优先级回退）---
let _displayCache = null;
function buildDisplayCache() {
  if (_displayCache) return _displayCache;
  const cache = {};
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const lines = fs.readFileSync(HISTORY_FILE, 'utf-8').trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.sessionId && entry.display) {
            // 保留最后一条记录（如果重名覆盖为最新）
            cache[entry.sessionId] = {
              display: entry.display,
              project: entry.project,
              timestamp: entry.timestamp
            };
          }
        } catch (e) { /* 跳过格式异常行 */ }
      }
    }
  } catch (e) { /* 文件不存在 */ }
  _displayCache = cache;
  return cache;
}

function invalidateCache() { _displayCache = null; }

// --- 扫描项目 ---
function getProjects() {
  const projects = [];
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return projects;
    const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirName = entry.name;
      const dirPath = path.join(PROJECTS_DIR, dirName);
      const displayPath = decodeProjectDir(dirName) || dirName;
      const sessionFiles = fs.readdirSync(dirPath)
        .filter(f => f.endsWith('.jsonl') && !f.endsWith('.backup.jsonl'));
      const sessionCount = sessionFiles.length;
      // 取该目录下最新的会话时间
      let latestMtime = 0;
      for (const f of sessionFiles) {
        try {
          const stat = fs.statSync(path.join(dirPath, f));
          if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
        } catch (e) { /* 忽略 */ }
      }
      projects.push({
        name: dirName,
        displayPath,
        sessionCount,
        latestSession: latestMtime || null
      });
    }
  } catch (e) { /* 项目目录不存在 */ }
  return projects;
}

// --- 取某个项目的会话列表 ---
function getSessions(projectName) {
  const sessions = [];
  const projectDir = resolveProjectDir(projectName);
  if (!projectDir) return sessions;

  const displayCache = buildDisplayCache();
  const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl') && !f.endsWith('.backup.jsonl'));

  for (const file of files) {
    const filePath = path.join(projectDir, file);
    try {
      const stat = fs.statSync(filePath);
      let sessionId = file.replace('.jsonl', '');
      let messageCount = 0;
      let firstUserMsg = '';
      let lastTimestamp = stat.mtimeMs;

      // 读取 jsonl 找第一条真正的用户消息作为标题
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        messageCount++;
        try {
          const msg = JSON.parse(line);
          // 记录 sessionId
          if (msg.sessionId && msg.sessionId.length > 30 && !sessionId.startsWith('_')) sessionId = msg.sessionId;
          if (msg.timestamp) {
            const parsedTimestamp = typeof msg.timestamp === 'number' ? msg.timestamp : Date.parse(msg.timestamp);
            if (Number.isFinite(parsedTimestamp) && parsedTimestamp > lastTimestamp) lastTimestamp = parsedTimestamp;
          }

          // 取第一条"真正"的用户消息做标题
          if (!firstUserMsg && isMeaningfulUserMessage(msg)) {
            const raw = getRawContentText(msg);
            const clean = stripHtml(raw);
            if (clean) firstUserMsg = clean.slice(0, 80);
          }
        } catch (e) { /* 跳过解析失败的行 */ }
      }

      // 标题优先级：第一条用户消息 > 历史记录的最后一条 > sessionId
      const cached = displayCache[sessionId];
      let title = firstUserMsg;
      if (!title) title = cached ? cached.display : '';
      if (!title) title = sessionId.slice(0, 8);
      const subtitle = sessionId;

      sessions.push({
        id: sessionId,
        file: file,
        filePath,
        projectName,
        title,
        subtitle,
        messageCount,
        lastActivity: lastTimestamp,
        cli: 'claude'
      });
    } catch (e) { /* 文件异常跳过 */ }
  }

  return sessions;
}

// --- 取某会话完整内容（行数组）---
function getSessionContent(sessionId, projectName) {
  let found = null;
  if (!projectName) {
    // 未指定 projectName 时遍历查找
    const projects = getProjects();
    for (const p of projects) {
      const sessions = getSessions(p.name);
      found = sessions.find(s => s.id === sessionId);
      if (found) {
        projectName = p.name;
        break;
      }
    }
  } else {
    found = getSessions(projectName).find(s => s.id === sessionId);
  }
  if (!projectName || !found) return null;

  const filePath = found.filePath;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const result = [];
    for (const line of content.trim().split('\n')) {
      if (!line.trim()) continue;
      try { result.push(JSON.parse(line)); }
      catch (e) { /* 跳过解析失败的行（如活跃会话写到一半的末行）*/ }
    }
    return result;
  } catch (e) { return null; }
}

// --- 在会话内容中搜索（用于全文搜索）---
function searchSessionText(projectName, query, { isRegex } = {}) {
  const sessions = getSessions(projectName);
  const results = [];

  let regex;
  try {
    regex = isRegex ? new RegExp(query, 'i') : new RegExp(escapeRegex(query), 'i');
  } catch (e) {
    return { error: '正则表达式无效: ' + e.message };
  }

  for (const session of sessions) {
    let matchCount = 0;
    try {
      const content = fs.readFileSync(session.filePath, 'utf-8');
      const lines = content.trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const raw = msg.message ? msg.message.content : null;
          if (typeof raw === 'string' && regex.test(raw)) matchCount++;
          else if (Array.isArray(raw)) {
            for (const block of raw) {
              const text = block.text || '';
              if (regex.test(text)) matchCount++;
            }
          }
        } catch (e) { /* 跳过 */ }
      }
    } catch (e) { /* 读失败跳过 */ }

    if (matchCount > 0) {
      results.push({ sessionId: session.id, title: session.title, matchCount });
    }
  }

  return results;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- 读取会话原始行（未做任何转换，供 fork / 编辑使用）---
// Claude 的 getSessionContent 本就返回逐行 JSON.parse 的原始对象，直接复用
function getRawLines(sessionId, projectName) {
  return getSessionContent(sessionId, projectName);
}

// --- 写一个 fork 副本 ---
// 用新 sessionId 写到同目录新文件 <newId>.jsonl，永不覆盖源文件
// rawLines: getRawLines 返回的原始行对象数组
function writeFork(rawLines, srcFilePath, newId) {
  if (!Array.isArray(rawLines)) throw new TypeError('rawLines 必须是数组');
  if (typeof newId !== 'string' || !/^[a-zA-Z0-9_-]{8,}$/.test(newId)) {
    throw new Error('新会话 ID 不合法');
  }
  const dir = path.dirname(srcFilePath);
  const newFilePath = path.join(dir, `${newId}.jsonl`);
  const out = [];
  for (const line of rawLines) {
    const updated = { ...line };
    // 顶层 sessionId 替换为新 id（custom-title / user / assistant 等行都有）
    if (updated.sessionId) updated.sessionId = newId;
    out.push(JSON.stringify(updated));
  }
  fs.writeFileSync(newFilePath, out.join('\n') + '\n', { encoding: 'utf-8', flag: 'wx' });
  return { newFilePath, newId };
}

module.exports = {
  name: 'claude',
  getProjects,
  getSessions,
  getSessionContent,
  searchSessionText,
  getRawLines,
  writeFork,
  buildDisplayCache,
  invalidateCache,
  resolveProjectDir,
  decodeProjectDir,
  encodeProjectPath
};
