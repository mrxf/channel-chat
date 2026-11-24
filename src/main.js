import './style.css';
import { deriveSession, seal, open, randomId, generateKey, sealChunk, chunkHeader, openChunk } from './crypto.js';
import { prepareFile, fmtSize, fmtDur, CHUNK, MAX_VIDEO, MAX_IMAGE_RAW, MAX_AUDIO, MAX_INFLIGHT, IMAGE_MIME, VIDEO_MIME, AUDIO_MIME } from './media.js';
import { createVoiceRecorder, createVoicePlayer, MAX_VOICE_SEC } from './voice.js';
import { native } from './native.js';
import { createRunner } from './runner.js';
import { PERSONAS, getPersona, personaLabel } from './personas.js';
import { SERVER_LIST_URL, DEFAULT_PORT, MAX_ACTION_LEN } from './config.js';
import { DEFAULT_LANG, t, setLang, getLang, applyDomI18n } from './i18n.js';
import { createLanModule } from './lan.js';
import { DEFAULT_MODEL, createModelPicker } from './models.js';

const $ = (s) => document.querySelector(s);
// 客户端能力：旧版客户端的 hello/hi 不带 caps。media = 能收附件，dm = 支持私聊，audio = 支持语音
const CAPS = ['media', 'dm', 'audio'];
const APP_VERSION = __APP_VERSION__;
document.getElementById('join-ver').textContent = `v${APP_VERSION}`;
const MAX_SKEW = 10 * 60 * 1000; // 拒绝 10 分钟外的消息（防重放）
const TICK = 250;
const ACTION_TTL = 20; // 动作读完 20 秒后焚毁

/* ---------------- 本地偏好（不含任何消息内容） ---------------- */
const prefs = Object.assign(
  {
    name: '', server: '', recentServers: [], theme: null, blurHide: false, notify: true, runner: true,
    runnerOpen: true, protect: false, customActions: [], persona: 'dev', rememberKey: true,
    recentNames: {}, dmNames: {}, memberLabel: 'name', lang: DEFAULT_LANG, model: DEFAULT_MODEL,
  },
  await native.loadPrefs(),
);
const savePrefs = () => native.savePrefs(prefs);
setLang(prefs.lang || DEFAULT_LANG);
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
  serverActions: [], lastAction: 0, lastNotify: 0, unread: -1,
  receipts: new Map(), // 会话 → 待发送的已读回执
  acked: new Map(),    // 会话 → 最近已读的消息 ID（断线重连后补发回执，避免对方卡未读）
};

// 所有跨函数引用的模块级状态统一在顶部初始化，彻底杜绝 ES Module TDZ（暂时性死区）异常
const updState = { info: null, checking: false, phase: 'idle', pct: 0, downloaded: 0, total: 0, err: '' };
const updBusy = () => ['downloading', 'verifying', 'installing'].includes(updState.phase);
const pops = { settings: $('#settings'), actions: $('#actions-pop'), model: $('#model-pop') };
const wipeShortcutLabel = native.isMac ? '⌘K' : 'Ctrl+K';
const DM_NAMES_MAX = 100;
let connGen = 0;
let reconnectTimer = null;
let lastTrafficAt = 0;
let lastPingAt = 0;
let pingSupport = false; // 收到过服务器的 pong 即开启超时强断检测（兼容未升级的旧服务器）
let lastStatusKey = 'connecting';
let lastStatusKind = 'wait';
let relayPollTimer = null;
let recentDefaults = [];

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
  let dropped = false;
  for (const it of state.items) {
    if (it.conv === from) it.conv = to;
    if (it.cid === old) it.cid = cid; // 他之前发的消息仍然算他的（轮次、回执）
    // cid 变了说明对方重启了客户端，内存里的旧消息已消失，不可能再发回旧消息的已读回执
    if (it.need?.delete(old)) { progress(it); dropped = true; }
    for (const set of [it.readBy, it.recvBy, it.viewBy]) if (set?.delete(old)) set.add(cid);
  }
  const t = threadEl(from);
  if (t) t.dataset.conv = to;
  for (const map of [state.receipts, state.acked]) {
    if (map.has(from)) { map.set(to, map.get(from)); map.delete(from); }
  }
  if (state.compacted.delete(from)) state.compacted.add(to);
  if (state.active === from) state.active = to;
  if (dropped) enforceKeep();
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
  for (const it of state.items) if (it.mine && it.kind === 'msg') renderReceipt(it);
  renderRecents();
  renderHeader();
}

/** 每个会话一个消息列表，只显示当前会话 */
function threadEl(conv) {
  return [...$('#threads').children].find((t) => t.dataset.conv === conv);
}
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
  if (!s) throw new Error(t('join.errNoServer'));
  if (!/^[a-z]+:\/\//i.test(s)) s = 'ws://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error(t('join.errBadServer')); }
  if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol === 'https:') u.protocol = 'wss:';
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error(t('join.errBadProto'));
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
const setServerHint = (text, cls = '') => { const h = $('#server-hint'); h.textContent = text || '\u00a0'; h.className = `field-hint ${cls}`; };

function isLoopbackVal(val) {
  try {
    const h = new URL(toWsUrl(val)).hostname;
    return h === '127.0.0.1' || h === 'localhost';
  } catch { return false; }
}

const lan = createLanModule({
  native,
  getServerInput: () => $('#server').value.trim(),
  setServerInput: (v) => { $('#server').value = v; },
  getDisplayName: () => $('#name').value.trim().slice(0, 24) || state.name || prefs.name || '',
  checkServer: (v) => checkServer(v),
  renderServerList,
  setServerHint,
  showJoinError,
  copyText,
  toast,
  isEntered: () => state.entered,
  getWsHost: () => (state.wsUrl ? shortServer(state.wsUrl) : ''),
  getServerName: () => state.serverName,
  onReconnectToLocal: (localAddr) => {
    clearReconnectTimers();
    const old = state.ws;
    state.ws = null;
    try { old?.close(); } catch { /* ignore */ }
    state.wsUrl = toWsUrl(localAddr);
    state.retry = 0;
    lan.renderUI();
    connect().catch(() => {});
  },
});

