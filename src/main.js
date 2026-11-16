import './style.css';
import { deriveSession, seal, open, randomId, generateKey, sealChunk, chunkHeader, openChunk } from './crypto.js';
import { prepareFile, fmtSize, fmtDur, CHUNK, MAX_VIDEO, MAX_IMAGE_RAW, MAX_INFLIGHT, IMAGE_MIME, VIDEO_MIME } from './media.js';
import { native } from './native.js';
import { createRunner } from './runner.js';
import { PERSONAS, getPersona } from './personas.js';
import { SERVER_LIST_URL, DEFAULT_PORT, DISCOVERY_PORT, MAX_ACTION_LEN } from './config.js';

const $ = (s) => document.querySelector(s);
// 客户端能力：旧版客户端的 hello/hi 不带 caps。media = 能收附件，dm = 支持私聊
const CAPS = ['media', 'dm'];
const APP_VERSION = __APP_VERSION__;
document.getElementById('join-ver').textContent = `v${APP_VERSION}`;
const MAX_SKEW = 10 * 60 * 1000; // 拒绝 10 分钟外的消息（防重放）
const TICK = 250;
const ACTION_TTL = 20; // 动作读完 20 秒后焚毁

/* ---------------- 本地偏好（不含任何消息内容） ---------------- */
const prefs = Object.assign(
  { name: '', server: '', recentServers: [], theme: null, blurHide: false, notify: true, runner: true, runnerOpen: true, protect: false, customActions: [], persona: 'dev', rememberKey: true, recentNames: {}, dmNames: {}, memberLabel: 'name' },
  await native.loadPrefs(),
);
const savePrefs = () => native.savePrefs(prefs);
const MEDIA_VIEW_OPTS = [5, 10, 30, 60];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBUG_MEDIA = import.meta.env.DEV && !!import.meta.env.VITE_AUTOVIEW;

/* ---------------- 运行时状态（仅内存） ---------------- */
// 会话：GROUP 是群聊；和某人的私聊是 `d:<对方 cid>`
//   cid：每个客户端进入会话时随机生成的 ID，只在内存里。断线重连不变，所以私聊不会因为重连而中断
//   服务器分配的连接 ID（conn）客户端无法伪造，成员和连接绑定，别人不能冒用你的身份发消息
const GROUP = 'g';
const state = {
  name: '', cid: '', session: null, wsUrl: '', serverName: '', ws: null, myId: null, entered: false,
  members: new Map(), // cid → { cid, name, conn, online, caps, v, warned, seq }
  conns: new Map(),   // 连接 ID → cid
  active: GROUP, online: 1, cfg: { keep: 1, ttl: 0, mview: 10 }, cfgTouched: false,
  serverMedia: false, serverDirect: false, incoming: new Map(),
  items: [], seen: new Set(), boss: false, retry: 0, compacted: new Set(),
  serverActions: [], lastAction: 0, lastNotify: 0, unread: -1, receipts: new Map(), // 会话 → 待发送的已读回执
};

