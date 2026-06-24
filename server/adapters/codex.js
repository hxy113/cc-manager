const fs = require('fs');
const path = require('path');
const os = require('os');

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

// ========== 工具函数 ==========

function parseJsonl(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (e) { return []; }
}

function getPayload(line) {
  let p = line.payload;
  if (typeof p === 'string') try { p = JSON.parse(p); } catch (e) {}
  return p || {};
}

// 扫描所有会话文件
function scanAllSessionFiles() {
  const files = [];
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return files;
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(fullPath); }
      else if (entry.name.endsWith('.jsonl') && !entry.name.endsWith('.backup.jsonl')) { files.push(fullPath); }
    }
  }
  walk(CODEX_SESSIONS_DIR);
  return files;
}

// 从 session_meta 中提取 cwd（项目路径）
function detectCwd(parsed) {
  for (const line of parsed) {
    if (line.type === 'session_meta') {
      const p = getPayload(line);
      if (p.cwd) return p.cwd;
    }
  }
  return null;
}

// 提取第一条真实的用户输入文本（跳过 <environment_context> 系统注入）
function extractTitle(parsed) {
  let foundUserContent = false;
  for (const line of parsed) {
    if (line.type !== 'response_item') continue;
    const p = getPayload(line);
    if (p.type !== 'message' || p.role !== 'user') continue;
    if (!Array.isArray(p.content)) continue;

    for (const block of p.content) {
      if (block.type === 'input_text' && block.text) {
        const raw = block.text;
        // 检查原始文本是否包含环境上下文 XML 标签
        if (/<environment_context/i.test(raw)) continue;
        // 也跳过纯 `<permissions` 和 `<cwd` 开头的系统注入
        if (/^<permissions/i.test(raw) || /^<cwd/i.test(raw)) continue;

        let t = raw.replace(/<[^>]+>/g, '').trim();
        if (!t) continue;
        // 跳过长度过短且只含日期/路径的模糊上下文
        if (t.length < 15 && /^\d|[/\\]/.test(t)) continue;
        // 去掉开头的 /submit 或命令前缀
        t = t.replace(/^\/submit\s*/i, '').trim();
        if (t) return t.slice(0, 80);
      }
    }
    foundUserContent = true;
  }

  // 回退：从 event_msg 用户消息中取
  if (!foundUserContent) {
    for (const line of parsed) {
      if (line.type === 'event_msg') {
        const p = getPayload(line);
        if (p.type === 'user_message' && p.content) {
          let t = (typeof p.content === 'string' ? p.content : '').replace(/<[^>]+>/g, '').trim();
          if (t) return t.slice(0, 80);
        }
      }
    }
  }
  return '';
}

// 统计消息数（含 user + assistant + tool_use）
function countMessages(parsed) {
  let count = 0;
  for (const line of parsed) {
    if (line.type !== 'response_item') continue;
    const p = getPayload(line);
    if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) count++;
  }
  return count;
}

// 将 Codex 格式转换为前端可渲染的 Claude-like 格式
function normalizeContent(parsed) {
  const result = [];

  for (const line of parsed) {
    if (line.type === 'session_meta') continue;
    if (line.type === 'turn_context') continue;

    const p = getPayload(line);

    if (line.type === 'response_item' && p.type === 'message') {
      const contentBlocks = [];
      if (Array.isArray(p.content)) {
        for (const block of p.content) {
          if (block.type === 'input_text' || block.type === 'output_text') {
            // 剥离环境上下文 XML
            let text = block.text || '';
            text = text.replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '').trim();
            if (text) contentBlocks.push({ type: 'text', text });
          } else if (block.type === 'tool_use') {
            contentBlocks.push({ type: 'tool_use', name: block.name || '', input: block.input || {} });
          } else if (block.type === 'tool_result') {
            contentBlocks.push({ type: 'tool_result', content: block.content || '' });
          } else if (block.type === 'text') {
            if (block.text) contentBlocks.push({ type: 'text', text: block.text });
          }
        }
      }

      const role = p.role || 'assistant';
      result.push({
        type: role,
        message: { role, content: contentBlocks.length ? contentBlocks : p.content || '' },
        timestamp: line.timestamp || p.timestamp || null,
        uuid: line.uuid || null
      });
    }

    if (line.type === 'event_msg') {
      // event_msg 可能携带用户消息摘要（不是完整内容，但可备查）
      if (p.type === 'user_message' && p.content) {
        result.push({
          type: 'user',
          message: { role: 'user', content: typeof p.content === 'string' ? p.content : JSON.stringify(p.content) },
          timestamp: line.timestamp || p.timestamp || null,
          _eventOnly: true
        });
      }
    }
  }

  return result;
}

// ========== 公共 API ==========

function getProjects() {
  const files = scanAllSessionFiles();
  const projectMap = new Map();

  for (const filePath of files) {
    const parsed = parseJsonl(filePath);
    const cwd = detectCwd(parsed);
    const key = cwd || '__unknown__';
    if (!projectMap.has(key)) {
      projectMap.set(key, { displayPath: cwd || '(未关联项目)', files: [], count: 0 });
    }
    const entry = projectMap.get(key);
    entry.files.push(filePath);
    entry.count++;
  }

  const projects = [];
  for (const [, entry] of projectMap) {
    let latestMtime = 0;
    for (const f of entry.files) {
      try { const s = fs.statSync(f); if (s.mtimeMs > latestMtime) latestMtime = s.mtimeMs; } catch (e) {}
    }
    projects.push({
      name: entry.displayPath,
      displayPath: entry.displayPath,
      sessionCount: entry.count,
      latestSession: latestMtime || null,
      cli: 'codex'
    });
  }
  return projects;
}

function getSessions(projectName) {
  const files = scanAllSessionFiles();
  const sessions = [];
  const targetPath = projectName === '(未关联项目)' ? null : projectName;

  for (const filePath of files) {
    const parsed = parseJsonl(filePath);
    const cwd = detectCwd(parsed);
    if (targetPath === null ? cwd !== null : cwd !== targetPath) continue;

    try {
      const stat = fs.statSync(filePath);
      const fileName = path.basename(filePath, '.jsonl');
      const uuidMatch = fileName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      const sessionId = uuidMatch ? uuidMatch[1] : fileName;

      const title = extractTitle(parsed);
      const messageCount = countMessages(parsed);

      sessions.push({
        id: sessionId,
        file: path.basename(filePath),
        filePath,
        projectName: cwd || '(未关联项目)',
        title: title || sessionId.slice(0, 8),
        subtitle: sessionId,
        messageCount,
        lastActivity: stat.mtimeMs,
        cli: 'codex'
      });
    } catch (e) { /* 跳过 */ }
  }
  return sessions;
}

function getSessionContent(sessionId) {
  const files = scanAllSessionFiles();
  for (const filePath of files) {
    if (filePath.includes(sessionId)) {
      const parsed = parseJsonl(filePath);
      if (!parsed.length) return null;
      return normalizeContent(parsed);
    }
  }
  return null;
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
    const parsed = parseJsonl(session.filePath);
    for (const line of parsed) {
      if (line.type !== 'response_item') continue;
      const p = getPayload(line);
      if (!Array.isArray(p.content)) continue;
      for (const block of p.content) {
        const text = block.text || '';
        if (regex.test(text)) matchCount++;
      }
    }

    if (matchCount > 0) {
      results.push({ sessionId: session.id, title: session.title, matchCount });
    }
  }

  return results;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  name: 'codex',
  getProjects,
  getSessions,
  getSessionContent,
  searchSessionText
};
