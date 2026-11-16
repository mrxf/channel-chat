// 端到端互通测试用的「桌面端」对端：用桌面端同一份 src/crypto.js 加解密，模拟桌面客户端的协议行为。
//   node tool/peer.mjs <ws-url> <口令>
// 收到的每条解密后消息以一行 JSON 打到 stdout，供 Dart 测试断言。
import { deriveSession, seal, open, randomId, sealChunk, chunkHeader, openChunk } from '../../src/crypto.js';
import { createHash } from 'node:crypto';

const [url, pass] = process.argv.slice(2);
const s = await deriveSession(pass);
const cid = randomId();
const log = (o) => console.log(JSON.stringify(o));
const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';
let phoneConn = null, phoneCid = null;
const incoming = new Map();

const send = (obj, to) => ws.send(JSON.stringify({ type: 'relay', data: seal(s, { name: 'desk', cid, ...obj }), ...(to ? { to } : {}) }));

// 测试图片：1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function sendImage(to) {
  const id = randomId();
  const bytes = new Uint8Array(PNG);
  send({ t: 'media', id, ts: Date.now(), mtype: 'image', mime: 'image/png', size: bytes.length, chunks: 1, w: 1, h: 1, dur: 0, thumb: '' }, to);
  ws.send(sealChunk(s, id, 0, 1, bytes));
  log({ ev: 'sent-image', id, sha: createHash('sha256').update(bytes).digest('hex') });
}

ws.onmessage = (ev) => {
  if (ev.data instanceof ArrayBuffer) {
    const frame = new Uint8Array(ev.data);
    const h = chunkHeader(frame);
    const it = h && incoming.get(h.id);
    if (!it) return;
    it.frames[h.index] = frame;
    if (it.frames.filter(Boolean).length === it.chunks) {
      const parts = it.frames.map((f) => openChunk(s, f, it.chunks));
      const ok = parts.every(Boolean);
      const buf = ok ? Buffer.concat(parts.map((p) => Buffer.from(p))) : null;
      log({ ev: 'media-complete', id: h.id, ok, size: buf?.length, sha: buf ? createHash('sha256').update(buf).digest('hex') : null });
      send({ t: 'mrecv', id: h.id, ...(it.dm ? { dm: phoneCid } : {}) }, phoneConn);
      send({ t: 'mview', id: h.id, ...(it.dm ? { dm: phoneCid } : {}) }, phoneConn);
    }
    return;
  }
  const m = JSON.parse(ev.data);
  if (m.type === 'welcome') ws.send(JSON.stringify({ type: 'join', room: s.roomId }));
  else if (m.type === 'joined') { send({ t: 'hello', caps: ['media', 'dm'], v: '1.1.6' }); log({ ev: 'joined' }); }
  else if (m.type === 'relay') {
    const inner = open(s, m.data);
    if (!inner) return log({ ev: 'decrypt-failed' });
    log({ ev: 'inner', from: m.from, ...inner, data: undefined });
    if (inner.t === 'hello' || inner.t === 'hi') {
      phoneConn = m.from; phoneCid = inner.cid;
      if (inner.t === 'hello') send({ t: 'hi', cfg: { keep: 2, ttl: 0, mview: 5 }, caps: ['media', 'dm'], v: '1.1.6' }, m.from);
      setTimeout(() => {
        send({ t: 'msg', id: randomId(), text: '来自桌面端的群聊消息', ts: Date.now() });
        send({ t: 'msg', id: randomId(), text: '来自桌面端的私聊', ts: Date.now(), dm: phoneCid }, phoneConn);
        sendImage();
        send({ t: 'action', id: randomId(), ts: Date.now(), prefix: '拍了拍', suffix: '肩膀', dm: phoneCid }, phoneConn);
      }, 300);
    }
    if (inner.t === 'msg') send({ t: 'read', ids: [inner.id], ...(inner.dm ? { dm: phoneCid } : {}) }, m.from);
    if (inner.t === 'media') incoming.set(inner.id, { chunks: inner.chunks, frames: new Array(inner.chunks), dm: !!inner.dm });
  }
};
ws.onclose = () => log({ ev: 'closed' });
setTimeout(() => process.exit(0), Number(process.env.PEER_TTL || 30000));