/* ---------------- 工具 ---------------- */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function format(text) {
  return esc(text).split(/```/).map((part, i) => {
    if (i % 2) return `<pre><code>${part.replace(/^\w*\n/, '')}</code></pre>`;
    return part.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
  }).join('');
}
const hashNum = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const scrollDown = () => requestAnimationFrame(() => { const el = $('#scroll'); el.scrollTop = el.scrollHeight; });
let toastTimer;
function toast(t) {
  const el = $('#toast');
  el.textContent = t; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2000);
}
async function copyText(text, fallbackInput) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fallthrough */ }
  try {
    const el = fallbackInput || Object.assign(document.createElement('textarea'), { value: text });
    if (!fallbackInput) document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    if (!fallbackInput) el.remove();
    return ok;
  } catch { return false; }
}
const mark = '<span class="brand-mark sm"></span>';
const cleanName = (n) => (typeof n === 'string' && n.trim() ? n.trim().slice(0, 24) : 'peer');

/* ---------------- 成员与会话 ---------------- */
const CID_RE = /^[a-f0-9]{16}$/;
const ALIASES = ['Explore agent', 'Plan agent', 'Review agent', 'Test agent', 'Docs agent', 'Data agent', 'Build agent', 'Search agent'];
const COLORS = ['#d97757', '#5b8def', '#3fa37a', '#b06cd8', '#c9962a', '#e05d8c', '#2fa7b8', '#7d8a5a'];
let memberSeq = 0;

const dmConv = (cid) => `d:${cid}`;
const isDm = (conv) => conv.startsWith('d:');
const convPeer = (conv) => (isDm(conv) ? state.members.get(conv.slice(2)) : null);
const hasCap = (p, c) => p.caps.includes(c);
const onlineMembers = () => [...state.members.values()].filter((p) => p.online);
const convItems = (conv) => state.items.filter((i) => i.conv === conv);

/**
 * 根据服务器分配的连接 ID 找到（或建立）成员。
 * 一个连接第一次出现时绑定它声明的 cid，之后这个连接只能代表这个成员。
 */
function bindMember(conn, m) {
  let cid = state.conns.get(conn);
  if (!cid) {
    cid = typeof m.cid === 'string' && CID_RE.test(m.cid) && m.cid !== state.cid ? m.cid : conn; // 旧版客户端没有 cid，用连接 ID
    state.conns.set(conn, cid);
  }
  const name = cleanName(m.name);
  let p = state.members.get(cid);
  let isNew = false;
  if (!p) {
    // 对方重启了应用（cid 变了）：沿用同名的离线成员，私聊记录接得上
    const prev = [...state.members.values()].find((x) => !x.online && x.name === name);
    if (prev) { rekeyMember(prev, cid); p = prev; }
    else {
      p = { cid, name, conn: null, online: false, caps: [], v: null, warned: false, seq: ++memberSeq };
      state.members.set(cid, p);
      isNew = true;
    }
  }
  const back = !p.online && !isNew;
  if (p.conn && p.conn !== conn) state.conns.delete(p.conn); // 对方重连，旧连接作废
  p.conn = conn;
  p.online = true;
  p.name = name;
  return { p, isNew, back };
}

function rekeyMember(p, cid) {
  const old = p.cid;
  const from = dmConv(old), to = dmConv(cid);
  state.members.delete(p.cid);
  p.cid = cid;
  state.members.set(cid, p);
  for (const it of state.items) {
    if (it.conv === from) it.conv = to;
    if (it.cid === old) it.cid = cid; // 他之前发的消息仍然算他的（轮次、回执）
    for (const set of [it.need, it.readBy, it.recvBy, it.viewBy]) if (set?.delete(old)) set.add(cid);
  }
  const t = threadEl(from);
  if (t) t.dataset.conv = to;
  if (state.receipts.has(from)) { state.receipts.set(to, state.receipts.get(from)); state.receipts.delete(from); }
  if (state.compacted.delete(from)) state.compacted.add(to);
  if (state.active === from) state.active = to;
}

/** 显示用的名称和颜色：重名时加上 cid 前缀区分；代号模式下每人一个固定的子 Agent 名 */
function labels() {
  const list = [...state.members.values()].sort((a, b) => a.seq - b.seq);
  // 只有当前还在的人（在线，或者还有私聊记录）才算重名
  const count = new Map();
  for (const p of list) if (p.online || convItems(dmConv(p.cid)).length) count.set(p.name, (count.get(p.name) || 0) + 1);
  const used = new Set();
  const out = new Map();
  for (const p of list) {
    const dup = (count.get(p.name) || 0) > 1 || p.name === state.name;
    let text;
    if (prefs.memberLabel === 'alias') {
      let k = hashNum(p.name) % ALIASES.length;
      for (let n = 0; used.has(k) && n < ALIASES.length; n++) k = (k + 1) % ALIASES.length;
      text = used.has(k) ? `${ALIASES[k]} ${p.seq}` : ALIASES[k];
      used.add(k);
    } else {
      text = dup ? `${p.name}·${p.cid.slice(0, 3)}` : p.name;
    }
    out.set(p.cid, { text, color: COLORS[hashNum(dup ? p.cid : p.name) % COLORS.length] });
  }
  return out;
}
const labelOf = (p) => labels().get(p.cid) || { text: p.name, color: COLORS[0] };
const whoHTML = (p, cls = 'peer') => {
  const l = labelOf(p);
  return `<span class="${cls}" data-cid="${esc(p.cid)}"><i style="background:${l.color}"></i>${esc(l.text)}</span>`;
};
/** 切换显示方式或成员变化后，刷新界面上已有的名字 */
function refreshLabels() {
  const L = labels();
  document.querySelectorAll('#threads [data-cid]').forEach((el) => {
    const l = L.get(el.dataset.cid);
    if (!l) return;
    el.lastChild.textContent = l.text;
    el.querySelector('i').style.background = l.color;
  });
  renderRecents();
  renderHeader();
}

/** 每个会话一个消息列表，只显示当前会话 */
const threadEl = (conv) => [...$('#threads').children].find((t) => t.dataset.conv === conv);
function threadOf(conv) {
  let el = threadEl(conv);
  if (!el) {
    el = document.createElement('div');
    el.className = 'thread';
    el.dataset.conv = conv;
    el.hidden = conv !== state.active;
    $('#threads').appendChild(el);
  }
  return el;
}

function sanitizeAction(a) {
  if (!a || typeof a.prefix !== 'string') return null;
  const prefix = a.prefix.trim().replace(/\s+/g, ' ');
  const suffix = typeof a.suffix === 'string' ? a.suffix.trim().replace(/\s+/g, ' ') : '';
  if (!prefix || prefix.length + suffix.length > MAX_ACTION_LEN) return null;
  return { prefix, suffix };
}
/** 「{prefix}{target}的{suffix}」，suffix 为空时省略「的」 */
const actionText = (a, target) => `${a.prefix}${target}${a.suffix ? '的' + a.suffix : ''}`;

/* ---------------- 服务器地址 ---------------- */
function toWsUrl(input) {
  let s = input.trim();
  if (!s) throw new Error('请填写服务器地址');
  if (!/^[a-z]+:\/\//i.test(s)) s = 'ws://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error('服务器地址格式不对，例如 192.168.1.5:10686'); }
  if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol === 'https:') u.protocol = 'wss:';
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('不支持的协议');
  if (!u.port && u.protocol === 'ws:') u.port = String(DEFAULT_PORT);
  u.pathname = '/ws'; u.search = ''; u.hash = '';
  return u.toString();
}
function httpUrl(wsUrl, path) {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = path;
  return u.toString();
}
const shortServer = (wsUrl) => new URL(wsUrl).host;

/* ================================================================
 *  加入页
 * ================================================================ */
$('#name').value = prefs.name;
$('#server').value = prefs.server;

function renderServerList(extra = []) {
  const seen = new Set();
  const opts = [...extra, ...prefs.recentServers.map((url) => ({ url }))].filter((o) => o.url && !seen.has(o.url) && seen.add(o.url));
  $('#server-list').innerHTML = opts.map((o) => `<option value="${esc(o.url)}">${o.name ? esc(o.name) : ''}</option>`).join('');
}
renderServerList();

// 预留：从固定地址获取服务器列表（见 src/config.js）
if (SERVER_LIST_URL) {
  fetch(SERVER_LIST_URL, { cache: 'no-store' })
    .then((r) => r.json())
    .then((d) => {
      const list = (Array.isArray(d?.servers) ? d.servers : [])
        .filter((s) => s && typeof s.url === 'string')
        .map((s) => ({ url: s.url.slice(0, 200), name: typeof s.name === 'string' ? s.name.slice(0, 40) : '' }));
      renderServerList(list);
      if (!$('#server').value && list[0]) { $('#server').value = list[0].url; probe(); }
    })
    .catch(() => {});
}

// 探测服务器是否在线：输入时防抖调用；返回 true / false
let probeTimer, probeSeq = 0;
let lanFound = []; // 局域网自动发现的结果 [{ name, host, port }]
const setServerHint = (text, cls = '') => { const h = $('#server-hint'); h.textContent = text || '\u00a0'; h.className = `field-hint ${cls}`; };

async function checkServer(val) {
  const seq = ++probeSeq;
  let url;
  try { url = httpUrl(toWsUrl(val), '/health'); } catch (e) { setServerHint(e.message, 'bad'); return false; }
  setServerHint('Checking…');
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 3000);
    const d = await (await fetch(url, { signal: ctl.signal, cache: 'no-store' })).json();
    if (d?.app !== 'agent-relay') throw new Error();
    if (seq === probeSeq) {
      const more = lanFound.length > 1 ? ` · 局域网共 ${lanFound.length} 个，点输入框可切换` : '';
      setServerHint(`● Online · ${String(d.name || 'relay').slice(0, 40)}${more}`, 'good');
    }
    return true;
  } catch {
    if (seq === probeSeq) setServerHint('○ Unreachable', 'bad');
    return false;
  }
}

function probe() {
  clearTimeout(probeTimer);
  const val = $('#server').value.trim();
  if (!val) { ++probeSeq; setServerHint(''); return; }
  probeTimer = setTimeout(() => checkServer(val), 350);
}
$('#server').addEventListener('input', probe);

/* 局域网自动发现：打开登录页时先听 Bonjour 广播；找不到时可以点 Scan，在本网段探测约定端口 */
const lanUrl = (f) => `${f.host}:${f.port}`;

// force：当前地址为空 / 不可用 / 用户主动点了 Scan 时，直接填入发现的第一个
function applyFound(list, force) {
  const seen = new Set();
  lanFound = list.filter((f) => f && typeof f.host === 'string' && !seen.has(lanUrl(f)) && seen.add(lanUrl(f)));
  renderServerList(lanFound.map((f) => ({ url: lanUrl(f), name: `${String(f.name || 'relay').slice(0, 40)} · 局域网` })));
  if (!lanFound.length) return false;
  const cur = $('#server').value.trim();
  if (force && !lanFound.some((f) => lanUrl(f) === cur)) $('#server').value = lanUrl(lanFound[0]);
  checkServer($('#server').value.trim());
  return true;
}

async function scanLan() {
  const btn = $('#srv-scan');
  if (btn.disabled) return;
  btn.disabled = true; btn.textContent = '…';
  try {
    setServerHint('Searching local network…');
    let list = await native.discover(2000);
    if (!list.length) {
      setServerHint(`Scanning this subnet on port ${DISCOVERY_PORT}…`);
      list = await native.scanSubnet(DISCOVERY_PORT);
    }
    if (!applyFound(list, true)) setServerHint('局域网里没有找到服务器，请手动输入地址', 'bad');
  } finally {
    btn.disabled = false; btn.textContent = 'Scan';
  }
}

if (native.canDiscover) {
  $('#srv-scan').hidden = false;
  $('#srv-scan').onclick = scanLan;
  (async () => {
    const saved = $('#server').value.trim();
    if (!saved) setServerHint('Searching local network…');
    const [list, ok] = await Promise.all([native.discover(1500), saved ? checkServer(saved) : false]);
    if (!applyFound(list, !ok) && !saved) setServerHint('没有自动发现服务器 · 点 Scan 再找一次，或手动输入');
  })();
} else if (prefs.server) {
  probe();
}

$('#pw-toggle').onclick = () => { const p = $('#pass'); p.type = p.type === 'password' ? 'text' : 'password'; };
$('#pw-gen').onclick = async () => {
  const p = $('#pass');
  p.value = generateKey();
  p.type = 'text';
  const ok = await copyText(p.value, p);
  const hint = $('#pass-hint');
  hint.textContent = ok ? '已生成并复制，发给对方即可' : '已生成，请手动复制给对方';
  hint.className = 'field-hint good';
};

/* 记住口令：加密后保存在应用配置目录（见 native.js），勾选框取消时立即删除 */
let savedKey = null;
async function fillSavedKey() {
  if (!native.canRemember || !prefs.rememberKey) return;
  savedKey = await native.getSecret();
  if (!savedKey || $('#pass').value) return;
  $('#pass').value = savedKey;
  $('#pass').type = 'password';
  // 三项都填好了，直接回车即可进入
  if ($('#server').value.trim() && $('#name').value.trim()) $('#join-btn').focus();
}

if (native.canRemember) {
  $('#remember-row').hidden = false;
  $('#remember-key').checked = prefs.rememberKey;
  $('#remember-key').onchange = (e) => {
    prefs.rememberKey = e.target.checked;
    savePrefs();
    const hint = $('#pass-hint');
    if (!prefs.rememberKey && savedKey) {
      native.deleteSecret(); savedKey = null;
      hint.textContent = '已删除本机保存的口令'; hint.className = 'field-hint';
    }
  };
  fillSavedKey();
}

function showJoinError(msg) {
  const el = $('#join-error');
  el.textContent = msg; el.hidden = !msg;
}

$('#join-form').onsubmit = async (e) => {
  e.preventDefault();
  showJoinError('');
  const name = $('#name').value.trim().slice(0, 24);
  const pass = $('#pass').value;
  let wsUrl;
  try { wsUrl = toWsUrl($('#server').value); } catch (err) { return showJoinError(err.message); }
  if (!name) return showJoinError('请填写显示名称');
  if (pass.length < 4) return showJoinError('口令至少 4 位');

  const btn = $('#join-btn');
  btn.disabled = true; btn.textContent = 'Deriving key…';
  if (prefs.notify) native.ensureNotifyPermission();
  try {
    state.name = name;
    state.cid = randomId(); // 本次会话的成员 ID，只在内存里
    state.wsUrl = wsUrl;
    state.session = await deriveSession(pass);
    btn.textContent = 'Connecting…';
    await connect(true);
    // 记住名称和服务器；口令只有勾选时才保存
    if (native.canRemember) {
      if (prefs.rememberKey && pass !== savedKey) { if (await native.setSecret(pass)) savedKey = pass; }
      else if (!prefs.rememberKey && savedKey) { native.deleteSecret(); savedKey = null; }
    }
    prefs.name = name;
    prefs.server = $('#server').value.trim();
    prefs.recentServers = [prefs.server, ...prefs.recentServers.filter((s) => s !== prefs.server)].slice(0, 8);
    savePrefs();
    renderServerList();
    $('#pass').value = ''; $('#pass').type = 'password'; $('#pass-hint').innerHTML = '&nbsp;';
    enterMain();
  } catch (err) {
    state.session = null;
    const ws = state.ws;
    state.ws = null;
    ws?.close();
    showJoinError(err.message || '连接失败');
  } finally {
    btn.disabled = false; btn.textContent = 'Continue';
  }
};

/* ================================================================
 *  主界面
 * ================================================================ */
const persona = () => getPersona(prefs.persona);
const runner = createRunner($('#runner'), {
  profile: persona().runner,
  open: prefs.runnerOpen,
  onToggle: (o) => { prefs.runnerOpen = o; savePrefs(); },
});

function enterMain() {
  state.entered = true;
  const fp = state.session.fingerprint;
  $('#join').hidden = true;
  $('#main').hidden = false;
  $('#me-name').textContent = state.name;
  $('#avatar').textContent = [...state.name][0].toUpperCase();
  $('#fp').textContent = fp.match(/.{4}/g).join(' ');
  $('#app-ver').textContent = `v${APP_VERSION}`;
  $('#build-time').textContent = `打包于 ${__BUILD_TIME__}`;
  $('#server-info').textContent = state.serverName ? `${state.serverName} · ${shortServer(state.wsUrl)}` : shortServer(state.wsUrl);
  renderPersona();
  applyCfgUI();
  applyRunner();
  renderActions();
  $('#input').focus();
}

/* ---------------- 网络 ---------------- */
function connect(first = false) {
  return new Promise((resolve, reject) => {
    setStatus('Connecting…', 'wait');
    let done = false;
    const ws = new WebSocket(state.wsUrl);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;
    const timeout = setTimeout(() => {
      if (!done) { done = true; reject(new Error('连接超时，请检查服务器地址')); ws.close(); }
    }, 6000);

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) { onChunk(new Uint8Array(ev.data)); return; }
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.type) {
        case 'welcome':
          state.serverName = typeof m.name === 'string' ? m.name.slice(0, 40) : '';
          state.serverMedia = Array.isArray(m.features) && m.features.includes('media');
          state.serverDirect = Array.isArray(m.features) && m.features.includes('direct');
          state.serverActions = (Array.isArray(m.actions) ? m.actions : []).map(sanitizeAction).filter(Boolean).slice(0, 50);
          if (state.entered) renderActions();
          ws.send(JSON.stringify({ type: 'join', room: state.session.roomId }));
          break;
        case 'joined':
          state.myId = m.id; state.retry = 0;
          markAllOffline(); // 自己重连：等其他人回 hi 再恢复在线；私聊记录保留
          updateCount(m.count);
          send({ t: 'hello', caps: CAPS, v: APP_VERSION });
          // 重连后几秒内没回来的人，之后再进来要正常提示 connected
          setTimeout(() => { for (const p of state.members.values()) p.quiet = false; }, 5000);
          if (!done) { done = true; clearTimeout(timeout); resolve(); }
          break;
        case 'join':
          updateCount(m.count);
          break;
        case 'leave': {
          updateCount(m.count);
          const p = state.members.get(state.conns.get(m.id));
          state.conns.delete(m.id);
          if (p && p.conn === m.id) memberGone(p);
          break;
        }
        case 'relay': {
          const inner = open(state.session, m.data);
          if (inner) onInner(m.from, inner);
          break;
        }
      }
    };
    ws.onclose = () => {
      clearTimeout(timeout);
      if (!done) { done = true; reject(new Error('无法连接服务器')); }
      if (state.ws !== ws || !state.session || (first && !state.entered)) return;
      setStatus('Reconnecting…', 'off');
      markAllOffline();
      const delay = Math.min(8000, 500 * 2 ** state.retry++);
      setTimeout(() => { if (state.session && state.ws === ws) connect().catch(() => {}); }, delay);
    };
  });
}

/** 发送加密消息。to = 目标连接 ID（只发给这个人），不填则发给房间里所有人 */
function send(obj, to) {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const inner = { name: state.name, cid: state.cid, ...obj };
  ws.send(JSON.stringify({ type: 'relay', data: seal(state.session, inner), ...(to ? { to } : {}) }));
  return true;
}

/**
 * 发到某个会话：群聊发给所有人；私聊只发给对方，并在密文里标明收件人。
 * 私聊和群聊用同一个房间口令加密（持有口令即可审核），隔离靠服务器定向转发。
 */
function sendTo(conv, obj) {
  if (conv === GROUP) return send(obj);
  const p = convPeer(conv);
  if (!p?.online || !p.conn) return false;
  return send({ ...obj, dm: p.cid }, p.conn);
}

/** 回执只发给原消息的发送者 */
function replyTo(it, obj) {
  const p = state.members.get(it.cid);
  if (!p?.online || !p.conn) return;
  send(it.conv === GROUP ? obj : { ...obj, dm: p.cid }, p.conn);
}

/** 自己断线：所有人暂时显示离线。quiet = 重连后他们回来时不再逐个提示 connected */
function markAllOffline() {
  for (const p of state.members.values()) {
    if (p.online) p.quiet = true;
    p.online = false;
    p.conn = null;
  }
  state.conns.clear();
  if (state.entered) { renderRecents(); renderHeader(); }
}

/** 有人离开：更新侧栏；我发出的消息不再等他的已读回执 */
function memberGone(p) {
  p.online = false;
  p.conn = null;
  sys(`MCP server ${whoHTML(p, 'who')} disconnected`);
  if (threadEl(dmConv(p.cid))) sys(`MCP server ${whoHTML(p, 'who')} disconnected`, dmConv(p.cid));
  for (const it of state.items) {
    if (!it.mine || !it.need?.has(p.cid)) continue;
    if (it.kind === 'media' ? !it.viewBy.has(p.cid) : !it.readBy.has(p.cid)) { it.need.delete(p.cid); progress(it); }
  }
  refreshLabels();
}

// 双方版本不一致时提示一次（旧版客户端不发送版本号）
function checkPeerVersion(p, m) {
  const v = typeof m.v === 'string' && /^\d+\.\d+\.\d+$/.test(m.v) ? m.v : null;
  p.v = v;
  p.caps = Array.isArray(m.caps) ? m.caps.filter((c) => typeof c === 'string').slice(0, 10) : [];
  if (v === APP_VERSION || p.warned) return;
  p.warned = true;
  const dm = hasCap(p, 'dm') ? '' : ' · 不支持私聊';
  sys(`MCP server ${whoHTML(p, 'who')} 版本 ${v ? 'v' + v : '较旧'}，你是 v${APP_VERSION}${dm} · 建议大家使用同一版本`);
}

function fresh(m) {
  if (typeof m.id !== 'string' || state.seen.has(m.id)) return false;
  if (typeof m.ts !== 'number' || Math.abs(Date.now() - m.ts) > MAX_SKEW) return false;
  state.seen.add(m.id);
  return true;
}

function onInner(from, m) {
  // 私聊消息带收件人 cid；不是发给我的直接丢弃
  if (m.dm !== undefined && m.dm !== state.cid) return;
  const { p, isNew, back } = bindMember(from, m);
  const conv = m.dm ? dmConv(p.cid) : GROUP;
  switch (m.t) {
    case 'hello': // 新人进来：回 hi 并同步设置
    case 'hi':
      checkPeerVersion(p, m);
      if (m.t === 'hello') send({ t: 'hi', cfg: state.cfg, caps: CAPS, v: APP_VERSION }, from);
      else if (!state.cfgTouched && m.cfg) { setCfg(m.cfg, false); state.cfgTouched = true; }
      if ((isNew || back) && !p.quiet) {
        sys(`MCP server ${whoHTML(p, 'who')} connected`);
        if (back && threadEl(dmConv(p.cid))) sys(`MCP server ${whoHTML(p, 'who')} connected`, dmConv(p.cid));
      }
      p.quiet = false;
      refreshLabels();
      break;
    case 'cfg':
      if (conv !== GROUP) return;
      setCfg(m, false);
      sys(`Settings updated by ${whoHTML(p, 'who')} · retain ${state.cfg.keep} · auto-clear ${state.cfg.ttl ? state.cfg.ttl + 's' : 'off'} · media ${state.cfg.mview}s`);
      break;
    case 'msg':
      if (typeof m.text !== 'string' || !fresh(m)) return;
      addItem({ id: m.id, conv, kind: 'msg', mine: false, cid: p.cid, text: m.text.slice(0, 4000) });
      break;
    case 'action': {
      const a = sanitizeAction(m);
      if (!a || !fresh(m)) return;
      addItem({ id: m.id, conv, kind: 'action', mine: false, cid: p.cid, action: a, all: conv === GROUP && m.all === true });
      native.attention();
      break;
    }
    case 'read': // 已读回执
      if (!Array.isArray(m.ids)) return;
      for (const id of m.ids.slice(0, 100)) {
        const it = state.items.find((i) => i.id === id && i.mine && i.conv === conv && i.kind !== 'media');
        if (!it || it.read) continue;
        if (it.need) { it.readBy.add(p.cid); progress(it); } else markRead(it);
      }
      break;
    case 'media':
      onMediaMeta(m, p, conv);
      break;
    case 'mrecv':
    case 'mview': {
      const it = state.items.find((i) => i.id === m.id && i.kind === 'media' && i.mine && i.conv === conv);
      if (!it) return;
      (m.t === 'mrecv' ? it.recvBy : it.viewBy).add(p.cid);
      if (m.t === 'mview') it.recvBy.add(p.cid);
      progress(it);
      break;
    }
    case 'debug':
      if (DEBUG_MEDIA) console.log('[debug]', m);
      break;
    case 'burn':
      burnConv(conv);
      break;
  }
}

/**
 * 我发出的消息 / 附件的送达进度：need = 发送时在线的接收者
 *   消息：所有人都读完才算已读（之后才参与焚毁）
 *   附件：所有人都看过后，5 秒后焚毁发送方的缩略图
 */
/** 发送时在线的接收者（附件只算能收附件的客户端） */
function recipients(conv, cap) {
  const peer = convPeer(conv);
  const list = peer ? [peer] : onlineMembers().filter((p) => !cap || hasCap(p, cap));
  const need = new Set(list.map((p) => p.cid));
  return { need, total: need.size, readBy: new Set() };
}

function progress(it) {
  if (!it.el) return;
  const total = it.need.size;
  if (it.kind === 'media') {
    if (it.status === 'viewed' || it.status === 'sending' || it.status === 'failed') return;
    const viewed = [...it.need].every((c) => it.viewBy.has(c));
    if (it.viewBy.size && viewed) { setMediaStatus(it, 'viewed'); setTimeout(() => burn(it), 5000); }
    else if (it.viewBy.size) setMediaStatus(it, 'partview');
    else if (it.recvBy.size) setMediaStatus(it, 'delivered');
    return;
  }
  const rc = it.el.querySelector('.rc');
  const done = it.readBy.size > 0 && [...it.need].every((c) => it.readBy.has(c));
  if (rc) rc.textContent = done ? 'Read' : `Read ${Math.min(it.readBy.size, it.total)}/${it.total}`;
  if (done) markRead(it);
}

function setStatus(text, kind) {
  $('#status').textContent = text;
  $('#dot').className = kind;
}
function updateCount(n) {
  state.online = n;
  setStatus(n > 1 ? `Connected · ${n} online` : 'Connected · waiting for peer', 'on');
}

/* ================================================================
 *  消息 / 已读 / 焚毁（每个会话各自计算）
 *   - 收到的消息：正在看这个会话、窗口在前台、且停留够阅读时长后才算「已读」
 *   - 自己发的消息：发送时在线的人都发回已读回执后才算「已读」
 *   - 只有已读消息参与「保留 N 条」和倒计时焚毁；未读消息不会被焚毁
 * ================================================================ */
function addItem(it) {
  Object.assign(it, { seen: it.mine, read: false, readMs: 0, timer: null });
  it.dwell = it.kind === 'msg' ? Math.min(8000, 1500 + it.text.length * 60) : 600;

  const el = document.createElement('div');
  el.dataset.id = it.id;
  const sender = it.mine ? null : state.members.get(it.cid);
  if (it.kind === 'media') {
    el.className = `item media ${it.mine ? 'mine' : 'theirs'}`;
    el.innerHTML = mediaHTML(it, sender);
  } else if (it.kind === 'action') {
    el.className = 'item act-item';
    el.innerHTML = it.mine
      ? `<span class="act-ico">⌁</span><span><b>你</b>${esc(actionText(it.action, it.target))}</span>`
      : `<span class="act-ico">⌁</span><span>${whoHTML(sender, 'who')}${esc(actionText(it.action, it.all ? '大家' : '你'))}</span>`;
  } else if (it.mine) {
    el.className = 'item msg user';
    // 群聊里有两人以上接收时显示「Read 1/2」
    el.innerHTML = `<div class="bubble">${format(it.text)}</div>${it.total > 1 ? `<div class="rc">Read 0/${it.total}</div>` : ''}`;
  } else {
    const n = hashNum(it.id);
    el.className = 'item msg agent unread';
    el.innerHTML = `<div class="agent-head">${mark}<span class="tool">${esc(toolLine(n))} <i>›</i></span>${whoHTML(sender)}</div>
      <div class="prose">${format(it.text)}</div>`;
  }
  it.el = el;
  threadOf(it.conv).appendChild(el);
  state.items.push(it);
  if (it.kind === 'media') setMediaStatus(it, it.status, 0);
  enforceKeep();
  updateUnread(!it.mine);
  if (it.conv === state.active) scrollDown();
  if (isDm(it.conv) && !document.querySelector(`#recents li[data-conv="${it.conv}"]`)) renderRecents();
  return it;
}

const isReading = () => state.entered && !state.boss && document.visibilityState === 'visible' && document.hasFocus();

// 阅读计时：只在用户真正看着窗口时推进
setInterval(() => {
  if (!isReading()) return;
  let changed = false;
  for (const it of [...state.items]) {
    if (it.conv !== state.active) continue;
    if (!it.seen) {
      it.seen = true; changed = true;
      if (it.kind === 'action') nudge();
    }
    if (!it.mine && !it.read && it.kind !== 'media') {
      it.readMs += TICK;
      if (it.readMs >= it.dwell) markRead(it);
    }
  }
  flushReceipts();
  if (changed) updateUnread(false);
}, TICK);

function markRead(it) {
  if (it.read) return;
  it.read = true;
  it.el?.classList.remove('unread');
  if (!it.mine && it.kind === 'msg') {
    if (!state.receipts.has(it.conv)) state.receipts.set(it.conv, []);
    state.receipts.get(it.conv).push(it.id);
  }
  startTtl(it);
  enforceKeep();
}

function flushReceipts() {
  for (const [conv, ids] of state.receipts) {
    if (ids.length) sendTo(conv, { t: 'read', ids: ids.splice(0, 100) });
    if (!ids.length) state.receipts.delete(conv);
  }
}

/**
 * 「保留 N 轮」：同一个人连续发的消息算一轮，换人说话才算新的一轮。
 * 每个会话只保留最近 N 轮；更早的轮次里，已读的消息焚毁，未读的继续保留。
 * 例：N = 1 时 A 连发 5 条会全部留着，等 B 回复后 A 那一轮读完的消息才焚毁。
 */
function enforceKeep() {
  const byConv = new Map();
  for (const i of state.items) if (i.kind === 'msg') byConv.set(i.conv, [...(byConv.get(i.conv) || []), i]);
  for (const msgs of byConv.values()) {
    let turn = 0, prev;
    for (let k = msgs.length - 1; k >= 0; k--) {
      const m = msgs[k];
      const who = m.mine ? '' : m.cid;
      if (who !== prev) { turn++; prev = who; }
      if (turn > state.cfg.keep && m.read) burn(m);
    }
  }
}

function startTtl(it) {
  const ttl = it.kind === 'action' ? ACTION_TTL : state.cfg.ttl;
  if (!ttl || it.timer || !it.el) return;
  it.timer = setTimeout(() => burn(it), ttl * 1000);
  if (it.kind === 'msg') {
    const bar = document.createElement('div');
    bar.className = 'ttl';
    bar.innerHTML = `<i style="animation-duration:${ttl}s"></i>`;
    it.el.appendChild(bar);
  }
}
function resetTimers() {
  for (const it of state.items) {
    if (it.kind !== 'msg') continue;
    clearTimeout(it.timer); it.timer = null;
    it.el?.querySelector('.ttl')?.remove();
    if (it.read) startTtl(it);
  }
}

function burn(it) {
  const i = state.items.indexOf(it);
  if (i < 0) return;
  state.items.splice(i, 1);
  clearTimeout(it.timer);
  if (it.kind === 'media') cleanupMedia(it);
  it.text = null; it.action = null;
  const el = it.el;
  it.el = null;
  el.style.height = el.offsetHeight + 'px';
  el.classList.add('burning');
  setTimeout(() => el.remove(), 650);
  if (!state.compacted.has(it.conv) && it.kind === 'msg') {
    state.compacted.add(it.conv);
    const c = document.createElement('div');
    c.className = 'compact';
    c.textContent = 'Earlier context compacted';
    threadOf(it.conv).prepend(c);
  }
  updateUnread(false);
  // 离线成员的私聊焚毁完了，侧栏里就不再显示
  if (isDm(it.conv) && !convPeer(it.conv)?.online && !convItems(it.conv).length) renderRecents();
}
function burnAll() { [...state.items].forEach(burn); }
function burnConv(conv) { convItems(conv).forEach(burn); }

function nudge() {
  const chat = $('#chat');
  chat.classList.remove('nudge');
  void chat.offsetWidth;
  chat.classList.add('nudge');
}

/* ---------------- 未读角标 / 通知 ---------------- */
function updateUnread(arrived) {
  const unseen = state.items.filter((i) => !i.mine && !i.seen);
  const count = unseen.length;
  updateBadges(unseen);
  if (count !== state.unread) {
    state.unread = count;
    native.setUnread(count);
    if (!native.inTauri) document.title = count ? `(${count}) Agent` : 'Agent';
  }
  if (arrived && count > 0 && prefs.notify && !isReading() && Date.now() - state.lastNotify > 8000) {
    state.lastNotify = Date.now();
    const last = state.items.at(-1);
    // 只给通用提示，不暴露内容和发送者
    native.notify('Agent', last?.kind === 'action' ? '你有一条新的动态' : '任务有新的进展，点击查看');
  }
}

function sys(html, conv = GROUP) {
  const el = document.createElement('div');
  el.className = 'sys';
  el.innerHTML = `<span>⏺</span> ${html}`;
  threadOf(conv).appendChild(el);
  if (conv === state.active) scrollDown();
  setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 500); }, 8000);
}