async function checkServer(val) {
  const seq = ++probeSeq;
  let wsUrl, url;
  try { wsUrl = toWsUrl(val); url = httpUrl(wsUrl, '/health'); } catch (e) { setServerHint(e.message, 'bad'); return false; }
  setServerHint(t('join.checking'));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3000);
  try {
    const d = await (await fetch(url, { signal: ctl.signal, cache: 'no-store' })).json();
    if (d?.app !== 'agent-relay') throw new Error();
    if (seq === probeSeq) {
      if (lan.isLocalRelayHost(shortServer(wsUrl))) {
        const info = lan.relayInfo;
        const msg = info.shareAddr !== info.localAddr
          ? t('join.hostingLan', { addr: info.shareAddr })
          : t('join.hostingLoopback');
        setServerHint(`● ${msg}`, 'good');
      } else {
        const more = lan.lanFound.length > 1 ? t('join.onlineMore', { n: lan.lanFound.length }) : '';
        setServerHint(t('join.online', { name: String(d.name || 'relay').slice(0, 40), more }), 'good');
      }
    }
    return true;
  } catch {
    if (seq === probeSeq) {
      if (native.canHost && !lan.relayInfo.running && isLoopbackVal(val)) {
        setServerHint(t('join.loopbackOff'), 'bad');
      } else {
        setServerHint(t('join.unreachable'), 'bad');
      }
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function probe() {
  clearTimeout(probeTimer);
  const val = $('#server').value.trim();
  if (!val) { ++probeSeq; setServerHint(''); return; }
  probeTimer = setTimeout(() => checkServer(val), 350);
}
$('#server').addEventListener('input', probe);

if (
  !lan.bindJoinEvents({
    parseHostOfInput: () => {
      try { return shortServer(toWsUrl($('#server').value)); } catch { return ''; }
    },
  })
  && prefs.server
) {
  probe();
}

$('#pw-toggle').onclick = () => { const p = $('#pass'); p.type = p.type === 'password' ? 'text' : 'password'; };
$('#pw-gen').onclick = async () => {
  const p = $('#pass');
  p.value = generateKey();
  p.type = 'text';
  const ok = await copyText(p.value, p);
  const hint = $('#pass-hint');
  hint.textContent = ok ? t('join.keyGenCopied') : t('join.keyGenManual');
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

function renderRememberTexts() {
  if (!native.canRemember) return;
  $('#remember-title').textContent = native.isMac ? t('join.rememberMac') : t('join.rememberPc');
  $('#remember-sub').textContent = native.isMac ? t('join.rememberSubMac') : t('join.rememberSubPc');
}

if (native.canRemember) {
  $('#remember-row').hidden = false;
  renderRememberTexts();
  $('#remember-key').checked = prefs.rememberKey;
  $('#remember-key').onchange = (e) => {
    prefs.rememberKey = e.target.checked;
    savePrefs();
    const hint = $('#pass-hint');
    if (!prefs.rememberKey && savedKey) {
      native.deleteSecret(); savedKey = null;
      hint.textContent = t('join.rememberDeleted'); hint.className = 'field-hint';
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
  if (!name) return showJoinError(t('join.errNoName'));
  if (pass.length < 4) return showJoinError(t('join.errShortKey'));

  const btn = $('#join-btn');
  btn.disabled = true; btn.textContent = t('join.deriving');
  if (prefs.notify) native.ensureNotifyPermission();
  let connected = false;
  try {
    state.name = name;
    state.cid = randomId(); // 本次会话的成员 ID，只在内存里
    state.wsUrl = wsUrl;
    state.session = await deriveSession(pass);
    btn.textContent = t('join.connecting');
    await connect(true);
    connected = true;
  } catch (err) {
    state.session = null;
    const ws = state.ws;
    state.ws = null;
    try { ws?.close(); } catch { /* ignore */ }
    showJoinError(err.message || t('join.errConnect'));
  } finally {
    btn.disabled = false; btn.textContent = t('join.submit');
  }
  if (!connected) return;

  // 记住名称和服务器；口令只有勾选时才保存（已连接成功后独立执行，绝不误关有效 WebSocket）
  if (native.canRemember) {
    if (prefs.rememberKey && pass !== savedKey) { if (await native.setSecret(pass)) savedKey = pass; }
    else if (!prefs.rememberKey && savedKey) { native.deleteSecret(); savedKey = null; }
  }
  prefs.name = name;
  prefs.server = $('#server').value.trim();
  prefs.recentServers = [prefs.server, ...prefs.recentServers.filter((s) => s !== prefs.server)].slice(0, 8);
  savePrefs();
  lan.syncServerOptions();
  $('#pass').value = ''; $('#pass').type = 'password'; $('#pass-hint').innerHTML = '&nbsp;';
  enterMain();
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

const modelPicker = createModelPicker({
  btnEl: $('#model-btn'),
  popEl: $('#model-pop'),
  initialModel: prefs.model,
  onSelect: (modelId) => {
    prefs.model = modelId;
    savePrefs();
    toast(t('model.switched', { model: modelId }));
  },
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
  $('#build-time').textContent = t('set.buildTime', { time: __BUILD_TIME__ });
  lan.renderUI();
  lan.refreshStatus();
  renderPersonaOptions();
  renderPersona();
  applyCfgUI();
  applyRunner();
  renderActions();
  $('#input').focus();
}

/* ---------------- 网络 ---------------- */
function clearReconnectTimers() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect(gen) {
  clearReconnectTimers();
  if (!state.session || !state.entered || gen !== connGen) return;
  const delay = Math.min(8000, 500 * 2 ** Math.min(state.retry++, 6));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (state.session && state.entered && gen === connGen) connect().catch(() => {});
  }, delay);
}

function dropSocketAndReconnect(gen = connGen, immediate = false) {
  const cur = state.ws;
  state.ws = null;
  if (cur) {
    cur.onmessage = null;
    cur.onclose = null;
    cur.onerror = null;
    try { cur.close(); } catch { /* ignore */ }
  }
  if (!state.session || !state.entered) return;
  setStatusKey('reconnecting', 'off');
  markAllOffline();
  if (immediate) {
    state.retry = 0;
    clearReconnectTimers();
    connect().catch(() => {});
  } else {
    scheduleReconnect(gen);
  }
}

/** 唤醒 / 获焦 / 网络恢复 / 发送受阻时：立即检查并修复断连或半开假死 */
function recoverConnection(force = false) {
  if (!state.entered || !state.session) return;
  const ws = state.ws;
  if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
    if (force || reconnectTimer || lastStatusKey === 'online') {
      dropSocketAndReconnect(++connGen, true);
    }
    return;
  }
  if (ws.readyState === WebSocket.OPEN) {
    // 立即发一帧应用层探活，若连接实际已半开假死可加速内核感知 RST/EOF
    try {
      lastPingAt = Date.now();
      ws.send(JSON.stringify({ type: 'ping' }));
    } catch {
      dropSocketAndReconnect(++connGen, true);
    }
  }
}

function connect(first = false) {
  return new Promise((resolve, reject) => {
    const gen = ++connGen;
    clearReconnectTimers();
    const prev = state.ws;
    state.ws = null;
    if (prev) {
      prev.onmessage = null;
      prev.onclose = null;
      prev.onerror = null;
      try { prev.close(); } catch { /* ignore */ }
    }

    setStatusKey(first ? 'connecting' : 'reconnecting', first ? 'wait' : 'off');
    let done = false;
    let joined = false;
    let ws;
    try {
      ws = new WebSocket(state.wsUrl);
    } catch (err) {
      if (first) return reject(err);
      scheduleReconnect(gen);
      return resolve();
    }
    ws.binaryType = 'arraybuffer';
    state.ws = ws;
    pingSupport = false;
    lastPingAt = 0;

    const failOrRetry = (errMsg) => {
      clearTimeout(timeout);
      if (gen !== connGen) return;
      if (state.ws === ws) state.ws = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try { ws.close(); } catch { /* ignore */ }
      if (!done) {
        done = true;
        reject(new Error(errMsg));
      }
      if (!state.session || (first && !state.entered)) return;
      setStatusKey('reconnecting', 'off');
      markAllOffline();
      scheduleReconnect(gen);
    };

    const timeout = setTimeout(() => {
      // 关键修复：WebKit 在系统代理挂起 CONNECTING socket 时 ws.close() 可能迟迟不触发 onclose，必须主动接管重连
      if (!joined) failOrRetry(t('join.errTimeout'));
    }, 6000);

    ws.onmessage = (ev) => {
      if (gen !== connGen || state.ws !== ws) return;
      lastTrafficAt = Date.now();
      if (ev.data instanceof ArrayBuffer) { onChunk(new Uint8Array(ev.data)); return; }
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.type) {
        case 'pong':
          pingSupport = true;
          break;
        case 'welcome':
          state.serverName = typeof m.name === 'string' ? m.name.slice(0, 40) : '';
          state.serverMedia = Array.isArray(m.features) && m.features.includes('media');
          state.serverDirect = Array.isArray(m.features) && m.features.includes('direct');
          state.serverActions = (Array.isArray(m.actions) ? m.actions : []).map(sanitizeAction).filter(Boolean).slice(0, 50);
          if (state.entered) { renderActions(); lan.renderUI(); }
          ws.send(JSON.stringify({ type: 'join', room: state.session.roomId }));
          // 顺手探测一次服务端是否支持应用层 ping/pong
          ws.send(JSON.stringify({ type: 'ping' }));
          break;
        case 'joined':
          joined = true;
          state.myId = m.id; state.retry = 0;
          markAllOffline(); // 自己重连：等其他人回 hi 再恢复在线；私聊记录保留
          updateCount(m.count);
          send({ t: 'hello', caps: CAPS, v: APP_VERSION });
          // 重连后几秒内没回来的人视为已离线：不再等他们的旧消息回执，之后再进来也正常提示 connected
          setTimeout(() => {
            if (gen !== connGen) return;
            for (const p of state.members.values()) {
              p.quiet = false;
              if (!p.online) dropFromNeed(p.cid);
            }
          }, 5000);
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
    ws.onclose = () => failOrRetry(t('join.errConnect'));
  });
}

// 周期性连接健康巡检：同步真实 socket 状态（杜绝「显示 N 人在线但实际已断连」的视觉假象）+ 代理半开连接保活
setInterval(() => {
  if (!state.entered || !state.session) return;
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (lastStatusKey === 'online') {
      setStatusKey('reconnecting', 'off');
      markAllOffline();
    }
    if ((!ws || ws.readyState === WebSocket.CLOSED) && !reconnectTimer) {
      recoverConnection(true);
    }
    return;
  }
  const now = Date.now();
  if (pingSupport && lastPingAt > lastTrafficAt && now - lastPingAt > 10000) {
    // 发出 ping 超过 10 秒未收到任何下行包，判定 TCP 半开假死，立即重连
    dropSocketAndReconnect(++connGen, true);
    return;
  }
  if (now - lastTrafficAt >= 15000 && now - lastPingAt >= 15000) {
    try {
      lastPingAt = now;
      ws.send(JSON.stringify({ type: 'ping' }));
    } catch {
      dropSocketAndReconnect(++connGen, true);
    }
  }
}, 3000);

/** 发送加密消息。to = 目标连接 ID（只发给这个人），不填则发给房间里所有人 */
function send(obj, to) {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    // 一旦发送时发现底层连接并非 OPEN，立即同步 UI 为重连态并拉起重连，绝不留存假在线状态
    if (state.entered && state.session) {
      if (lastStatusKey === 'online') {
        setStatusKey('reconnecting', 'off');
        markAllOffline();
      }
      if (!ws || ws.readyState !== WebSocket.CONNECTING) recoverConnection(true);
    }
    return false;
  }
  const inner = { name: state.name, cid: state.cid, ...obj };
  try {
    ws.send(JSON.stringify({ type: 'relay', data: seal(state.session, inner), ...(to ? { to } : {}) }));
    return true;
  } catch {
    dropSocketAndReconnect(++connGen, true);
    return false;
  }
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

/** 移除某成员未完成的回执等待，并在状态变化后重新检查保留轮数 */
function dropFromNeed(cid) {
  let touched = false;
  for (const it of state.items) {
    if (!it.mine || !it.need?.has(cid)) continue;
    if (it.kind === 'media' ? !it.viewBy.has(cid) : !it.readBy.has(cid)) {
      it.need.delete(cid);
      progress(it);
      touched = true;
    }
  }
  if (touched) enforceKeep();
}

/** 有人离开：更新侧栏；我发出的消息不再等他的已读回执 */
function memberGone(p) {
  p.online = false;
  p.conn = null;
  sys(t('msg.sysLeave', { who: whoHTML(p, 'who') }));
  if (threadEl(dmConv(p.cid))) sys(t('msg.sysLeave', { who: whoHTML(p, 'who') }), dmConv(p.cid));
  dropFromNeed(p.cid);
  refreshLabels();
}

const isVerNewer = (cur, cand) => {
  const p = (v) => String(v || '').replace(/^[vV]/, '').split(/[-+]/)[0].split('.').map(Number);
  const [a1, b1, c1] = p(cur), [a2, b2, c2] = p(cand);
  return ([a2 - a1, b2 - b1, c2 - c1].find((d) => d !== 0) || 0) > 0;
};

// 双方版本不一致时提示一次（旧版客户端不发送版本号）
function checkPeerVersion(p, m) {
  const v = typeof m.v === 'string' && /^\d+\.\d+\.\d+$/.test(m.v) ? m.v : null;
  p.v = v;
  p.caps = Array.isArray(m.caps) ? m.caps.filter((c) => typeof c === 'string').slice(0, 10) : [];
  if (v && isVerNewer(APP_VERSION, v) && !updState.info?.hasUpdate) checkForUpdate();
  if (v === APP_VERSION || p.warned) return;
  p.warned = true;
  const dm = hasCap(p, 'dm') ? '' : t('msg.sysNoDm');
  sys(t('msg.sysVer', { who: whoHTML(p, 'who'), peerVer: v ? 'v' + v : t('msg.sysVerOld'), myVer: APP_VERSION, dm }));
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
      if (m.t === 'hello') {
        send({ t: 'hi', cfg: state.cfg, caps: CAPS, v: APP_VERSION }, from);
        if (!isNew) resendAcked(p, from); // 对方断线重连：补发最近已读回执
      } else {
        if (!state.cfgTouched && m.cfg) { setCfg(m.cfg, false); state.cfgTouched = true; }
        if (p.quiet) resendAcked(p, from); // 自己断线重连：补发离线期间读完的回执
      }
      if ((isNew || back) && !p.quiet) {
        sys(t('msg.sysJoin', { who: whoHTML(p, 'who') }));
        if (back && threadEl(dmConv(p.cid))) sys(t('msg.sysJoin', { who: whoHTML(p, 'who') }), dmConv(p.cid));
      }
      p.quiet = false;
      flushReceipts();
      refreshLabels();
      break;
    case 'cfg':
      if (conv !== GROUP) return;
      setCfg(m, false);
      sys(t('msg.sysCfg', {
        who: whoHTML(p, 'who'),
        keep: state.cfg.keep,
        ttl: state.cfg.ttl ? state.cfg.ttl + 's' : t('set.ttlOff'),
        mview: state.cfg.mview,
      }));
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
        if (!it) continue;
        if (it.need) {
          if (!it.readBy.has(p.cid)) { it.readBy.add(p.cid); progress(it); }
        } else if (!it.read) {
          markRead(it);
        }
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

const RC_NONE = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="5" stroke-dasharray="2.2 2.2"/></svg>';
const RC_SENT = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3.8 8.5l2.8 2.8 5.5-6.5"/></svg>';
const RC_READ = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8.5l2.8 2.8 5.5-6.5M7.6 10.1l1.2 1.2 5.5-6.5"/></svg>';

/** 渲染自己发出的文字消息的已读小图标（单勾 = 已发送，绿色双勾 = 已读） */
function renderReceipt(it) {
  const rc = it.el?.querySelector('.rc');
  if (!rc) return false;
  const n = it.readBy?.size ?? 0;
  const total = it.total ?? 0;
  const done = n > 0 && [...(it.need || [])].every((c) => it.readBy.has(c));
  const sep = getLang() === 'en' ? ', ' : '、';
  const colon = getLang() === 'en' ? ': ' : '：';
  const names = [...(it.readBy || [])].map((c) => state.members.get(c)).filter(Boolean).map((p) => labelOf(p).text);
  const who = names.length ? `${colon}${names.join(sep)}` : '';

  let cls, ico, count = '', tip;
  if (total === 0 && n === 0) {
    cls = 'none'; ico = RC_NONE; tip = t('msg.rcNone');
  } else if (done) {
    cls = 'read'; ico = RC_READ;
    if (total > 1 && n < total) {
      count = `${n}/${total}`;
      tip = t('msg.rcReadPartOff', { n, total, who });
    } else {
      tip = total > 1 ? t('msg.rcReadAll', { who }) : t('msg.rcReadPeer');
    }
  } else if (n > 0) {
    cls = 'part'; ico = RC_READ;
    count = `${Math.min(n, total)}/${total}`;
    tip = t('msg.rcPart', { n: Math.min(n, total), total, who });
  } else {
    cls = 'sent'; ico = RC_SENT;
    if (total > 1) count = `0/${total}`;
    tip = total > 1
      ? t('msg.rcSentGroup', { total })
      : (it.need?.size === 0 ? t('msg.rcSentOff') : t('msg.rcSentUnread'));
  }

  const key = `${cls}|${count}`;
  if (rc.dataset.state !== key) {
    rc.dataset.state = key;
    rc.className = `rc ${cls}`;
    rc.innerHTML = `${ico}${count ? `<span class="rc-n">${count}</span>` : ''}`;
  }
  rc.title = tip;
  return done;
}

function progress(it) {
  if (!it.el) return;
  if (it.kind === 'media') {
    if (it.status === 'viewed' || it.status === 'sending' || it.status === 'failed') return;
    const viewed = [...it.need].every((c) => it.viewBy.has(c));
    if (it.viewBy.size && viewed) { setMediaStatus(it, 'viewed'); setTimeout(() => burn(it), 5000); }
    else if (it.viewBy.size) setMediaStatus(it, 'partview');
    else if (it.recvBy.size) setMediaStatus(it, 'delivered');
    return;
  }
  if (renderReceipt(it)) markRead(it);
}

function renderStatusText() {
  if (lastStatusKey === 'online') {
    $('#status').textContent = state.online > 1
      ? t('side.connectedMany', { n: state.online })
      : t('side.connectedWait');
  } else if (lastStatusKey === 'reconnecting') {
    $('#status').textContent = t('side.reconnecting');
  } else {
    $('#status').textContent = t('side.connecting');
  }
  $('#dot').className = lastStatusKind;
}
function setStatusKey(key, kind) {
  lastStatusKey = key;
  lastStatusKind = kind;
  renderStatusText();
}
function updateCount(n) {
  state.online = n;
  setStatusKey('online', 'on');
}

/* ================================================================
 *  消息 / 已读 / 焚毁（每个会话各自计算）
 *   - 收到的消息：正在看这个会话、窗口在前台、且停留够阅读时长后才算「已读」
 *   - 自己发的消息：发送时在线的人都发回已读回执后才算「已读」
 *   - 只有已读消息参与「保留 N 条」和倒计时焚毁；未读消息不会被焚毁
 * ================================================================ */
const ICON_CLEAR = '<svg viewBox="0 0 16 16" width="12.5" height="12.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 4.2h10.4M6 4.2V3c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7v1.2M4.2 4.2l.55 8.3c.04.55.5 1 1.05 1h4.4c.55 0 1.01-.45 1.05-1l.55-8.3M6.7 7v4M9.3 7v4"/></svg>';
const clearBtnHTML = () => `<button type="button" class="msg-clear" title="${esc(t('msg.clearTitle'))}">${ICON_CLEAR}</button>`;

function addItem(it) {
  Object.assign(it, { seen: it.mine, read: false, readMs: 0, timer: null });
  it.dwell = it.kind === 'msg' ? Math.min(8000, 1500 + it.text.length * 60) : 600;

  const el = document.createElement('div');
  el.dataset.id = it.id;
  const sender = it.mine ? null : state.members.get(it.cid);
  const clr = clearBtnHTML();
  if (it.kind === 'media') {
    el.className = `item media ${it.mine ? 'mine' : 'theirs'}`;
    el.innerHTML = mediaHTML(it, sender);
  } else if (it.kind === 'action') {
    el.className = 'item act-item';
    el.innerHTML = it.mine
      ? `<span class="act-ico">⌁</span><span><b>${esc(t('act.you'))}</b>${esc(actionText(it.action, it.target))}</span>${clr}`
      : `<span class="act-ico">⌁</span><span>${whoHTML(sender, 'who')}${esc(actionText(it.action, it.all ? t('act.everyone') : t('act.you').trim()))}</span>${clr}`;
  } else if (it.mine) {
    el.className = 'item msg user';
    el.innerHTML = `<div class="bubble">${format(it.text)}</div><div class="msg-foot">${clr}<span class="rc"></span></div>`;
  } else {
    const n = hashNum(it.id);
    el.className = 'item msg agent unread';
    el.innerHTML = `<div class="agent-head">${mark}<span class="tool">${esc(toolLine(n))} <i>›</i></span>${whoHTML(sender)}</div>
      <div class="prose">${format(it.text)}</div>
      <div class="msg-foot agent-foot">${clr}</div>`;
  }
  it.el = el;
  if (it.mine && it.kind === 'msg') renderReceipt(it);
  threadOf(it.conv).appendChild(el);
  state.items.push(it);
  if (it.kind === 'media') setMediaStatus(it, it.status, 0);
  enforceKeep();
  updateUnread(!it.mine);
  if (it.conv === state.active) { scrollDown(); updateWipeBtn(); }
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

function rememberAck(conv, id) {
  let list = state.acked.get(conv);
  if (!list) { list = []; state.acked.set(conv, list); }
  if (!list.includes(id)) list.push(id);
  if (list.length > 60) list.splice(0, list.length - 60);
}
function resendAcked(p, to) {
  const g = state.acked.get(GROUP);
  if (g?.length) send({ t: 'read', ids: g }, to);
  const dm = state.acked.get(dmConv(p.cid));
  if (dm?.length) send({ t: 'read', ids: dm, dm: p.cid }, to);
}

function markRead(it) {
  if (it.read) return;
  it.read = true;
  it.el?.classList.remove('unread');
  if (!it.mine && it.kind === 'msg') {
    rememberAck(it.conv, it.id);
    if (!state.receipts.has(it.conv)) state.receipts.set(it.conv, []);
    state.receipts.get(it.conv).push(it.id);
  }
  startTtl(it);
  enforceKeep();
}

function flushReceipts() {
  for (const [conv, ids] of state.receipts) {
    if (ids.length && sendTo(conv, { t: 'read', ids: ids.slice(0, 100) })) ids.splice(0, 100);
    if (!ids.length) state.receipts.delete(conv);
  }
}

/**
 * 「保留 N 轮」：同一个人连续发的消息算一轮，换人说话才算新的一轮。
 * 每个会话只保留最近 N 轮；更早的轮次里，已读的消息（或我发出的但已无在线接收者可回执的消息）焚毁，未读的继续保留。
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
      if (turn > state.cfg.keep && (m.read || (m.mine && !m.need?.size))) burn(m);
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

function burn(it, instant = false) {
  const i = state.items.indexOf(it);
  if (i < 0) return;
  state.items.splice(i, 1);
  clearTimeout(it.timer);
  if (it.kind === 'media') cleanupMedia(it);
  it.text = null; it.action = null;
  const el = it.el;
  it.el = null;
  if (instant) {
    el.remove();
  } else {
    el.style.height = el.offsetHeight + 'px';
    el.classList.add('burning');
    setTimeout(() => el.remove(), 650);
    if (!state.compacted.has(it.conv) && it.kind === 'msg') {
      state.compacted.add(it.conv);
      const c = document.createElement('div');
      c.className = 'compact';
      c.textContent = t('msg.compacted');
      threadOf(it.conv).prepend(c);
    }
  }
  updateUnread(false);
  if (it.conv === state.active) updateWipeBtn();
  // 离线成员的私聊焚毁完了，侧栏里就不再显示
  if (isDm(it.conv) && !convPeer(it.conv)?.online && !convItems(it.conv).length) renderRecents();
}
function burnAll() {
  state.acked.clear();
  for (const it of [...state.items]) burn(it, true);
}
function burnConv(conv) {
  state.acked.delete(conv);
  convItems(conv).forEach((it) => burn(it, true));
  state.compacted.delete(conv);
  const t = threadEl(conv);
  if (t) t.innerHTML = '';
  if (conv === state.active) updateWipeBtn();
}

/** 同步对话框左下角清屏图标的可用态（当前会话有可清内容且非伪装页时高亮） */
function updateWipeBtn() {
  const btn = $('#wipe-btn');
  if (!btn) return;
  const hasContent = !state.boss && (
    convItems(state.active).length > 0 || !!threadEl(state.active)?.querySelector(':scope > :not(.burning)')
  );
  btn.classList.toggle('empty', !hasContent);
}

/** 清屏：立即清空自己当前屏幕上的所有消息与提示（仅本地，不影响对方屏幕；未读消息顺带发回执） */
function wipeScreen(conv = state.active) {
  for (const it of convItems(conv)) {
    if (!it.mine) {
      it.seen = true;
      if (!it.read && it.kind === 'msg') {
        rememberAck(it.conv, it.id);
        if (!state.receipts.has(it.conv)) state.receipts.set(it.conv, []);
        state.receipts.get(it.conv).push(it.id);
      }
    }
    burn(it, true);
  }
  flushReceipts();
  state.compacted.delete(conv);
  const t = threadEl(conv);
  if (t) t.innerHTML = '';
  if (conv === state.active) updateWipeBtn();
}

/** 手动清除单条消息（仅本地隐藏并清零内存；若是未读的对方消息则顺带发回执，避免对方也卡未读） */
function dismissItem(it) {
  if (!it.mine) {
    it.seen = true;
    if (!it.read && it.kind === 'msg') {
      rememberAck(it.conv, it.id);
      if (!state.receipts.has(it.conv)) state.receipts.set(it.conv, []);
      state.receipts.get(it.conv).push(it.id);
      flushReceipts();
    }
  }
  burn(it);
  enforceKeep();
}

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
    if (!native.inTauri) document.title = count ? `(${count}) ChatBuddy` : 'ChatBuddy';
  }
  if (arrived && count > 0 && prefs.notify && !isReading() && Date.now() - state.lastNotify > 8000) {
    state.lastNotify = Date.now();
    const last = state.items.at(-1);
    // 只给通用提示，不暴露内容和发送者
    native.notify('ChatBuddy', last?.kind === 'action' ? t('notify.action') : t('notify.msg'));
  }
}

function sys(html, conv = GROUP) {
  const el = document.createElement('div');
  el.className = 'sys';
  el.innerHTML = `<span>⏺</span> ${html}`;
  threadOf(conv).appendChild(el);
  if (conv === state.active) { scrollDown(); updateWipeBtn(); }
  setTimeout(() => {
    el.classList.add('fade');
    setTimeout(() => { el.remove(); if (conv === state.active) updateWipeBtn(); }, 500);
  }, 8000);
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
    ? chips.map(({ a, src, i }) => `<button type="button" class="act-chip ${src}" data-src="${src}" data-i="${i}">${esc(actionText(a, t('act.peer')))}${src === 'custom' ? `<span class="del" title="${esc(t('act.delTitle'))}">×</span>` : ''}</button>`).join('')
    : `<span class="muted small">${esc(t('act.empty'))}</span>`;
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
  const previewText = p ? state.name + actionText({ prefix: p, suffix: s }, all ? t('act.everyone') : t('act.you').trim()) : '…';
  $('#act-preview').textContent = t('act.preview', { who, text: previewText });
}
/** 动作发给谁：私聊是对方；群聊里有两人以上在线时是「大家」 */
function actionTarget() {
  const peer = convPeer(state.active);
  if (peer) return { who: labelOf(peer).text, all: false, peer };
  const all = onlineMembers().length >= 2;
  return { who: all ? t('act.everyone') : t('act.peer'), all };
}
$('#act-prefix').addEventListener('input', updateActPreview);
$('#act-suffix').addEventListener('input', updateActPreview);
$('#act-send').onclick = () => {
  const a = customAction();
  if (!a) return toast($('#act-prefix').value.trim() ? t('act.tooLong', { max: MAX_ACTION_LEN }) : t('act.needInput'));
  if (sendAction(a)) { $('#act-prefix').value = ''; $('#act-suffix').value = ''; updateActPreview(); pops.actions.hidden = true; }
};
$('#act-save').onclick = () => {
  const a = customAction();
  if (!a) return toast(t('act.needInput'));
  if (!prefs.customActions.some((c) => c.prefix === a.prefix && c.suffix === a.suffix)) {
    prefs.customActions.push(a); prefs.customActions = prefs.customActions.slice(-30); savePrefs(); renderActions();
  }
  toast(t('act.saved'));
};
[$('#act-prefix'), $('#act-suffix')].forEach((el) => el.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); $('#act-send').click(); }
}));

