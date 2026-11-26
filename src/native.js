// 原生能力桥接：在 Tauri 中调用 Rust 命令；在浏览器中静默降级（便于调试）。
import { Channel, invoke } from '@tauri-apps/api/core';
import { sealLocal, openLocal } from './crypto.js';
import { GITHUB_REPO } from './config.js';

const inTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
// 自定义协议在 WebView2（Windows）上要写成 http://<scheme>.localhost/，macOS 上是 <scheme>://localhost/
const vaultUrl = (token) => (isWindows ? `http://vault.localhost/${token}` : `vault://localhost/${token}`);
let notifyMod = null;
const loadNotify = async () => (notifyMod ??= await import('@tauri-apps/plugin-notification'));

const PREFS_KEY = 'agent.prefs.v1';

export const native = {
  inTauri,
  isWindows,
  isMac: !isWindows && typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent),

  /** 偏好读写：Tauri 中存到应用配置目录（WebView 是无痕模式），浏览器中用 localStorage */
  async loadPrefs() {
    try {
      return JSON.parse(inTauri ? await invoke('prefs_load') : localStorage.getItem(PREFS_KEY) || '{}') || {};
    } catch {
      return {};
    }
  },
  savePrefs(obj) {
    const json = JSON.stringify(obj);
    if (inTauri) invoke('prefs_save', { json }).catch(() => {});
    else localStorage.setItem(PREFS_KEY, json);
  },

  /** 视频：明文交给 Rust 内存保险箱，返回可播放的地址；浏览器调试时退化为 blob URL */
  async mediaOpen(bytes, mime) {
    if (inTauri) {
      const token = await invoke('media_put', bytes, { headers: { 'x-mime': mime } });
      return { url: vaultUrl(token), close: () => invoke('media_drop', { token }).catch(() => {}) };
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    return { url, close: () => URL.revokeObjectURL(url) };
  },
  mediaClear() {
    if (inTauri) invoke('media_clear').catch(() => {});
  },

  /** 禁止截图 / 录屏捕获窗口内容 */
  async setContentProtected(on) {
    if (!inTauri) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setContentProtected(on);
    } catch { /* ignore */ }
  },

  /** Dock 角标 + 菜单栏数字（Windows：托盘图标悬停提示） */
  setUnread(count) {
    if (inTauri) invoke('set_unread', { count }).catch(() => {});
  },

  /** Dock 图标跳动（窗口不在前台时） */
  /**
   * 会话口令：用本机硬件 ID 派生的密钥加密后，存在应用配置目录里（浏览器版不保存）。
   * 不用系统钥匙串，所以不会弹授权窗口；文件拷到别的电脑上解不开。
   */
  canRemember: inTauri,
  async getSecret() {
    if (!inTauri) return null;
    try {
      const blob = await invoke('secret_get');
      if (!blob) return null;
      const value = openLocal(blob, await invoke('device_id'));
      if (value === null) invoke('secret_delete').catch(() => {}); // 换了电脑或文件损坏：直接作废
      return value;
    } catch { return null; }
  },
  async setSecret(value) {
    if (!inTauri) return false;
    try { await invoke('secret_set', { value: sealLocal(value, await invoke('device_id')) }); return true; } catch { return false; }
  },
  async deleteSecret() {
    if (!inTauri) return;
    try { await invoke('secret_delete'); } catch { /* ignore */ }
  },

  /** 局域网自动发现（Bonjour / mDNS），返回 [{ name, host, port }] */
  canDiscover: inTauri,
  async discover(timeoutMs = 1500) {
    if (!inTauri) return [];
    try { return await invoke('discover_servers', { timeoutMs }); } catch { return []; }
  },
  /** 兜底：在本机所在的 /24 网段里探测一个固定端口（只在用户点击时调用） */
  async scanSubnet(port) {
    if (!inTauri) return [];
    try { return await invoke('scan_subnet', { port }); } catch { return []; }
  },

  /** 内置局域网服务器（Host 模式）：在本机监听 10686..10700 并通过 mDNS 广播 */
  canHost: inTauri,
  async relayStart({ name = '', port = null } = {}) {
    if (!inTauri) throw new Error('浏览器模式不支持启动本机服务');
    return await invoke('relay_start', { name: name || null, port });
  },
  async relayStop() {
    const empty = { running: false, name: '', port: 0, localAddr: '', shareAddr: '', addrs: [], clients: 0, rooms: 0 };
    if (!inTauri) return empty;
    try { return await invoke('relay_stop'); } catch { return empty; }
  },
  async relayStatus() {
    const empty = { running: false, name: '', port: 0, localAddr: '', shareAddr: '', addrs: [], clients: 0, rooms: 0 };
    if (!inTauri) return empty;
    try { return await invoke('relay_status'); } catch { return empty; }
  },

  attention() {
    if (inTauri) invoke('request_attention').catch(() => {});
  },

  /** macOS 原生麦克风 / 摄像头权限请求（触发系统 TCC 弹窗，避免 WKWebView 静默拒权） */
  async requestMediaPermission(video = false) {
    if (!inTauri) return { audio: 'granted', video: video ? 'granted' : 'skipped' };
    try {
      return await invoke('request_media_permission', { video: !!video });
    } catch {
      return { audio: 'unknown', video: video ? 'unknown' : 'skipped' };
    }
  },

  async ensureNotifyPermission() {
    try {
      if (inTauri) {
        const n = await loadNotify();
        if (!(await n.isPermissionGranted())) return (await n.requestPermission()) === 'granted';
        return true;
      }
      if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
      return 'Notification' in window && Notification.permission === 'granted';
    } catch {
      return false;
    }
  },

  /** 系统通知：调用方保证不传入任何消息内容 */
  async notify(title, body) {
    try {
      if (inTauri) {
        const n = await loadNotify();
        if (await n.isPermissionGranted()) n.sendNotification({ title, body });
      } else if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body, silent: false });
      }
    } catch { /* ignore */ }
  },

  /** 检查 GitHub Releases 新版本；Tauri 走原生命令，浏览器调试走 fetch */
  async checkUpdate(currentVersion) {
    if (inTauri) return await invoke('update_check');
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (!r.ok) throw new Error('连接 GitHub Releases 失败');
    const rel = await r.json();
    const latest = String(rel.tag_name || '').trim().replace(/^[vV]/, '');
    const parse = (v) => v.split(/[-+]/)[0].split('.').map(Number);
    const [ca, cb, cc] = parse(currentVersion);
    const [la, lb, lc] = parse(latest);
    const hasUpdate = [la - ca, lb - cb, lc - cc].find((d) => d !== 0) > 0;
    return {
      currentVersion,
      latestVersion: latest,
      hasUpdate: !!hasUpdate,
      releaseUrl: rel.html_url || `https://github.com/${GITHUB_REPO}/releases/latest`,
      notes: rel.body || '',
      publishedAt: rel.published_at || '',
      assetName: null,
      assetSize: 0,
      canAutoUpdate: false,
    };
  },

  /** 自动下载、校验 SHA-256 并安装到就绪态，通过 Channel 实时回调进度 */
  async installUpdate(onProgress) {
    if (!inTauri) throw new Error('浏览器模式不支持自动更新');
    const onEvent = new Channel();
    onEvent.onmessage = (ev) => onProgress?.(ev);
    await invoke('update_install', { onEvent });
  },

  cancelUpdate() {
    if (inTauri) invoke('update_cancel').catch(() => {});
  },

  async restartToUpdate() {
    if (inTauri) await invoke('update_restart');
  },

  openReleaseUrl(url = '') {
    if (inTauri) invoke('update_open_url', { url }).catch(() => {});
    else window.open(url || `https://github.com/${GITHUB_REPO}/releases/latest`, '_blank', 'noopener,noreferrer');
  },
};