/* ================================================================
 *  动作（拍一拍）
 * ================================================================ */
function renderActions() {
  const chips = [
    ...state.serverActions.map((a, i) => ({ a, src: 'server', i })),
    ...prefs.customActions.map((a, i) => ({ a: sanitizeAction(a), src: 'custom', i })).filter((c) => c.a),
  ];
  $('#act-list').innerHTML = chips.length
    ? chips.map(({ a, src, i }) => `<button type="button" class="act-chip ${src}" data-src="${src}" data-i="${i}">${esc(actionText(a, '对方'))}${src === 'custom' ? '<span class="del" title="删除">×</span>' : ''}</button>`).join('')
    : '<span class="muted small">服务器没有预制动作，可以在下面自定义</span>';
}

$('#act-list').onclick = (e) => {
  const chip = e.target.closest('.act-chip');
  if (!chip) return;
  const i = Number(chip.dataset.i);
  if (e.target.classList.contains('del')) {
    prefs.customActions.splice(i, 1); savePrefs(); renderActions();
    return;
  }
  const a = chip.dataset.src === 'server' ? state.serverActions[i] : sanitizeAction(prefs.customActions[i]);
  if (a && sendAction(a)) pops.actions.hidden = true;
};

const customAction = () => sanitizeAction({ prefix: $('#act-prefix').value, suffix: $('#act-suffix').value });
function updateActPreview() {
  const p = $('#act-prefix').value.trim(), s = $('#act-suffix').value.trim();
  const len = p.length + s.length;
  $('#act-count').textContent = `${len}/${MAX_ACTION_LEN}`;
  $('#act-count').classList.toggle('over', len > MAX_ACTION_LEN);
  const { who, all } = actionTarget();
  $('#act-preview').textContent = `${who}会看到：${p ? state.name + actionText({ prefix: p, suffix: s }, all ? '大家' : '你') : '…'}`;
}
/** 动作发给谁：私聊是对方；群聊里有两人以上在线时是「大家」 */
function actionTarget() {
  const peer = convPeer(state.active);
  if (peer) return { who: labelOf(peer).text, all: false, peer };
  const all = onlineMembers().length >= 2;
  return { who: all ? '大家' : '对方', all };
}
$('#act-prefix').addEventListener('input', updateActPreview);
$('#act-suffix').addEventListener('input', updateActPreview);
$('#act-send').onclick = () => {
  const a = customAction();
  if (!a) return toast($('#act-prefix').value.trim() ? `最多 ${MAX_ACTION_LEN} 字` : '先填写动作，比如「拍了拍」');
  if (sendAction(a)) { $('#act-prefix').value = ''; $('#act-suffix').value = ''; updateActPreview(); pops.actions.hidden = true; }
};
$('#act-save').onclick = () => {
  const a = customAction();
  if (!a) return toast('先填写动作');
  if (!prefs.customActions.some((c) => c.prefix === a.prefix && c.suffix === a.suffix)) {
    prefs.customActions.push(a); prefs.customActions = prefs.customActions.slice(-30); savePrefs(); renderActions();
  }
  toast('已保存到常用动作');
};
[$('#act-prefix'), $('#act-suffix')].forEach((el) => el.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); $('#act-send').click(); }
}));