function sendAction(a) {
  if (state.boss) { toast(t('toast.bossBusy')); return false; }
  if (Date.now() - state.lastAction < 1500) { toast(t('act.slowDown')); return false; }
  const conv = state.active;
  const { who, all, peer } = actionTarget();
  if (peer && !peer.online) { toast(t('toast.peerOffline', { who })); return false; }
  const m = { t: 'action', id: randomId(), ts: Date.now(), ...a, ...(all ? { all } : {}) };
  if (!sendTo(conv, m)) { toast(t('toast.notConnected')); return false; }
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
  $('#ctx-chip').textContent = t('composer.ctxChip', {
    keep: state.cfg.keep,
    ttl: state.cfg.ttl ? ' · ' + state.cfg.ttl + 's' : '',
  });
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
if (native.isMac) document.body.classList.add('mac'); // 只有 macOS 窗口有红绿灯，需要留位置

/* ---------------- 弹层 ---------------- */
function syncRelayPoll() {
  clearInterval(relayPollTimer);
  relayPollTimer = null;
  if (!pops.settings.hidden && native.canHost) {
    lan.refreshStatus();
    relayPollTimer = setInterval(() => {
      if (pops.settings.hidden) { clearInterval(relayPollTimer); relayPollTimer = null; return; }
      lan.refreshStatus();
    }, 2500);
  }
}
function togglePop(name) {
  for (const [k, el] of Object.entries(pops)) el.hidden = k === name ? !el.hidden : true;
  if (name === 'actions' && !pops.actions.hidden) { updateActPreview(); $('#act-prefix').focus(); }
  if (name === 'model' && !pops.model.hidden) modelPicker.render();
  syncRelayPoll();
}
$('#settings-btn').onclick = () => togglePop('settings');
$('#act-btn').onclick = () => togglePop('actions');
$('#model-btn').onclick = () => togglePop('model');
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('#settings-btn,#act-btn,#model-btn')) return;
  for (const el of Object.values(pops)) if (!el.hidden && !el.contains(e.target)) el.hidden = true;
  syncRelayPoll();
});
function anyPopOpen() { return Object.values(pops).some((el) => !el.hidden); }
function closePops() { Object.values(pops).forEach((el) => (el.hidden = true)); syncRelayPoll(); }

