#!/usr/bin/env node

const path = require('path');

const command = process.argv[2] || 'help';

// ========== Help ==========
function showHelp() {
  console.log(`
cc-manager — Claude Code / Codex CLI 的本地会话管理与备份工具

用法:
  cc-manager ui [port]    启动 Web UI（默认端口 17890）
  cc-manager backup       执行一次增量备份
  cc-manager backup --init 初始化备份仓库并配置远程
  cc-manager restore      打开恢复界面（在 UI 中操作）
  cc-manager help         显示此帮助

环境变量:
  CC_MANAGER_GH_TOKEN     GitHub 经典令牌（用于推送备份到私有仓库）
                          不可代码硬编码，仅在 env 中。
`);
}

// ========== UI ==========
async function cmdUI() {
  const port = parseInt(process.argv[3]) || 17890;
  const { startServer } = require('./server');
  const server = startServer(port);
  // 尝试自动打开浏览器
  const { execSync } = require('child_process');
  try {
    execSync(`start http://localhost:${port}`, { timeout: 3000 });
  } catch (e) { /* 浏览器启动可能失败 */ }
}

// ========== Backup ==========
async function cmdBackup() {
  const store = require('./store');
  const backup = require('./backup');
  const os = require('os');

  if (process.argv.includes('--init')) {
    // 初始化
    console.log('正在初始化备份仓库...');
    const initResult = backup.gitInit();
    if (!initResult.ok) {
      console.error('初始化失败:', initResult.error);
      process.exit(1);
    }
    console.log('✓ 本地备份仓库已初始化');
    console.log('');
    console.log('接下来，你需要手动配置远程仓库：');
    console.log('');
    console.log('1️⃣  在 GitHub 上新建一个私有仓库（不需要初始化 README）');
    console.log('2️⃣  复制仓库的 HTTPS URL（如 https://github.com/你的用户名/cc-sessions-backup.git）');
    console.log('3️⃣  运行下面这个命令来配置远程地址：');
    console.log(`    cc-manager backup --set-remote <你的仓库URL>`);
    console.log('');
    console.log('4️⃣  设置环境变量（用于自动推送）：');
    console.log('    ! [Environment]::SetEnvironmentVariable(\'CC_MANAGER_GH_TOKEN\',\'你的token\',\'User\')');
    console.log('    然后重启终端或运行: $env:CC_MANAGER_GH_TOKEN="你的token"');
    console.log('');
    console.log('5️⃣  首次推送运行: cc-manager backup --first-push');
    return;
  }

  if (process.argv.includes('--set-remote')) {
    const idx = process.argv.indexOf('--set-remote') + 1;
    const repoUrl = process.argv[idx];
    if (!repoUrl) {
      console.error('需要提供仓库 URL');
      process.exit(1);
    }
    const result = backup.gitSetRemote(repoUrl);
    if (!result.ok) {
      console.error('设置远程仓库失败:', result.error);
      process.exit(1);
    }
    store.updateConfig({ repoUrl });
    console.log(`✓ 远程仓库已配置: ${repoUrl}`);
    return;
  }

  if (process.argv.includes('--first-push')) {
    const result = backup.runBackup();
    if (result.ok) {
      console.log('✓ 首次备份成功！配置完成。');
    } else {
      console.error('首次备份失败:', result.error);
    }
    return;
  }

  // 普通备份
  console.log('正在备份会话文件...');
  const result = backup.runBackup();
  if (result.ok) {
    console.log('✓', result.message || '备份完成');
    if (result.pushError) {
      console.warn('⚠ 推送失败:', result.pushError);
      console.warn('请确认 CC_MANAGER_GH_TOKEN 环境变量已设置');
    }
  } else {
    console.error('✗ 备份失败:', result.error);
    process.exit(1);
  }
}

// ========== Restore ==========
async function cmdRestore() {
  const backup = require('./backup');
  const history = backup.listBackupHistory(20);
  if (!history.length) {
    console.log('没有备份历史。');
    return;
  }
  console.log('最近备份:');
  history.forEach((h, i) => {
    const date = new Date(h.timestamp).toLocaleString();
    console.log(`  ${i + 1}. ${date}  ${h.hash.slice(0, 8)}  ${h.message}`);
  });
  console.log('');
  console.log('使用 UI 进行恢复：cc-manager ui');
  console.log('或在 UI 中打开备份历史并选择要恢复的 commit。');
}

// ========== Dispatch ==========
(async () => {
  switch (command) {
    case 'ui':
      await cmdUI();
      break;
    case 'backup':
      await cmdBackup();
      break;
    case 'restore':
      await cmdRestore();
      break;
    default:
      showHelp();
  }
})().catch(e => {
  console.error('未处理错误:', e);
  process.exit(1);
});