function sendAction(a) {
  if (state.boss) { toast('Agent is busy — try again in a moment'); return false; }
  if (Date.now() - state.lastAction < 1500) { toast('慢一点～'); return false; }
  const conv = state.active;
  const { who, all, peer } = actionTarget();
  if (peer && !peer.online) { toast(`${who} 已离线`); return false; }
  const m = { t: 'action', id: randomId(), ts: Date.now(), ...a, ...(all ? { all } : {}) };
  if (!sendTo(conv, m)) { toast('Not connected'); return false; }
  state.lastAction = Date.now();
  state.seen.add(m.id);
  addItem({ id: m.id, conv, kind: 'action', mine: true, action: a, target: who });
  markRead(state.items.at(-1));
  return true;
}

/* ================================================================
 *  设置
 * ================================================================ */
function setCfg(c, broadcast) {
  const keep = Math.max(1, Math.min(50, Number(c.keep) | 0 || 1));
  const ttl = [0, 10, 30, 60, 300].includes(Number(c.ttl)) ? Number(c.ttl) : state.cfg.ttl;
  const mview = MEDIA_VIEW_OPTS.includes(Number(c.mview)) ? Number(c.mview) : state.cfg.mview;
  const ttlChanged = ttl !== state.cfg.ttl;
  state.cfg = { keep, ttl, mview };
  applyCfgUI();
  enforceKeep();
  if (ttlChanged) resetTimers();
  if (broadcast) { state.cfgTouched = true; send({ t: 'cfg', name: state.name, ...state.cfg }); }
}
function applyCfgUI() {
  $('#keep-val').textContent = state.cfg.keep;
  $('#ttl').value = String(state.cfg.ttl);
  $('#mview').value = String(state.cfg.mview);
  $('#ctx-chip').textContent = `Context ${state.cfg.keep}${state.cfg.ttl ? ' · ' + state.cfg.ttl + 's' : ''}`;
}
function applyRunner() {
  $('#runner-wrap').hidden = !prefs.runner;
  if (prefs.runner && state.entered) runner.start(); else runner.stop();
}