$('#relay-toggle').onchange = (e) =>
  lan.setLocalRelayFromSettings(e.target.checked, {
    shouldSwitchSession: () => state.entered && state.session && (!state.ws || state.ws.readyState !== WebSocket.OPEN),
  });

function renderKeysAndWipeUI() {
  $('#wipe-btn').title = t('composer.wipeTitle', { shortcut: wipeShortcutLabel });
  $('#keys-hint').innerHTML = t('set.keys', { wipeKey: wipeShortcutLabel });
}
renderKeysAndWipeUI();

function triggerWipe() {
  if (state.boss) return;
  closePops();
  wipeScreen();
  // 清屏后立即把焦点保持在输入框，方便看完消息点清除后直接输入
  $('#input').focus({ preventScroll: true });
}
$('#wipe-btn').addEventListener('mousedown', (e) => e.preventDefault());
$('#wipe-btn').onclick = () => triggerWipe();
$('#share-btn').onclick = async () => {
  const addr = await lan.shareableAddr(shortServer(state.wsUrl));
  toast((await copyText(addr)) ? t('toast.shareCopied', { addr }) : addr);
};
// 清空当前会话（双方一起）
const clearConv = () => { burnConv(state.active); sendTo(state.active, { t: 'burn' }); };
$('#clear-btn').onclick = () => { clearConv(); closePops(); };
$('#leave-btn').onclick = leave;

