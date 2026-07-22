// 后台启动服务器用于 UI 测试（不开浏览器）
const { startServer } = require('../server/server');
startServer(17990);
console.log('UI 测试服务器: http://localhost:17990');