document.querySelectorAll('[data-step]').forEach((b) =>
  (b.onclick = () => setCfg({ ...state.cfg, keep: state.cfg.keep + Number(b.dataset.step) }, true)));
$('#ttl').onchange = (e) => setCfg({ ...state.cfg, ttl: e.target.value }, true);
$('#mview').onchange = (e) => setCfg({ ...state.cfg, mview: e.target.value }, true);

const bindToggle = (sel, key, after) => {
  const el = $(sel);
  el.checked = prefs[key];
  el.onchange = () => { prefs[key] = el.checked; savePrefs(); after?.(); };
};
bindToggle('#blur-hide', 'blurHide');
bindToggle('#notify-toggle', 'notify', () => prefs.notify && native.ensureNotifyPermission());
bindToggle('#runner-toggle', 'runner', applyRunner);
bindToggle('#protect-toggle', 'protect', () => native.setContentProtected(prefs.protect));
if (!native.inTauri) $('#protect-row').hidden = true;
if (prefs.protect) native.setContentProtected(true);

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelectorAll('#theme-seg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === t));
}
document.querySelectorAll('#theme-seg button').forEach((b) => (b.onclick = () => { setTheme(b.dataset.theme); prefs.theme = b.dataset.theme; savePrefs(); }));
setTheme(prefs.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'warm'));
if (native.inTauri) document.body.classList.add('tauri');

/* ---------------- 弹层 ---------------- */
const pops = { settings: $('#settings'), actions: $('#actions-pop') };
function togglePop(name) {
  for (const [k, el] of Object.entries(pops)) el.hidden = k === name ? !el.hidden : true;
  if (name === 'actions' && !pops.actions.hidden) { updateActPreview(); $('#act-prefix').focus(); }
}
$('#settings-btn').onclick = () => togglePop('settings');
$('#act-btn').onclick = () => togglePop('actions');
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('#settings-btn,#act-btn')) return;
  for (const el of Object.values(pops)) if (!el.hidden && !el.contains(e.target)) el.hidden = true;
});
const anyPopOpen = () => Object.values(pops).some((el) => !el.hidden);
const closePops = () => Object.values(pops).forEach((el) => (el.hidden = true));

$('#share-btn').onclick = async () => {
  const addr = shortServer(state.wsUrl);
  toast((await copyText(addr)) ? `已复制服务器地址 ${addr}（口令请单独告诉对方）` : addr);
};
// 清空当前会话（双方一起）
const clearConv = () => { burnConv(state.active); sendTo(state.active, { t: 'burn' }); };
$('#clear-btn').onclick = () => { clearConv(); closePops(); };
$('#leave-btn').onclick = leave;

function leave() {
  const ws = state.ws;
  burnAll();
  Object.assign(state, {
    session: null, ws: null, entered: false, cfgTouched: false, active: GROUP,
    cfg: { keep: 1, ttl: 0, mview: 10 }, items: [],
  });
  for (const k of ['members', 'conns', 'seen', 'incoming', 'receipts', 'compacted']) state[k].clear();
  native.mediaClear();
  ws?.close();
  runner.stop();
  native.setUnread(0); state.unread = 0;
  $('#threads').innerHTML = '';
  closePops();
  setBoss(false);
  $('#main').hidden = true;
  $('#join').hidden = false;
  $('#pass').focus();
  fillSavedKey();
}

/* ---------------- 输入 ---------------- */
const input = $('#input');
const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; };
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

$('#composer').onsubmit = (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  if (state.boss) { toast('Agent is busy — try again in a moment'); return; }
  if (text.startsWith('/') && command(text)) { input.value = ''; autosize(); return; }
  const conv = state.active;
  const peer = convPeer(conv);
  if (peer && !peer.online) { toast(`${labelOf(peer).text} 已离线，回来后才能收到`); return; }
  const msg = { t: 'msg', id: randomId(), text, ts: Date.now() };
  if (!sendTo(conv, msg)) { toast('Not connected'); return; }
  state.seen.add(msg.id);
  addItem({ id: msg.id, conv, kind: 'msg', mine: true, text, ...recipients(conv) });
  input.value = ''; autosize();
};

