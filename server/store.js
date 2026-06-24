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

// 提取消息内容文本
function extractContent(msg) {
  const raw = msg.message ? msg.message.content : msg.content;
  if (!raw) return '';

  if (typeof raw === 'string') return raw;

  if (Array.isArray(raw)) {
    const texts = [];
    for (const part of raw) {
      if (part.type === 'text') texts.push(part.text);
      else if (part.type === 'tool_use') texts.push(`[工具调用: ${part.name}]`);
      else if (part.type === 'tool_result') texts.push(`[工具结果]`);
      else if (part.type === 'thinking') texts.push(`[思考过程]`);
    }
    return texts.join('\n');
  }

  return '';
}

// ========== 导出为 Markdown ==========
function exportSessionAsMarkdown(messages, sessionId) {
  if (!messages || !messages.length) return '# (空会话)\n';

  let md = `# 会话: ${sessionId}\n`;
  md += `> 共 ${messages.length} 条消息\n\n---\n\n`;

  for (const msg of messages) {
    const type = msg.type || 'unknown';
    const role = msg.role || type;
    const timestamp = msg.timestamp ? new Date(msg.timestamp).toISOString() : '';

    // 跳过系统事件行
    if (['mode', 'permission-mode', 'attachment', 'file-history-snapshot'].includes(type)) continue;

    md += `### ${role.toUpperCase()} ${timestamp ? `(${timestamp})` : ''}\n\n`;
    md += extractContent(msg) + '\n\n';

    if (type === 'tool') {
      md += '> `[工具调用]`' + (msg.name ? ' ' + msg.name : '') + '\n\n';
    }
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
