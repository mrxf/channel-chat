// 端到端加密：口令 → scrypt 拉伸 → HKDF 派生出 (加密密钥, 房间ID, 指纹)。
// 服务器只看得到房间 ID（不可逆哈希）和密文。纯 JS 实现，HTTP 局域网下也可用。
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const PAD = 256; // 明文按 256 字节对齐，隐藏消息长度

export async function deriveSession(passphrase) {
  const master = await scryptAsync(passphrase.normalize('NFKC'), 'lan-burn-chat/v1', {
    N: 2 ** 15, r: 8, p: 1, dkLen: 32,
  });
  const sub = (info, len) => hkdf(sha256, master, undefined, enc.encode(info), len);
  const session = {
    key: sub('enc', 32),
    roomId: bytesToHex(sub('room', 32)),
    fingerprint: bytesToHex(sub('fingerprint', 4)),
  };
  master.fill(0);
  return session;
}

const b64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function seal(session, obj) {
  const raw = enc.encode(JSON.stringify(obj));
  const padded = new Uint8Array(Math.ceil((raw.length + 1) / PAD) * PAD).fill(0x20);
  padded.set(raw);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(session.key, nonce, enc.encode(session.roomId)).encrypt(padded);
  const out = new Uint8Array(24 + ct.length);
  out.set(nonce);
  out.set(ct, 24);
  return b64(out);
}

export function open(session, data) {
  try {
    const buf = unb64(data);
    const pt = xchacha20poly1305(session.key, buf.subarray(0, 24), enc.encode(session.roomId)).decrypt(buf.subarray(24));
    return JSON.parse(dec.decode(pt));
  } catch {
    return null; // 篡改 / 口令不一致 / 垃圾数据 → 丢弃
  }
}

export const randomId = () => bytesToHex(randomBytes(8));

/* ---------- 本地保存的口令 ----------
 * 「Remember on this Mac」时口令写到应用配置目录。密钥 = HKDF(本机硬件 UUID)，格式 "v1:" + base64(nonce ‖ 密文)。
 * 作用是让文件不是明文、拷到别的电脑上解不开；能登录这台 Mac 账户的人仍然可以解开。
 */
const LOCAL_PREFIX = 'v1:';
const localKey = (deviceId) => hkdf(sha256, enc.encode(String(deviceId)), enc.encode('agent-workspace/local-secret'), enc.encode('session-key'), 32);

export function sealLocal(text, deviceId) {
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(localKey(deviceId), nonce).encrypt(enc.encode(text));
  const out = new Uint8Array(24 + ct.length);
  out.set(nonce);
  out.set(ct, 24);
  return LOCAL_PREFIX + b64(out);
}

export function openLocal(blob, deviceId) {
  try {
    if (typeof blob !== 'string' || !blob.startsWith(LOCAL_PREFIX)) return null;
    const buf = unb64(blob.slice(LOCAL_PREFIX.length));
    return dec.decode(xchacha20poly1305(localKey(deviceId), buf.subarray(0, 24)).decrypt(buf.subarray(24)));
  } catch {
    return null;
  }
}

// 生成易读易口述的口令：4 组 × 4 位，去掉易混淆字符（0 o 1 l i），约 79 bit 熵
const KEY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function generateKey(groups = 4, size = 4) {
  const out = [];
  const buf = new Uint8Array(1);
  const limit = 256 - (256 % KEY_ALPHABET.length); // 拒绝采样，避免取模偏差
  while (out.length < groups * size) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) out.push(KEY_ALPHABET[buf[0] % KEY_ALPHABET.length]);
  }
  return out.join('').match(new RegExp(`.{${size}}`, 'g')).join('-');
}

/* ---------- 附件分块（二进制帧） ----------
 * 帧格式：[版本 1B][附件ID 8B][块序号 u32 BE][nonce 24B][密文]
 * AAD = 房间ID ‖ 帧头 13B ‖ 总块数 u32 —— 块被调换顺序、挪到别的附件、截断都会解密失败
 */
const CHUNK_VER = 1;
const HEAD = 13;

function chunkAad(session, header, total) {
  const room = enc.encode(session.roomId);
  const aad = new Uint8Array(room.length + HEAD + 4);
  aad.set(room);
  aad.set(header, room.length);
  new DataView(aad.buffer).setUint32(room.length + HEAD, total);
  return aad;
}

export function sealChunk(session, idHex, index, total, plain) {
  const header = new Uint8Array(HEAD);
  header[0] = CHUNK_VER;
  header.set(hexToBytes(idHex), 1);
  new DataView(header.buffer).setUint32(9, index);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(session.key, nonce, chunkAad(session, header, total)).encrypt(plain);
  const frame = new Uint8Array(HEAD + 24 + ct.length);
  frame.set(header);
  frame.set(nonce, HEAD);
  frame.set(ct, HEAD + 24);
  return frame;
}

/** 只读帧头（明文部分），用于路由；不解密 */
export function chunkHeader(frame) {
  if (frame.length < HEAD + 24 + 16 || frame[0] !== CHUNK_VER) return null;
  return { id: bytesToHex(frame.subarray(1, 9)), index: new DataView(frame.buffer, frame.byteOffset).getUint32(9) };
}

export function openChunk(session, frame, total) {
  try {
    const header = frame.subarray(0, HEAD);
    return xchacha20poly1305(session.key, frame.subarray(HEAD, HEAD + 24), chunkAad(session, header, total)).decrypt(frame.subarray(HEAD + 24));
  } catch {
    return null;
  }
}