function command(text) {
  const [cmd, arg] = text.split(/\s+/);
  switch (cmd) {
    case '/clear': clearConv(); return true;
    case '/keep': setCfg({ ...state.cfg, keep: arg }, true); return true;
    case '/ttl': setCfg({ ...state.cfg, ttl: arg }, true); return true;
    case '/leave': leave(); return true;
    case '/hide': setBoss(true); return true;
  }
  return false;
}

/* ================================================================
 *  伪装（老板键）
 * ================================================================ */
function setBoss(on) {
  state.boss = on;
  $('#threads').hidden = on;
  $('#decoy').hidden = !on;
  const target = on ? $('#recents li.fake') : [...$('#recents').children].find((li) => li.dataset.conv === state.active);
  document.querySelectorAll('#recents li').forEach((li) => li.classList.toggle('active', li === target));
  if (target) $('#title').textContent = target.querySelector('.r-name')?.textContent || target.textContent;
  renderHeader();
  if (on) closePops();
  scrollDown();
}

/** 切换会话：群聊 / 和某人的私聊 */
function switchConv(conv) {
  if (conv !== GROUP && !convPeer(conv)) conv = GROUP;
  state.active = conv;
  threadOf(conv);
  for (const t of $('#threads').children) t.hidden = t.dataset.conv !== conv;
  setBoss(false);
  if (!pops.actions.hidden) updateActPreview();
  $('#input').focus();
}

document.addEventListener('keydown', (e) => {
  if ($('#main').hidden || e.key !== 'Escape') return;
  if (anyPopOpen()) { closePops(); return; }
  setBoss(!state.boss);
});
$('#recents').onclick = (e) => {
  const li = e.target.closest('li');
  if (!li || li.classList.contains('editing')) return;
  if (e.target.closest('.r-edit')) { renameRecent(li); return; }
  if (li.dataset.conv) switchConv(li.dataset.conv);
  else setBoss(true);
};
$('#recents').ondblclick = (e) => { if (!e.target.closest('input')) renameRecent(e.target.closest('li')); };
$('#new-task').onclick = () => setBoss(true);
$('#collapse').onclick = () => document.body.classList.add('side-collapsed');
$('#expand').onclick = () => document.body.classList.remove('side-collapsed');
window.addEventListener('blur', () => { if (prefs.blurHide && state.entered) setBoss(true); });
document.addEventListener('visibilitychange', () => { if (document.hidden && prefs.blurHide && state.entered) setBoss(true); });
window.addEventListener('pagehide', () => { burnAll(); native.mediaClear(); state.session = null; });

/* ================================================================
 *  附件（图片 / 视频）
 *   - 发送：本地预处理 → 元数据走加密文本帧 → 内容按 64KB 分块，每块单独加密走二进制帧
 *   - 接收：分块保持加密存在内存里；点「查看」才解密
 *   - 图片画在 canvas 上（没有可被缓存/另存的 URL）；视频/GIF 交给 Rust 内存保险箱播放
 *   - 图片查看 N 秒后焚毁；视频播放结束 N 秒后焚毁；焚毁时清零所有缓冲
 * ================================================================ */
const DIRECT_FRAME = 0x02; // 定向二进制帧：[0x02][目标连接 ID 6B][分块]
const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
const THUMB_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
const EYE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const PLAY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';

function mediaHTML(it, sender) {
  const label = `${it.mtype === 'image' ? 'image' : 'video'} · ${fmtSize(it.size)}${it.dur ? ' · ' + fmtDur(it.dur) : ''}`;
  const ar = Math.min(2, Math.max(0.6, it.w / it.h || 1.5)).toFixed(3);
  const head = it.mine
    ? ''
    : `<div class="agent-head">${mark}<span class="tool">Attached ${label} <i>›</i></span>${whoHTML(sender)}</div>`;
  return `${head}
    <div class="m-box" style="aspect-ratio:${ar}">
      ${it.thumb ? `<img class="m-thumb" src="${esc(it.thumb)}" draggable="false" alt="">` : '<div class="m-thumb m-noise"></div>'}
      <div class="m-over"></div>
      <div class="m-ttl"><i></i></div>
    </div>
    ${it.mine ? `<div class="m-meta">${label}</div>` : ''}`;
}

function setMediaStatus(it, status, pct = 0) {
  it.status = status;
  const over = it.el?.querySelector('.m-over');
  if (!over) return;
  const pill = (html, cls = '') => `<div class="m-pill ${cls}">${html}</div>`;
  const N = state.cfg.mview;
  const many = it.mine && it.total > 1; // 群聊多人接收时显示进度
  const views = {
    receiving: pill(`<span class="spin"></span>Receiving ${pct}%`),
    sending: pill(`<span class="spin"></span>Encrypting & sending ${pct}%`),
    ready: `<button type="button" class="m-view">${it.mtype === 'video' ? PLAY : EYE}<span>${it.mtype === 'video' ? `Play · 结束后 ${N}s 焚毁` : `View · ${N}s`}</span></button>`,
    opening: pill('<span class="spin"></span>Decrypting…'),
    viewing: '',
    sent: pill('Sent'),
    delivered: pill(many ? `Delivered ${it.recvBy?.size ?? 0}/${it.total} · 等待查看` : 'Delivered · 等待对方查看'),
    partview: pill(`Viewed ${it.viewBy?.size ?? 0}/${it.total}`),
    viewed: pill(many ? 'Viewed · 所有人都已查看' : 'Viewed · 对方已查看', 'ok'),
    undelivered: pill('对方未接收 · 可能需要更新客户端', 'bad'),
    failed: pill('Transfer failed', 'bad'),
  };
  over.innerHTML = views[status] ?? '';
}

const inflightBytes = () => state.items.reduce((n, i) => n + (i.kind === 'media' && !i.mine && i.frames ? i.size : 0), 0);

function onMediaMeta(m, p, conv) {
  const mtype = m.mtype;
  if (mtype !== 'image' && mtype !== 'video') return;
  if (!(mtype === 'image' ? IMAGE_MIME : VIDEO_MIME).includes(m.mime)) return;
  const limit = mtype === 'image' ? MAX_IMAGE_RAW : MAX_VIDEO;
  if (!Number.isInteger(m.size) || m.size <= 0 || m.size > limit) return;
  if (m.chunks !== Math.ceil(m.size / CHUNK)) return;
  if (!fresh(m)) return;
  if (inflightBytes() + m.size > MAX_INFLIGHT) { sys('Attachment skipped · memory limit'); return; }
  const it = addItem({
    id: m.id, conv, kind: 'media', mine: false, cid: p.cid,
    mtype, mime: m.mime, size: m.size, chunks: m.chunks,
    w: Math.max(1, Math.min(10000, m.w | 0 || 16)), h: Math.max(1, Math.min(10000, m.h | 0 || 9)),
    dur: Math.max(0, Math.min(36000, Number(m.dur) || 0)),
    thumb: typeof m.thumb === 'string' && m.thumb.length < 16000 && THUMB_RE.test(m.thumb) ? m.thumb : '',
    status: 'receiving', frames: new Array(m.chunks), got: 0, lastAt: Date.now(),
  });
  state.incoming.set(m.id, it);
}

function onChunk(frame) {
  const h = chunkHeader(frame);
  if (!h || frame.length > CHUNK + 13 + 24 + 16) return;
  const it = state.incoming.get(h.id);
  if (!it || h.index >= it.chunks || it.frames[h.index]) return;
  it.frames[h.index] = frame; // 保持加密状态，点查看前不解密
  it.got++;
  it.lastAt = Date.now();
  if (it.got === it.chunks) {
    state.incoming.delete(h.id);
    setMediaStatus(it, 'ready');
    replyTo(it, { t: 'mrecv', id: it.id });
    if (DEBUG_MEDIA) viewMedia(it);
  } else if (it.got % 8 === 0) {
    setMediaStatus(it, 'receiving', Math.floor((it.got / it.chunks) * 100));
  }
}

// 传输超时：45 秒没有新分块就判定失败并释放内存
setInterval(() => {
  for (const it of state.incoming.values()) {
    if (Date.now() - it.lastAt > 45000) {
      state.incoming.delete(it.id);
      it.frames?.forEach((f) => f?.fill(0));
      it.frames = null;
      setMediaStatus(it, 'failed');
      setTimeout(() => burn(it), 8000);
    }
  }
}, 5000);

async function sendFiles(files) {
  for (const f of [...files].slice(0, 5)) await sendMedia(f);
}

