const fs = require('fs');
const path = require('path');
const os = require('os');

const CC_MANAGER_DIR = path.join(os.homedir(), '.cc-manager');
const META_FILE = path.join(CC_MANAGER_DIR, 'meta.json');
const CONFIG_FILE = path.join(CC_MANAGER_DIR, 'config.json');
const BACKUP_WORKSPACE = path.join(CC_MANAGER_DIR, 'backup-workspace');

// 确保目录
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ========== 元数据（别名/收藏/hidden/forkedFrom）==========
function loadMeta() {
  try {
    if (fs.existsSync(META_FILE)) {
      return JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
    }
  } catch (e) { /* 文件损坏返回默认 */ }
  return {};
}

function saveMeta(data) {
  ensureDir(CC_MANAGER_DIR);
  fs.writeFileSync(META_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// 获取单个会话的元数据
function getMeta(sessionId) {
  const all = loadMeta();
  return all[sessionId] || null;
}

// 更新元数据（别名或收藏等）
function updateMeta(sessionId, updates) {
  const all = loadMeta();
  if (!all[sessionId]) {
    all[sessionId] = { sessionId };
  }
  Object.assign(all[sessionId], updates, { updatedAt: Date.now() });
  saveMeta(all);
  return all[sessionId];
}

// 删除元数据记录
function deleteMeta(sessionId) {
  const all = loadMeta();
  delete all[sessionId];
  saveMeta(all);
}

// 获取所有收藏
function getFavorites(cli) {
  const all = loadMeta();
  const result = [];
  for (const [id, meta] of Object.entries(all)) {
    if (meta.favorite && (!cli || meta.cli === cli)) {
      result.push({ sessionId: id, ...meta });
    }
  }
  return result;
}

// ========== 配置 ==========
// 默认配置
const DEFAULT_CONFIG = {
  repoUrl: '',
  branch: 'main',
  autoIntervalMin: 60,
  backupTarget: 'local',    // 'github' | 'webdav' | 'local' | 'all'
  webdavUrl: '',
  webdavUsername: '',
  localBackupDir: '',
  lastBackupAt: null,
  lastRestoreAt: null
};

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
    }
  } catch (e) { /* 损坏返回默认 */ }
  return { ...DEFAULT_CONFIG };
}

function updateConfig(updates) {
  ensureDir(CC_MANAGER_DIR);
  const current = getConfig();
  Object.assign(current, updates);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2), 'utf-8');
  return current;
}

// 提取消息内容文本（对 tool_result 展开实际内容，对 tool_use 展示输入）
function extractContent(msg) {
  const raw = msg.message ? msg.message.content : msg.content;
  if (!raw) return '';

  if (typeof raw === 'string') return raw;

  if (Array.isArray(raw)) {
    const texts = [];
    for (const part of raw) {
      if (part.type === 'text') texts.push(part.text);
      else if (part.type === 'tool_use') {
        const input = part.input ? '\n' + JSON.stringify(part.input, null, 2) : '';
        texts.push(`[工具调用: ${part.name}]${input}`);
      } else if (part.type === 'tool_result') {
        let content = '';
        if (typeof part.content === 'string') content = part.content;
        else if (Array.isArray(part.content)) {
          content = part.content.map(b => b.text || b.content || '').join('\n').trim();
        }
        // 截取过长输出
        if (content.length > 2000) content = content.slice(0, 2000) + '\n...（输出过长，已截断）';
        texts.push(content || '[工具结果]');
      } else if (part.type === 'thinking' && part.thinking) {
        texts.push(`[思考过程]\n${part.thinking.slice(0, 500)}`);
      }
    }
    return texts.join('\n');
  }

  return '';
}

// ========== 导出为 Markdown ==========
function exportSessionAsMarkdown(messages, sessionId, sessionTitle) {
  if (!messages || !messages.length) return '# (空会话)\n';

  let md = `# ${sessionTitle || sessionId}\n`;
  md += `> 会话 ID: ${sessionId}  |  共 ${messages.length} 条消息\n\n---\n\n`;

  for (const msg of messages) {
    const type = msg.type || 'unknown';
    const role = msg.role || type;
    const timestamp = msg.timestamp ? new Date(msg.timestamp).toISOString() : '';

    // 跳过系统事件行
    if (['mode', 'permission-mode', 'attachment', 'file-history-snapshot'].includes(type)) continue;

    const extracted = extractContent(msg);
    if (!extracted && type === 'tool') continue;  // 纯工具消息无文本则跳过

    md += `### ${role.toUpperCase()} ${timestamp ? `(${timestamp})` : ''}\n\n`;
    md += extracted + '\n\n';
  }

  return md;
}

module.exports = {
  CC_MANAGER_DIR,
  BACKUP_WORKSPACE,
  ensureDir,
  loadMeta,
  saveMeta,
  getMeta,
  updateMeta,
  deleteMeta,
  getFavorites,
  getConfig,
  updateConfig,
  DEFAULT_CONFIG,
  exportSessionAsMarkdown
};