function leave() {
  abortVoiceActivity();
  connGen++;
  clearReconnectTimers();
  const ws = state.ws;
  try {
    burnAll();
    Object.assign(state, {
      session: null, ws: null, entered: false, cfgTouched: false, active: GROUP,
      cfg: { keep: 1, ttl: 0, mview: 10 }, items: [],
    });
    for (const k of ['members', 'conns', 'seen', 'incoming', 'receipts', 'acked', 'compacted']) state[k].clear();
    native.mediaClear();
    if (ws) {
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try { ws.close(); } catch { /* ignore */ }
    }
    runner.stop();
    native.setUnread(0); state.unread = 0;
    $('#threads').innerHTML = '';
    closePops();
    setBoss(false);
  } finally {
    $('#main').hidden = true;
    $('#join').hidden = false;
  }
  lan.refreshStatus(true);
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
  if (state.boss) { toast(t('toast.bossBusy')); return; }
  if (text.startsWith('/') && command(text)) { input.value = ''; autosize(); return; }
  const conv = state.active;
  const peer = convPeer(conv);
  if (peer && !peer.online) { toast(t('toast.peerOfflineMsg', { who: labelOf(peer).text })); return; }
  const msg = { t: 'msg', id: randomId(), text, ts: Date.now() };
  if (!sendTo(conv, msg)) { toast(t('toast.notConnected')); return; }
  state.seen.add(msg.id);
  addItem({ id: msg.id, conv, kind: 'msg', mine: true, text, ...recipients(conv) });
  input.value = ''; autosize();
};