async function sendMedia(file) {
  if (state.boss) return toast('Agent is busy — try again in a moment');
  if (!state.serverMedia) return toast('服务器版本过旧，不支持附件，请更新 server 目录');
  const conv = state.active;
  const peer = convPeer(conv);
  if (peer) {
    const who = labelOf(peer).text;
    if (!peer.online) return toast(`${who} 已离线 · 附件需要对方在线才能接收`);
    if (!hasCap(peer, 'media')) return toast(`${who} 的客户端版本过旧，收不到图片 / 视频，请先更新 Agent.app`);
    if (!state.serverDirect) return toast('服务器版本过旧，私聊不能发图片 / 视频，请更新 server 目录后重启服务器');
  } else {
    const others = onlineMembers();
    if (!others.length) return toast('其他人都不在线 · 附件需要对方在线才能接收');
    const old = others.filter((p) => !hasCap(p, 'media')).map((p) => labelOf(p).text);
    if (old.length === others.length) return toast(`${old.join('、')} 的客户端版本过旧，收不到图片 / 视频，请先更新 Agent.app`);
    if (old.length) toast(`${old.join('、')} 的客户端版本过旧，将收不到这个附件`);
  }
  let prep;
  try { prep = await prepareFile(file); } catch (e) { return toast(e.message); }
  const { bytes } = prep;
  const ws = state.ws;
  const id = randomId();
  const total = Math.max(1, Math.ceil(bytes.length / CHUNK));
  const meta = {
    t: 'media', id, ts: Date.now(), mtype: prep.kind, mime: prep.mime,
    size: bytes.length, chunks: total, w: prep.w, h: prep.h, dur: Math.round(prep.dur || 0), thumb: prep.thumb,
  };
  // 私聊：分块前加上目标连接 ID，服务器只转发给对方
  const conn = peer?.conn;
  const route = conn ? hexToBytes(conn) : null;
  if (!sendTo(conv, meta)) { bytes.fill(0); return toast('Not connected'); }
  state.seen.add(id);
  const it = addItem({
    id, conv, kind: 'media', mine: true, ...meta, status: 'sending',
    ...recipients(conv, 'media'), recvBy: new Set(), viewBy: new Set(),
  });
  try {
    for (let i = 0; i < total; i++) {
      if (state.ws !== ws || ws.readyState !== WebSocket.OPEN) throw new Error('disconnected');
      if (peer && peer.conn !== conn) throw new Error('peer reconnected');
      while (ws.bufferedAmount > 4 * 1024 * 1024) {
        await sleep(10);
        if (ws.readyState !== WebSocket.OPEN) throw new Error('disconnected');
      }
      const frame = sealChunk(state.session, id, i, total, bytes.subarray(i * CHUNK, (i + 1) * CHUNK));
      if (route) {
        const wrapped = new Uint8Array(1 + route.length + frame.length);
        wrapped[0] = DIRECT_FRAME;
        wrapped.set(route, 1);
        wrapped.set(frame, 1 + route.length);
        ws.send(wrapped);
      } else ws.send(frame);
      if (i % 8 === 7) { setMediaStatus(it, 'sending', Math.floor(((i + 1) / total) * 100)); await sleep(0); }
    }
    if (it.status === 'sending') {
      setMediaStatus(it, 'sent');
      progress(it); // 发送过程中可能已经收到回执
      // 一直收不到「已接收」回执：多半是对方客户端太旧或对方断线
      setTimeout(() => { if (it.status === 'sent' && it.el) setMediaStatus(it, 'undelivered'); }, 20000);
    }
  } catch {
    setMediaStatus(it, 'failed');
  } finally {
    bytes.fill(0); // 发送方也不保留副本
  }
}

async function viewMedia(it) {
  if (it.status !== 'ready' || !it.frames) return;
  setMediaStatus(it, 'opening');
  const plain = new Uint8Array(it.size);
  let off = 0;
  for (let i = 0; i < it.chunks; i++) {
    const pt = openChunk(state.session, it.frames[i], it.chunks);
    it.frames[i] = null;
    if (!pt || off + pt.length > it.size) { plain.fill(0); it.frames = null; setMediaStatus(it, 'failed'); return; }
    plain.set(pt, off);
    off += pt.length;
    pt.fill(0);
    if (i % 64 === 63) await sleep(0);
  }
  it.frames = null;
  if (off !== it.size || !it.el) { plain.fill(0); setMediaStatus(it, 'failed'); return; }
  replyTo(it, { t: 'mview', id: it.id });

  const box = it.el.querySelector('.m-box');
  const N = state.cfg.mview;
  try {
    if (it.mime === 'image/jpeg' || it.mime === 'image/png' || it.mime === 'image/webp') {
      const bmp = await createImageBitmap(new Blob([plain], { type: it.mime }));
      plain.fill(0);
      if (!it.el) { bmp.close(); return; }
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      c.className = 'm-media';
      c.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close();
      it.canvas = c;
      box.appendChild(c);
      countdown(it, N);
      if (DEBUG_MEDIA) send({ t: 'debug', ev: 'image-drawn', w: c.width, h: c.height });
    } else {
      it.viewer = await native.mediaOpen(plain, it.mime);
      plain.fill(0);
      if (!it.el) { it.viewer.close(); return; }
      if (it.mime === 'image/gif') {
        const img = Object.assign(new Image(), { className: 'm-media', draggable: false, src: it.viewer.url });
        it.img = img;
        box.appendChild(img);
        countdown(it, N);
      } else {
        const v = document.createElement('video');
        Object.assign(v, { className: 'm-media', controls: true, autoplay: true, playsInline: true, disablePictureInPicture: true });
        v.setAttribute('controlsList', 'nodownload noplaybackrate noremoteplayback');
        if (DEBUG_MEDIA) {
          v.muted = true;
          v.onloadeddata = () => send({ t: 'debug', ev: 'video-loaded', w: v.videoWidth, dur: v.duration });
          v.onerror = () => send({ t: 'debug', ev: 'video-error', code: v.error?.code, msg: v.error?.message });
        }
        v.onended = () => countdown(it, N);
        v.src = it.viewer.url;
        it.video = v;
        box.appendChild(v);
        // 兜底：一直不看完也会在「时长 + 2 分钟 + N 秒」后焚毁
        it.capTimer = setTimeout(() => burn(it), (it.dur + 120 + N) * 1000);
      }
    }
    box.classList.add('revealed');
    setMediaStatus(it, 'viewing');
  } catch {
    plain.fill(0);
    setMediaStatus(it, 'failed');
  }
}

function countdown(it, sec) {
  if (it.countdown || !it.el) return;
  it.countdown = setTimeout(() => burn(it), sec * 1000);
  const bar = it.el.querySelector('.m-ttl');
  bar.querySelector('i').style.animationDuration = `${sec}s`;
  bar.classList.add('on');
}

function cleanupMedia(it) {
  clearTimeout(it.countdown); clearTimeout(it.capTimer);
  state.incoming.delete(it.id);
  if (it.frames) { it.frames.forEach((f) => f?.fill(0)); it.frames = null; }
  if (it.canvas) {
    it.canvas.getContext('2d').clearRect(0, 0, it.canvas.width, it.canvas.height);
    it.canvas.width = it.canvas.height = 0;
    it.canvas = null;
  }
  if (it.video) { it.video.pause(); it.video.removeAttribute('src'); it.video.load(); it.video = null; }
  if (it.img) { it.img.removeAttribute('src'); it.img = null; }
  if (it.viewer) { it.viewer.close(); it.viewer = null; }
  it.el?.querySelector('.m-box')?.classList.remove('zoom');
  if (DEBUG_MEDIA && !it.mine) send({ t: 'debug', ev: 'burned', id: it.id });
}

// 点击：查看 / 放大
$('#threads').addEventListener('click', (e) => {
  const card = e.target.closest('.item.media');
  if (!card) return;
  const it = state.items.find((i) => i.id === card.dataset.id);
  if (!it) return;
  if (e.target.closest('.m-view')) viewMedia(it);
  else if (it.canvas || it.img) card.querySelector('.m-box').classList.toggle('zoom');
});

// 选择文件 / 粘贴 / 拖拽
$('#attach-btn').onclick = () => $('#file-input').click();
$('#file-input').onchange = (e) => { sendFiles(e.target.files); e.target.value = ''; };
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => /^(image|video)\//.test(f.type));
  if (files.length) { e.preventDefault(); sendFiles(files); }
});
let dragDepth = 0;
const chatEl = $('#chat');
chatEl.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; chatEl.classList.add('dropping'); } });
chatEl.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; chatEl.classList.remove('dropping'); } });
chatEl.addEventListener('dragover', (e) => e.preventDefault());
chatEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0; chatEl.classList.remove('dropping');
  if (e.dataTransfer?.files?.length) sendFiles(e.dataTransfer.files);
});

// 禁用右键菜单（避免「存储图像 / 下载视频」）；输入框保留
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input, textarea')) return;
  if (import.meta.env.DEV && !e.target.closest('.m-box')) return;
  e.preventDefault();
});

/* ---------------- 伪装场景（按工种切换假历史、后台任务和伪装页） ---------------- */
const toolLine = (n) => { const t = persona().tools; return t[n % t.length](n); };

// 侧栏名称自定义：prefs.recentNames[场景] = { others: [第 3～7 条的默认标题], names: { 序号: 自定义名称 } }
// 第一次改名时把随机生成的第 3～7 条固定下来，之后打开顺序不变。只存名称，不存口令指纹
const recentStore = () => (prefs.recentNames[prefs.persona] ||= { others: null, names: {} });
let recentDefaults = [];

/* 私聊条目：默认名从任务池里按（会话指纹 + 对方名字）选一个。
 * 自定义名称存在 prefs.dmNames 里，键是指纹和名字的哈希：没有口令的人看不出是和谁的私聊 */
