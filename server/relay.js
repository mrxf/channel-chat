// 纯内存密文中继：只认识房间 ID（口令派生的哈希）和随机连接 ID。
// 不解密、不记录内容、不落盘。进程退出即一切消失。
import { WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';

const MAX_PAYLOAD = 256 * 1024;
const ROOM_RE = /^[a-f0-9]{64}$/;
const RATE_WINDOW = 5000;
const RATE_MAX_TEXT = 60;               // 每连接每 5 秒：文本帧上限
const RATE_MAX_BYTES = 100 * 1024 * 1024; // 每连接每 5 秒：总字节上限（附件分块）
const SLOW_PEER_BYTES = 64 * 1024 * 1024; // 接收方积压超过此值时丢弃其二进制帧，避免拖垮服务器
const DIRECT = 0x02;      // 定向二进制帧的首字节
const DIRECT_HEAD = 7;   // 0x02 + 6 字节连接 ID

/**
 * @param {import('node:http').Server} httpServer
 * @param {{ path?: string, getWelcome?: () => object, onStats?: (s: {clients:number, rooms:number}) => void }} opts
 */
export function attachRelay(httpServer, { debug = false, path = '/ws', getWelcome = () => ({}), onStats = () => {} } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  /** @type {Map<string, Set<import('ws').WebSocket>>} */
  const rooms = new Map();
  const stats = () => onStats({ clients: wss.clients.size, rooms: rooms.size });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname !== path) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (ws, obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
  const broadcast = (room, obj, except) => {
    const data = JSON.stringify(obj);
    for (const peer of rooms.get(room) || []) if (peer !== except && peer.readyState === peer.OPEN) peer.send(data);
  };

  const leave = (ws) => {
    const room = ws.room;
    if (!room) return;
    ws.room = null;
    const set = rooms.get(room);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) rooms.delete(room);
    else broadcast(room, { type: 'leave', id: ws.id, count: set.size });
  };

  const dlog = (ws, msg) => debug && console.log(`${new Date().toISOString().slice(11, 23)} [${ws.id.slice(0, 4)} ${ws.ip}] ${msg}`);

  wss.on('connection', (ws, req) => {
    ws.id = randomBytes(6).toString('hex');
    ws.ip = req?.socket?.remoteAddress?.replace(/^::ffff:/, '') || '?';
    dlog(ws, 'connected');
    ws.room = null;
    ws.alive = true;
    ws.rate = { start: Date.now(), n: 0, bytes: 0 };
    ws.on('pong', () => (ws.alive = true));
    send(ws, { type: 'welcome', ...getWelcome() });
    stats();

    ws.on('message', (raw, isBinary) => {
      const now = Date.now();
      if (now - ws.rate.start > RATE_WINDOW) ws.rate = { start: now, n: 0, bytes: 0 };
      if ((ws.rate.bytes += raw.length) > RATE_MAX_BYTES) return;

      // 二进制帧 = 加密的附件分块，服务器不解密：
      //   首字节 0x02：定向帧 [0x02][目标连接 ID 6B][分块]，去掉前 7 字节后只转发给目标（私聊）
      //   其他：原样转发给同房间其他人（群聊）
      if (isBinary) {
        if (!ws.room) return;
        const peers = rooms.get(ws.room) || [];
        const ok = (peer) => peer !== ws && peer.readyState === peer.OPEN && peer.bufferedAmount < SLOW_PEER_BYTES;
        if (raw[0] === DIRECT && raw.length > DIRECT_HEAD) {
          const to = raw.subarray(1, DIRECT_HEAD).toString('hex');
          const body = raw.subarray(DIRECT_HEAD);
          let n = 0;
          for (const peer of peers) if (peer.id === to && ok(peer)) { peer.send(body, { binary: true }); n++; }
          dlog(ws, `binary ${body.length}B → ${n ? to.slice(0, 4) : 'nobody'}`);
          return;
        }
        let n = 0;
        for (const peer of peers) if (ok(peer)) { peer.send(raw, { binary: true }); n++; }
        dlog(ws, `binary ${raw.length}B → ${n} peer(s)`);
        return;
      }
      dlog(ws, `text ${raw.length}B`);
      if (++ws.rate.n > RATE_MAX_TEXT) return;

      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }

      if (m.type === 'join' && typeof m.room === 'string' && ROOM_RE.test(m.room)) {
        leave(ws);
        ws.room = m.room;
        if (!rooms.has(m.room)) rooms.set(m.room, new Set());
        const set = rooms.get(m.room);
        set.add(ws);
        send(ws, { type: 'joined', id: ws.id, count: set.size });
        broadcast(m.room, { type: 'join', id: ws.id, count: set.size }, ws);
        stats();
        return;
      }

      // 密文转发：data 对服务器是不透明的
      if (m.type === 'relay' && ws.room && typeof m.data === 'string') {
        const out = { type: 'relay', from: ws.id, data: m.data };
        if (typeof m.to === 'string') {
          // 定向转发（私聊、回执）：只发给同房间里的目标连接
          for (const peer of rooms.get(ws.room) || []) if (peer.id === m.to) send(peer, out);
        } else {
          broadcast(ws.room, out, ws);
        }
      }
    });

    const bye = (e) => { dlog(ws, `closed ${e instanceof Error ? e.message : e ?? ''}`); leave(ws); stats(); };
    ws.on('close', bye);
    ws.on('error', bye);
  });

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, 20000);
  wss.on('close', () => clearInterval(timer));
  return wss;
}