function command(text) {
  const [cmd, arg] = text.split(/\s+/);
  switch (cmd) {
    case '/cls': wipeScreen(); return true;
    case '/host': lan.hostCommand(() => state.entered && state.session && (!state.ws || state.ws.readyState !== WebSocket.OPEN)); return true;
    case '/clear': clearConv(); return true;
    case '/update': checkForUpdate({ manual: true }); return true;
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
  if (on) abortVoiceActivity();
  $('#threads').hidden = on;
  $('#decoy').hidden = !on;
  const target = on ? $('#recents li.fake') : [...$('#recents').children].find((li) => li.dataset.conv === state.active);
  document.querySelectorAll('#recents li').forEach((li) => li.classList.toggle('active', li === target));
  if (target) $('#title').textContent = target.querySelector('.r-name')?.textContent || target.textContent;
  renderHeader();
  renderUpdateBadges();
  updateWipeBtn();
  if (on) { closePops(); closeUpdModal(); }
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
  if (e.key === 'Escape' && !$('#upd-modal').hidden) { closeUpdModal(); return; }
  if ($('#main').hidden) return;
  if ((native.isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
    if (!state.boss && $('#upd-modal').hidden) {
      e.preventDefault();
      triggerWipe();
    }
    return;
  }
  if (e.key !== 'Escape') return;
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
window.addEventListener('focus', () => { if (state.entered) recoverConnection(false); });
window.addEventListener('online', () => { if (state.entered) recoverConnection(true); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && prefs.blurHide && state.entered) setBoss(true);
  else if (!document.hidden && state.entered) recoverConnection(false);
});
window.addEventListener('pagehide', () => { abortVoiceActivity(); burnAll(); native.mediaClear(); state.session = null; });

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
const STOP_ICO = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const MIC_ICO = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 10.5a6.5 6.5 0 0 0 13 0"/><path d="M12 17v4"/></svg>';

const voicePlayer = createVoicePlayer();
const voiceRecorder = createVoiceRecorder({
  onTick: (sec, level) => {
    $('#vr-time').textContent = `${fmtDur(sec)} / ${fmtDur(MAX_VOICE_SEC)}`;
    const bars = $('#vr-meter')?.children;
    if (bars) {
      for (let i = 0; i < bars.length; i++) {
        const wave = Math.sin(sec * 12 + i * 0.9) * 0.35 + 0.65;
        const h = Math.max(4, Math.min(18, Math.round(4 + level * wave * 14)));
        bars[i].style.height = `${h}px`;
      }
    }
  },
  onAutoStop: () => finishVoiceRecording(true),
});

function setRecordingUI(on) {
  $('#voice-rec').hidden = !on;
  $('#input').hidden = on;
  $('#composer-row').hidden = on;
  if (on) $('#vr-time').textContent = `0:00 / ${fmtDur(MAX_VOICE_SEC)}`;
}

/** 老板键 / 退房 / 页面销毁时：瞬间静音 + 停止录音 + 清零并焚毁正在播放的语音 */
function abortVoiceActivity() {
  if (voiceRecorder.recording) {
    voiceRecorder.cancel();
    setRecordingUI(false);
  }
  const playingId = voicePlayer.playingId;
  if (playingId) {
    voicePlayer.stop();
    const it = state.items.find((i) => i.id === playingId);
    if (it) burn(it, true);
  }
}

function normalizePeaks(raw) {
  if (!Array.isArray(raw) || !raw.length) return [24, 42, 68, 52, 80, 62, 36, 74, 88, 50, 44, 70, 58, 32, 64, 76, 48, 38, 60, 40];
  return raw.slice(0, 32).map((n) => Math.max(10, Math.min(100, Number(n) | 0)));
}

function mediaHTML(it, sender) {
  if (it.mtype === 'audio') {
    const durStr = it.dur ? ' · ' + fmtDur(it.dur) : '';
    const head = it.mine
      ? ''
      : `<div class="agent-head">${mark}<span class="tool">${esc(t('media.voiceStream', { dur: durStr }))} <i>›</i></span>${whoHTML(sender)}</div>`;
    const peaks = normalizePeaks(it.peaks);
    const bars = peaks.map((v) => `<i style="height:${Math.max(18, v)}%"></i>`).join('');
    return `${head}
      <div class="v-card">
        <div class="v-main">
          <button type="button" class="v-play" ${it.mine ? 'disabled' : ''}>${it.mine ? MIC_ICO : PLAY}</button>
          <div class="v-bars">${bars}</div>
          <span class="v-dur">${esc(fmtDur(it.dur || 0))}</span>
        </div>
        <div class="v-sub">
          <span class="v-tag"></span>
          <span>${esc(fmtSize(it.size))}</span>
        </div>
        <div class="v-prog"><i></i></div>
      </div>
      <div class="msg-foot ${it.mine ? '' : 'agent-foot'}">
        ${clearBtnHTML()}
      </div>`;
  }
  const mtypeLabel = it.mtype === 'image' ? t('media.image') : t('media.video');
  const durStr = it.dur ? ' · ' + fmtDur(it.dur) : '';
  const label = `${mtypeLabel} · ${fmtSize(it.size)}${durStr}`;
  const ar = Math.min(2, Math.max(0.6, it.w / it.h || 1.5)).toFixed(3);
  const head = it.mine
    ? ''
    : `<div class="agent-head">${mark}<span class="tool">${esc(t('media.attached', { type: mtypeLabel, size: fmtSize(it.size), dur: durStr }))} <i>›</i></span>${whoHTML(sender)}</div>`;
  return `${head}
    <div class="m-box" style="aspect-ratio:${ar}">
      ${it.thumb ? `<img class="m-thumb" src="${esc(it.thumb)}" draggable="false" alt="">` : '<div class="m-thumb m-noise"></div>'}
      <div class="m-over"></div>
      <div class="m-ttl"><i></i></div>
    </div>
    <div class="msg-foot ${it.mine ? '' : 'agent-foot'}">
      ${it.mine ? `<span class="m-meta">${esc(label)}</span>` : ''}
      ${clearBtnHTML()}
    </div>`;
}

function setMediaStatus(it, status, pct = 0) {
  it.status = status;
  if (it.mtype === 'audio') {
    const card = it.el?.querySelector('.v-card');
    if (!card) return;
    const tag = card.querySelector('.v-tag');
    const btn = card.querySelector('.v-play');
    const many = it.mine && it.total > 1;
    card.classList.toggle('playing', status === 'viewing');
    if (btn && !it.mine) {
      btn.disabled = status !== 'ready' && status !== 'viewing';
      btn.innerHTML = status === 'viewing' ? STOP_ICO : status === 'opening' || status === 'receiving' ? '<span class="spin"></span>' : PLAY;
    }
    const map = {
      receiving: { text: t('media.receiving', { pct }), cls: '' },
      sending: { text: t('media.sending', { pct }), cls: '' },
      ready: { text: t('media.voicePlayOnce'), cls: '' },
      opening: { text: t('media.opening'), cls: '' },
      viewing: { text: t('media.voicePlaying'), cls: 'live' },
      sent: { text: t('media.voiceSent'), cls: '' },
      delivered: { text: many ? t('media.voiceDeliveredMany', { n: it.recvBy?.size ?? 0, total: it.total }) : t('media.voiceDeliveredOne'), cls: '' },
      partview: { text: t('media.voicePartview', { n: it.viewBy?.size ?? 0, total: it.total }), cls: '' },
      viewed: { text: many ? t('media.voiceViewedMany') : t('media.voiceViewedOne'), cls: 'ok' },
      undelivered: { text: t('media.undelivered'), cls: 'bad' },
      failed: { text: t('media.failed'), cls: 'bad' },
    };
    const info = map[status] || { text: '', cls: '' };
    tag.className = `v-tag ${info.cls}`;
    tag.textContent = info.text;
    return;
  }
  const over = it.el?.querySelector('.m-over');
  if (!over) return;
  const pill = (html, cls = '') => `<div class="m-pill ${cls}">${html}</div>`;
  const N = state.cfg.mview;
  const many = it.mine && it.total > 1; // 群聊多人接收时显示进度
  const views = {
    receiving: pill(`<span class="spin"></span>${esc(t('media.receiving', { pct }))}`),
    sending: pill(`<span class="spin"></span>${esc(t('media.sending', { pct }))}`),
    ready: `<button type="button" class="m-view">${it.mtype === 'video' ? PLAY : EYE}<span>${esc(it.mtype === 'video' ? t('media.playBtn', { n: N }) : t('media.viewBtn', { n: N }))}</span></button>`,
    opening: pill(`<span class="spin"></span>${esc(t('media.opening'))}`),
    viewing: '',
    sent: pill(esc(t('media.sent'))),
    delivered: pill(esc(many ? t('media.deliveredMany', { n: it.recvBy?.size ?? 0, total: it.total }) : t('media.deliveredOne'))),
    partview: pill(esc(t('media.partview', { n: it.viewBy?.size ?? 0, total: it.total }))),
    viewed: pill(esc(many ? t('media.viewedMany') : t('media.viewedOne')), 'ok'),
    undelivered: pill(esc(t('media.undelivered')), 'bad'),
    failed: pill(esc(t('media.failed')), 'bad'),
  };
  over.innerHTML = views[status] ?? '';
}

const inflightBytes = () => state.items.reduce((n, i) => n + (i.kind === 'media' && !i.mine && i.frames ? i.size : 0), 0);

function onMediaMeta(m, p, conv) {
  const mtype = m.mtype;
  if (mtype !== 'image' && mtype !== 'video' && mtype !== 'audio') return;
  const allowed = mtype === 'image' ? IMAGE_MIME : mtype === 'video' ? VIDEO_MIME : AUDIO_MIME;
  if (!allowed.includes(m.mime)) return;
  const limit = mtype === 'image' ? MAX_IMAGE_RAW : mtype === 'video' ? MAX_VIDEO : MAX_AUDIO;
  if (!Number.isInteger(m.size) || m.size <= 0 || m.size > limit) return;
  if (m.chunks !== Math.ceil(m.size / CHUNK)) return;
  if (!fresh(m)) return;
  if (inflightBytes() + m.size > MAX_INFLIGHT) { sys(esc(t('msg.sysSkipMedia'))); return; }
  const it = addItem({
    id: m.id, conv, kind: 'media', mine: false, cid: p.cid,
    mtype, mime: m.mime, size: m.size, chunks: m.chunks,
    w: Math.max(1, Math.min(10000, m.w | 0 || 16)), h: Math.max(1, Math.min(10000, m.h | 0 || 9)),
    dur: Math.max(0, Math.min(36000, Number(m.dur) || 0)),
    thumb: typeof m.thumb === 'string' && m.thumb.length < 16000 && THUMB_RE.test(m.thumb) ? m.thumb : '',
    peaks: mtype === 'audio' ? normalizePeaks(m.peaks) : null,
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

function mediaBlocker(cap = 'media') {
  if (state.boss) return t('toast.bossBusy');
  if (!state.serverMedia) return t('toast.oldServerMedia');
  const conv = state.active;
  const peer = convPeer(conv);
  if (peer) {
    const who = labelOf(peer).text;
    if (!peer.online) return t('toast.peerOfflineMedia', { who });
    if (!hasCap(peer, cap)) return t(cap === 'audio' ? 'toast.peerOldVoice' : 'toast.peerOldMedia', { who });
    if (!state.serverDirect) return t('toast.oldServerDmMedia');
    return null;
  }
  const others = onlineMembers();
  if (!others.length) return t('toast.nobodyOnlineMedia');
  const sep = getLang() === 'en' ? ', ' : '、';
  const old = others.filter((p) => !hasCap(p, cap)).map((p) => labelOf(p).text);
  if (old.length === others.length) return t(cap === 'audio' ? 'toast.peerOldVoice' : 'toast.peerOldMedia', { who: old.join(sep) });
  if (old.length) toast(t(cap === 'audio' ? 'toast.someOldVoice' : 'toast.someOldMedia', { names: old.join(sep) }));
  return null;
}

async function sendMedia(file) {
  const err = mediaBlocker('media');
  if (err) return toast(err);
  let prep;
  try { prep = await prepareFile(file); } catch (e) { return toast(e.message); }
  return sendPreparedMedia(prep, 'media');
}

async function sendPreparedMedia(prep, cap = 'media') {
  const conv = state.active;
  const peer = convPeer(conv);
  const { bytes } = prep;
  const ws = state.ws;
  const id = randomId();
  const total = Math.max(1, Math.ceil(bytes.length / CHUNK));
  const meta = {
    t: 'media', id, ts: Date.now(), mtype: prep.kind, mime: prep.mime,
    size: bytes.length, chunks: total, w: prep.w, h: prep.h, dur: Math.round(prep.dur || 0), thumb: prep.thumb || '',
    ...(prep.peaks ? { peaks: prep.peaks } : {}),
  };
  // 私聊：分块前加上目标连接 ID，服务器只转发给对方
  const conn = peer?.conn;
  const route = conn ? hexToBytes(conn) : null;
  if (!sendTo(conv, meta)) { bytes.fill(0); return toast(t('toast.notConnected')); }
  state.seen.add(id);
  const it = addItem({
    id, conv, kind: 'media', mine: true, ...meta, status: 'sending',
    ...recipients(conv, cap), recvBy: new Set(), viewBy: new Set(),
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

async function startVoiceRecording() {
  if (voiceRecorder.recording) return;
  const err = mediaBlocker('audio');
  if (err) return toast(err);
  // 若正在听语音，先静音并焚毁，避免录进外放声
  if (voicePlayer.playingId) {
    const prev = state.items.find((i) => i.id === voicePlayer.playingId);
    voicePlayer.stop();
    if (prev) burn(prev, true);
  }
  try {
    await voiceRecorder.start();
    setRecordingUI(true);
  } catch {
    voiceRecorder.cancel();
    setRecordingUI(false);
    toast(t('toast.voiceNoMic'));
  }
}

async function finishVoiceRecording(sendNow) {
  if (!voiceRecorder.recording) return;
  if (!sendNow) {
    voiceRecorder.cancel();
    setRecordingUI(false);
    $('#input').focus();
    return;
  }
  const prep = voiceRecorder.stop();
  setRecordingUI(false);
  $('#input').focus();
  if (!prep || prep.tooShort) {
    toast(t('toast.voiceTooShort'));
    return;
  }
  const err = mediaBlocker('audio');
  if (err) {
    prep.bytes.fill(0);
    return toast(err);
  }
  await sendPreparedMedia(prep, 'audio');
}

$('#voice-btn').onclick = () => startVoiceRecording();
$('#vr-cancel').onclick = () => finishVoiceRecording(false);
$('#vr-send').onclick = () => finishVoiceRecording(true);

async function viewMedia(it) {
  if (it.mtype === 'audio' && it.status === 'viewing') {
    // 单次播放：播放中再次点击 = 立即停止、清零内存并焚毁
    voicePlayer.stop(it.id);
    burn(it);
    return;
  }
  if (it.status !== 'ready' || !it.frames) return;
  if (it.mtype === 'audio' && voicePlayer.playingId && voicePlayer.playingId !== it.id) {
    const prev = state.items.find((i) => i.id === voicePlayer.playingId);
    voicePlayer.stop();
    if (prev) burn(prev, true);
  }
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

  if (it.mtype === 'audio') {
    try {
      setMediaStatus(it, 'viewing');
      const bars = [...(it.el.querySelectorAll('.v-bars i') || [])];
      const prog = it.el.querySelector('.v-prog i');
      const durEl = it.el.querySelector('.v-dur');
      await voicePlayer.play(it.id, plain, {
        onProgress: (frac, remain) => {
          if (!it.el) return;
          const lit = Math.ceil(frac * bars.length);
          for (let i = 0; i < bars.length; i++) bars[i].classList.toggle('on', i < lit);
          if (prog) prog.style.width = `${(frac * 100).toFixed(1)}%`;
          if (durEl) durEl.textContent = fmtDur(remain);
        },
        onEnded: () => {
          burn(it);
        },
      });
      // 兜底：防止音频事件异常导致长期残留
      it.capTimer = setTimeout(() => {
        voicePlayer.stop(it.id);
        burn(it);
      }, ((it.dur || 60) + 15) * 1000);
    } catch {
      plain.fill(0);
      setMediaStatus(it, 'failed');
      setTimeout(() => burn(it), 3000);
    }
    return;
  }

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
  if (it.mtype === 'audio') voicePlayer.stop(it.id);
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

// 点击：单条清除 / 查看附件 / 放大
$('#threads').addEventListener('mousedown', (e) => {
  if (e.target.closest('.msg-clear')) e.preventDefault();
});
$('#threads').addEventListener('click', (e) => {
  const clearBtn = e.target.closest('.msg-clear');
  if (clearBtn) {
    const row = clearBtn.closest('.item');
    const it = row && state.items.find((i) => i.id === row.dataset.id);
    if (it) dismissItem(it);
    else { row?.remove(); updateWipeBtn(); }
    return;
  }
  const card = e.target.closest('.item.media');
  if (!card) return;
  const it = state.items.find((i) => i.id === card.dataset.id);
  if (!it) return;
  if (e.target.closest('.m-view, .v-play')) viewMedia(it);
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
function toolLine(n) { const list = persona().tools; return list[n % list.length](n); }

// 侧栏名称自定义：prefs.recentNames[场景] = { others: [第 3～7 条的默认标题], names: { 序号: 自定义名称 } }
// 第一次改名时把随机生成的第 3～7 条固定下来，之后打开顺序不变。只存名称，不存口令指纹
function recentStore() { return (prefs.recentNames[prefs.persona] ||= { others: null, names: {} }); }

/* 私聊条目：默认名从任务池里按（会话指纹 + 对方名字）选一个。
 * 自定义名称存在 prefs.dmNames 里，键是指纹和名字的哈希：没有口令的人看不出是和谁的私聊 */
function dmKey(p) { return hashNum(`${state.session?.fingerprint || ''}\n${p.name}`).toString(36); }
function fakeCount(dmN) { return Math.max(3, 6 - dmN); } // 私聊多了就少显示几条假任务（含伪装页那条）
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
function dmList() {
  return [...state.members.values()]
    .filter((p) => (p.online && hasCap(p, 'dm')) || convItems(dmConv(p.cid)).length || state.active === dmConv(p.cid))
    .sort((a, b) => a.seq - b.seq);
}

function renderRecents() {
  if (document.querySelector('#recents li.editing')) return; // 正在改名，改完会重新渲染
  const names = prefs.recentNames[prefs.persona]?.names || {};
  const dms = dmList();
  const defs = dmDefaults(dms);
  const L = labels();
  const edit = `<b class="r-badge" hidden></b><button class="r-edit" title="${esc(t('side.rename'))}" tabindex="-1">✎</button>`;
  const row = (attrs, cls, name, extra = '') => `<li class="${cls}" ${attrs} title="${esc(t('side.dblclickRename'))}"><span class="r-name">${esc(name)}</span>${extra}${edit}</li>`;
  $('#recents').innerHTML = [
    row(`data-conv="${GROUP}" data-i="0"`, '', names[0] || recentDefaults[0]),
    ...dms.map((p) => {
      const l = L.get(p.cid);
      const tag = `<span class="r-tag" style="--c:${l.color}"><i></i>${esc(l.text)}</span>`;
      return row(`data-conv="${dmConv(p.cid)}" data-dm="${esc(p.cid)}"`, `dm${p.online ? '' : ' offline'}`, prefs.dmNames[dmKey(p)] || defs.get(p.cid), tag);
    }),
    ...recentDefaults.slice(1, 1 + fakeCount(dms.length)).map((tItem, j) =>
      row(`data-i="${j + 1}"`, 'fake', names[j + 1] || tItem, j === 1 ? '<span class="spin sm"></span>' : '')),
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
    el.innerHTML = `${whoHTML(peer, 'who')}${peer.online ? '' : `<span class="off">${esc(t('top.dmOffline'))}</span>`}`;
    el.title = t('top.dmTitle');
  } else {
    const on = onlineMembers().sort((a, b) => a.seq - b.seq);
    const shown = on.slice(0, 3).map((p) => whoHTML(p, 'who')).join('');
    el.innerHTML = on.length ? `${shown}${on.length > 3 ? `<span class="off">+${on.length - 3}</span>` : ''}` : `<span class="off">${esc(t('top.waitingPeers'))}</span>`;
    const sep = getLang() === 'en' ? ', ' : '、';
    el.title = on.length ? t('top.groupTitle', { n: on.length + 1, names: on.map((p) => labelOf(p).text).join(sep) }) : '';
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

function renderPersonaOptions() {
  $('#persona').innerHTML = Object.entries(PERSONAS)
    .map(([k, p]) => `<option value="${k}">${esc(personaLabel(p))}</option>`)
    .join('');
  $('#persona').value = prefs.persona in PERSONAS ? prefs.persona : 'dev';
}
renderPersonaOptions();
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
  toast(t('set.recentsResetToast'));
};

/* ---------------- 界面语言切换（默认中文，支持实时切换中 / 英） ---------------- */
function syncLangButtons() {
  const cur = getLang();
  document.querySelectorAll('#join-lang-seg button, #lang-seg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === cur);
  });
}
function applyLanguage(lang, persist = false) {
  setLang(lang);
  if (persist) {
    prefs.lang = getLang();
    savePrefs();
  }
  applyDomI18n();
  syncLangButtons();
  renderRememberTexts();
  renderKeysAndWipeUI();
  renderPersonaOptions();
  modelPicker.render();
  lan.renderUI();
  lan.syncServerOptions();
  renderUpdateBadges();
  if (!$('#upd-modal').hidden) renderUpdModal();
  if (state.entered) {
    $('#build-time').textContent = t('set.buildTime', { time: __BUILD_TIME__ });
    applyCfgUI();
    renderStatusText();
    renderHeader();
    renderRecents();
    renderActions();
    if (!pops.actions.hidden) updateActPreview();
    runner.refreshLang();
    for (const it of state.items) {
      if (it.mine && it.kind === 'msg') renderReceipt(it);
      if (it.kind === 'media' && it.status !== 'viewing') setMediaStatus(it, it.status, 0);
      const clr = it.el?.querySelector('.msg-clear');
      if (clr) clr.title = t('msg.clearTitle');
    }
    document.querySelectorAll('.compact').forEach((el) => { el.textContent = t('msg.compacted'); });
  } else if ($('#server').value.trim()) {
    checkServer($('#server').value.trim());
  }
}
document.querySelectorAll('#join-lang-seg button, #lang-seg button').forEach((b) => {
  b.onclick = () => applyLanguage(b.dataset.lang, true);
});

/* ================================================================
 *  版本检测与自动下载重启更新（GitHub Releases）
 * ================================================================ */
function formatNotes(md) {
  const lines = String(md || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('|---') && !l.startsWith('```'));
  if (!lines.length) return `<p class="muted">${esc(t('upd.defaultNotes'))}</p>`;
  return lines.slice(0, 40).map((line) => {
    const safe = esc(line).replace(/`([^`]+)`/g, '<code>$1</code>');
    if (/^#{1,3}\s+/.test(line)) return `<div class="upd-h">${safe.replace(/^#{1,3}\s+/, '')}</div>`;
    if (/^[-*]\s+/.test(line)) return `<div class="upd-li">• ${safe.replace(/^[-*]\s+/, '')}</div>`;
    return `<div class="upd-p">${safe}</div>`;
  }).join('');
}

function renderUpdateBadges() {
  const has = !!updState.info?.hasUpdate;
  const ver = updState.info?.latestVersion || '';
  const ready = updState.phase === 'ready';

  const joinBtn = $('#join-upd');
  joinBtn.hidden = !has;
  if (has) joinBtn.textContent = ready ? t('upd.joinRestart', { ver }) : t('upd.joinFound', { ver });

  const chip = $('#upd-chip');
  chip.hidden = !has || state.boss;
  chip.classList.toggle('ready', ready);
  if (has) chip.textContent = ready ? t('upd.chipRestart', { ver }) : t('upd.chipFound', { ver });

  const checkBtn = $('#check-upd-btn');
  checkBtn.disabled = updState.checking;
  checkBtn.textContent = updState.checking ? '…' : has ? `v${ver} ↑` : t('set.checkUpd');
  checkBtn.classList.toggle('upd-has', has);
}

function renderUpdModal() {
  const info = updState.info;
  if (!info) return;
  const sizeStr = info.assetSize ? ` · ${fmtSize(info.assetSize)}` : '';
  const modeHint = info.canAutoUpdate ? '' : t('upd.manualHint');
  $('#upd-ver').textContent = `v${APP_VERSION} → v${info.latestVersion}${sizeStr}${modeHint}`;
  $('#upd-notes').innerHTML = formatNotes(info.notes);

  const busy = updBusy();
  const ready = updState.phase === 'ready';
  $('#upd-prog').hidden = updState.phase === 'idle';
  if (updState.phase === 'downloading') {
    const dl = updState.total ? ` · ${fmtSize(updState.downloaded)} / ${fmtSize(updState.total)}` : '';
    $('#upd-phase').textContent = t('upd.downloading', { dl });
    $('#upd-pct').textContent = `${updState.pct}%`;
    $('#upd-bar-fill').style.width = `${updState.pct}%`;
  } else if (updState.phase === 'verifying') {
    $('#upd-phase').textContent = t('upd.verifying');
    $('#upd-pct').textContent = '100%';
    $('#upd-bar-fill').style.width = '100%';
  } else if (updState.phase === 'installing') {
    $('#upd-phase').textContent = t('upd.installing');
    $('#upd-pct').textContent = '100%';
    $('#upd-bar-fill').style.width = '100%';
  } else if (ready) {
    $('#upd-phase').textContent = t('upd.ready');
    $('#upd-pct').textContent = '✓';
    $('#upd-bar-fill').style.width = '100%';
  }

  const errEl = $('#upd-err');
  errEl.hidden = !updState.err;
  errEl.textContent = updState.err;

  $('#upd-cancel').textContent = busy ? t('upd.cancelDl') : t('upd.later');
  const act = $('#upd-act');
  act.disabled = busy;
  act.textContent = ready
    ? t('upd.actRestart')
    : busy
      ? t('upd.actBusy')
      : info.canAutoUpdate
        ? t('upd.actUpdate')
        : t('upd.actManual');
}

function openUpdModal() {
  if (!updState.info?.hasUpdate) return;
  closePops();
  renderUpdModal();
  $('#upd-modal').hidden = false;
}
function closeUpdModal() {
  $('#upd-modal').hidden = true;
}

async function checkForUpdate({ manual = false } = {}) {
  if (updState.checking || updBusy()) return;
  updState.checking = true;
  renderUpdateBadges();
  try {
    const info = await native.checkUpdate(APP_VERSION);
    updState.info = info;
    updState.err = '';
    renderUpdateBadges();
    if (manual) {
      if (info.hasUpdate) openUpdModal();
      else toast(t('toast.latestVer', { ver: APP_VERSION }));
    }
  } catch (err) {
    if (manual) {
      const msg = typeof err === 'string' ? err : err?.message || t('toast.checkUpdErr');
      if (state.entered) toast(msg);
      else showJoinError(msg);
    }
  } finally {
    updState.checking = false;
    renderUpdateBadges();
  }
}

async function doRestartForUpdate() {
  try {
    burnAll();
    native.mediaClear();
    state.session = null;
    state.ws?.close();
    await native.restartToUpdate();
  } catch (err) {
    updState.err = typeof err === 'string' ? err : err?.message || '自动重启失败，请手动重新打开应用';
    renderUpdModal();
  }
}

async function startAutoUpdate() {
  const info = updState.info;
  if (!info?.hasUpdate || updBusy()) return;
  if (updState.phase === 'ready') { await doRestartForUpdate(); return; }
  if (!info.canAutoUpdate) {
    native.openReleaseUrl(info.releaseUrl);
    closeUpdModal();
    return;
  }
  updState.err = '';
  updState.phase = 'downloading';
  updState.pct = 0;
  updState.downloaded = 0;
  updState.total = info.assetSize || 0;
  renderUpdModal();
  renderUpdateBadges();
  try {
    await native.installUpdate((ev) => {
      updState.phase = ev.phase;
      updState.downloaded = ev.downloaded || 0;
      updState.total = ev.total || info.assetSize || 0;
      updState.pct = ev.percent ?? 0;
      renderUpdModal();
      renderUpdateBadges();
    });
    updState.phase = 'ready';
    renderUpdModal();
    renderUpdateBadges();
    await sleep(350);
    await doRestartForUpdate();
  } catch (err) {
    const msg = typeof err === 'string' ? err : err?.message || '更新失败';
    updState.phase = 'idle';
    if (!msg.includes('取消')) updState.err = msg;
    renderUpdModal();
    renderUpdateBadges();
  }
}

$('#join-upd').onclick = openUpdModal;
$('#upd-chip').onclick = openUpdModal;
$('#check-upd-btn').onclick = () => checkForUpdate({ manual: true });
$('#upd-close').onclick = closeUpdModal;
$('#upd-gh').onclick = () => native.openReleaseUrl(updState.info?.releaseUrl || '');
$('#upd-cancel').onclick = () => {
  if (updBusy()) native.cancelUpdate();
  else closeUpdModal();
};
$('#upd-act').onclick = startAutoUpdate;
$('#upd-modal').addEventListener('mousedown', (e) => {
  if (e.target === $('#upd-modal') && !updBusy()) closeUpdModal();
});

// 所有 DOM 事件与状态初始化完毕后再统一渲染当前语言文案
applyLanguage(prefs.lang || DEFAULT_LANG, false);

// 启动后静默检测一次新版本，之后每 4 小时定期检测（断网/内网环境静默忽略，不弹报错）
setTimeout(() => checkForUpdate(), 2500);
setInterval(() => checkForUpdate(), 4 * 3600 * 1000);

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