const DM_NAMES_MAX = 100;
const dmKey = (p) => hashNum(`${state.session?.fingerprint || ''}\n${p.name}`).toString(36);
const fakeCount = (dmN) => Math.max(3, 6 - dmN); // 私聊多了就少显示几条假任务（含伪装页那条）
function dmDefaults(dms) {
  // 避开侧栏里已经显示的标题，不出现两条同名
  const shown = recentDefaults.slice(0, 1 + fakeCount(dms.length));
  const pool = persona().tasks.filter((t) => !shown.includes(t));
  if (!pool.length) pool.push(...persona().tasks);
  const used = new Set();
  const out = new Map();
  for (const p of dms) {
    let k = hashNum(dmKey(p)) % pool.length;
    for (let n = 0; used.has(k) && n < pool.length; n++) k = (k + 1) % pool.length;
    used.add(k);
    out.set(p.cid, pool[k]);
  }
  return out;
}
/** 侧栏里显示的私聊：在线且支持私聊的成员，以及还有消息没焚毁 / 正在查看的私聊 */
const dmList = () => [...state.members.values()]
  .filter((p) => (p.online && hasCap(p, 'dm')) || convItems(dmConv(p.cid)).length || state.active === dmConv(p.cid))
  .sort((a, b) => a.seq - b.seq);

function renderRecents() {
  if (document.querySelector('#recents li.editing')) return; // 正在改名，改完会重新渲染
  const names = prefs.recentNames[prefs.persona]?.names || {};
  const dms = dmList();
  const defs = dmDefaults(dms);
  const L = labels();
  const edit = '<b class="r-badge" hidden></b><button class="r-edit" title="重命名" tabindex="-1">✎</button>';
  const row = (attrs, cls, name, extra = '') => `<li class="${cls}" ${attrs} title="双击重命名"><span class="r-name">${esc(name)}</span>${extra}${edit}</li>`;
  $('#recents').innerHTML = [
    row(`data-conv="${GROUP}" data-i="0"`, '', names[0] || recentDefaults[0]),
    ...dms.map((p) => {
      const l = L.get(p.cid);
      const tag = `<span class="r-tag" style="--c:${l.color}"><i></i>${esc(l.text)}</span>`;
      return row(`data-conv="${dmConv(p.cid)}" data-dm="${esc(p.cid)}"`, `dm${p.online ? '' : ' offline'}`, prefs.dmNames[dmKey(p)] || defs.get(p.cid), tag);
    }),
    ...recentDefaults.slice(1, 1 + fakeCount(dms.length)).map((t, j) =>
      row(`data-i="${j + 1}"`, 'fake', names[j + 1] || t, j === 1 ? '<span class="spin sm"></span>' : '')),
  ].join('');
  updateBadges();
  setBoss(state.boss); // 同步高亮和标题
}

/** 侧栏未读数（每个会话一个） */
function updateBadges(unseen = state.items.filter((i) => !i.mine && !i.seen)) {
  const counts = new Map();
  for (const i of unseen) counts.set(i.conv, (counts.get(i.conv) || 0) + 1);
  for (const li of $('#recents').children) {
    const b = li.querySelector('.r-badge');
    if (!b || !li.dataset.conv) continue;
    const n = counts.get(li.dataset.conv) || 0;
    b.textContent = n > 99 ? '99+' : n;
    b.hidden = !n || li.dataset.conv === state.active;
  }
}

/** 顶部标题旁：群聊显示在线的人，私聊显示对方 */
function renderHeader() {
  const el = $('#conv-tag');
  if (!el) return;
  const peer = convPeer(state.active);
  if (state.boss || !state.entered) { el.hidden = true; return; }
  if (peer) {
    el.innerHTML = `${whoHTML(peer, 'who')}${peer.online ? '' : '<span class="off">offline</span>'}`;
    el.title = '私聊：只有你们两个人能看到';
  } else {
    const on = onlineMembers().sort((a, b) => a.seq - b.seq);
    const shown = on.slice(0, 3).map((p) => whoHTML(p, 'who')).join('');
    el.innerHTML = on.length ? `${shown}${on.length > 3 ? `<span class="off">+${on.length - 3}</span>` : ''}` : '<span class="off">waiting for peers</span>';
    el.title = on.length ? `群聊 · ${on.length + 1} 人在线：你、${on.map((p) => labelOf(p).text).join('、')}` : '';
  }
  el.hidden = false;
}

function renameRecent(li) {
  if (!li || li.querySelector('input')) return;
  const dm = li.dataset.dm ? state.members.get(li.dataset.dm) : null;
  if (li.dataset.dm && !dm) return;
  const i = Number(li.dataset.i);
  const def = dm ? dmDefaults(dmList()).get(dm.cid) : recentDefaults[i];
  const label = li.querySelector('.r-name');
  const input = document.createElement('input');
  input.className = 'r-input';
  input.maxLength = 60;
  input.value = label.textContent;
  input.placeholder = def;
  li.classList.add('editing');
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const v = input.value.replace(/\s+/g, ' ').trim();
      const keep = v && v !== def; // 清空 = 恢复默认名称
      if (dm) {
        const k = dmKey(dm);
        delete prefs.dmNames[k];
        if (keep) prefs.dmNames[k] = v;
        const keys = Object.keys(prefs.dmNames);
        for (const old of keys.slice(0, Math.max(0, keys.length - DM_NAMES_MAX))) delete prefs.dmNames[old];
      } else {
        const store = recentStore();
        store.others ||= recentDefaults.slice(2);
        if (keep) store.names[i] = v;
        else delete store.names[i];
      }
      savePrefs();
    }
    li.classList.remove('editing');
    renderRecents();
  };
  input.onkeydown = (e) => {
    e.stopPropagation(); // Esc 不触发老板键
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
}

function renderPersona() {
  const p = persona();
  const fp = state.session?.fingerprint || '';
  // 第 1 条是真实会话（标题由口令指纹决定，双方一致），第 2 条是伪装页对应的任务
  const pool = p.tasks.filter((t) => t !== p.decoyTask);
  const title = pool[hashNum(fp) % pool.length];
  const saved = prefs.recentNames[prefs.persona]?.others;
  const others = saved?.length === 5 ? saved : pool.filter((t) => t !== title).sort(() => Math.random() - 0.5).slice(0, 5);
  recentDefaults = [title, p.decoyTask, ...others];
  $('#decoy').innerHTML = p.decoy({ mark, esc });
  renderRecents();
  // 已显示的对方消息：工具行跟着换
  for (const it of state.items) {
    if (it.kind === 'msg' && !it.mine) {
      const tool = it.el?.querySelector('.tool');
      if (tool) tool.innerHTML = `${esc(toolLine(hashNum(it.id)))} <i>›</i>`;
    }
  }
  runner.setProfile(p.runner);
  if (prefs.runner && state.entered) runner.start();
  $('#persona').value = prefs.persona in PERSONAS ? prefs.persona : 'dev';
}

$('#persona').innerHTML = Object.entries(PERSONAS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('');
$('#persona').onchange = (e) => { prefs.persona = e.target.value; savePrefs(); renderPersona(); };

// 成员显示方式：真名 / 代号（只影响自己的界面）
const setLabelSeg = () => document.querySelectorAll('#label-seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === prefs.memberLabel));
document.querySelectorAll('#label-seg button').forEach((b) => (b.onclick = () => {
  prefs.memberLabel = b.dataset.v === 'alias' ? 'alias' : 'name';
  savePrefs(); setLabelSeg(); refreshLabels();
}));
setLabelSeg();
$('#recents-reset').onclick = () => {
  delete prefs.recentNames[prefs.persona];
  prefs.dmNames = {};
  savePrefs();
  renderPersona();
  toast('侧栏名称已恢复默认');
};

/* ---------------- 开发自测：VITE_AUTOJOIN="server|name|key" npm run app ---------------- */
if (import.meta.env.DEV && import.meta.env.VITE_AUTOJOIN) {
  const [server, name, key] = import.meta.env.VITE_AUTOJOIN.split('|');
  $('#server').value = server;
  $('#name').value = name;
  $('#pass').value = key;
  $('#join-form').requestSubmit();
}

/* 开发自测：VITE_AUTOSEND=1 时，有人在线后自动发送一张生成的测试图片 */
if (import.meta.env.DEV && import.meta.env.VITE_AUTOSEND) {
  const timer = setInterval(async () => {
    if (!onlineMembers().some((p) => hasCap(p, 'media'))) return;
    clearInterval(timer);
    const c = Object.assign(document.createElement('canvas'), { width: 1600, height: 1200 });
    const g = c.getContext('2d');
    for (let i = 0; i < 400; i++) { g.fillStyle = `hsl(${i * 37 % 360} 70% 50%)`; g.fillRect(Math.random() * 1600, Math.random() * 1200, 120, 120); }
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    await sendMedia(new File([blob], 'test.png', { type: 'image/png' }));
    const it = state.items.find((i) => i.kind === 'media' && i.mine);
    send({ t: 'debug', ev: 'sender-status', status: it?.status, wsState: state.ws?.readyState, buffered: state.ws?.bufferedAmount });
  }, 500);
}
