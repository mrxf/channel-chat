#!/usr/bin/env node
// Agent Relay —— 局域网密文中继服务器
//   node index.js [--port 10686] [--host 0.0.0.0] [--name 名称] [--no-discovery] [--quiet] [--debug]
//   也可以用环境变量：PORT、HOST、RELAY_NAME、NO_DISCOVERY=1（Docker 里常用）
//   默认端口 10686，被占用时依次尝试到 10700（客户端约定的范围）
//   默认通过 Bonjour（mDNS）在局域网广播自己，客户端可以自动发现；--no-discovery 关闭
import http from 'node:http';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attachRelay } from './relay.js';

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const PORT_MIN = 10686, PORT_MAX = 10700;
const FIXED_PORT = flag('port', process.env.PORT); // 显式指定端口时不自动递增
let PORT = Number(FIXED_PORT || PORT_MIN);
const DISCOVERY = !args.includes('--no-discovery') && !/^(1|true|yes)$/i.test(process.env.NO_DISCOVERY || '');
const MDNS_TYPE = 'agentws'; // 客户端浏览 _agentws._tcp
const HOST = flag('host', process.env.HOST || '0.0.0.0');
const QUIET = args.includes('--quiet');
const DEBUG = args.includes('--debug'); // 只打印每一帧的大小和类型，不含任何内容
const NAME = flag('name', process.env.RELAY_NAME || os.hostname().replace(/\.local$/, ''));
const ACTIONS_FILE = fileURLToPath(new URL('./actions.json', import.meta.url));
const MAX_ACTION_LEN = 200;

/** 每次读取，改 actions.json 后新连接即时生效 */
function loadActions() {
  try {
    const list = JSON.parse(readFileSync(ACTIONS_FILE, 'utf8')).actions;
    return (Array.isArray(list) ? list : [])
      .filter((a) => a && typeof a.prefix === 'string' && typeof (a.suffix ?? '') === 'string')
      .map((a) => ({ prefix: a.prefix.trim(), suffix: (a.suffix ?? '').trim() }))
      .filter((a) => a.prefix && a.prefix.length + a.suffix.length <= MAX_ACTION_LEN)
      .slice(0, 50);
  } catch (e) {
    console.warn('  ⚠ actions.json 读取失败，使用空列表:', e.message);
    return [];
  }
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url || '/', 'http://x');
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  if (pathname === '/' || pathname === '/health') return json(200, { ok: true, name: NAME, app: 'agent-relay', version: 2, features: ['media', 'direct'] });
  if (pathname === '/actions') return json(200, { actions: loadActions() });
  json(404, { ok: false });
});

let last = '';
attachRelay(server, {
  debug: DEBUG,
  getWelcome: () => ({ name: NAME, actions: loadActions(), maxActionLength: MAX_ACTION_LEN, features: ['media', 'direct'], version: 2 }),
  onStats: ({ clients, rooms }) => {
    const line = `${clients} 个连接 · ${rooms} 个房间`;
    if (!QUIET && line !== last) console.log(`  [${new Date().toLocaleTimeString()}] ${line}`);
    last = line;
  },
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && !FIXED_PORT && PORT < PORT_MAX) {
    PORT++;
    return server.listen(PORT, HOST);
  }
  console.error(e.code === 'EADDRINUSE' ? `\n  端口 ${PORT} 已被占用，换一个：node index.js --port ${PORT + 1}\n` : e);
  process.exit(1);
});

// 局域网广播（Bonjour / mDNS）：只公布名称和端口，不含任何会话信息
let bonjour = null;
async function advertise() {
  if (!DISCOVERY) return '  局域网自动发现：已关闭（--no-discovery）';
  try {
    const { Bonjour } = await import('bonjour-service');
    bonjour = new Bonjour();
    bonjour.publish({ name: `${NAME}-${PORT}`, type: MDNS_TYPE, port: PORT, txt: { app: 'agent-relay', v: '2', name: NAME } });
    return '  局域网自动发现：已开启，客户端打开登录页会自动填入地址';
  } catch {
    return '  局域网自动发现：不可用（先执行 cd server && npm i）';
  }
}

server.on('listening', async () => {
  console.log(`\n  Agent Relay 已启动（${NAME}）——只转发密文，不存储任何内容\n`);
  console.log('  在客户端「Server」里填写以下任一地址：');
  console.log(`    localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`    ${i.address}:${PORT}`);
  console.log(`\n${await advertise()}`);
  console.log('  动作配置：server/actions.json（修改即时生效）  Ctrl+C 停止\n');
});
server.listen(PORT, HOST);

const stop = () => {
  console.log('\n  已停止，内存已清空。');
  if (!bonjour) process.exit(0);
  // 先发「下线」通告，客户端列表里会立即消失
  bonjour.unpublishAll(() => { bonjour.destroy(); process.exit(0); });
  setTimeout(() => process.exit(0), 800);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
