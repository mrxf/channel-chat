// 原生能力桥接：在 Tauri 中调用 Rust 命令；在浏览器中静默降级（便于调试）。
import { invoke } from '@tauri-apps/api/core';
import { sealLocal, openLocal } from './crypto.js';

const inTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
let notifyMod = null;
const loadNotify = async () => (notifyMod ??= await import('@tauri-apps/plugin-notification'));

const PREFS_KEY = 'agent.prefs.v1';

export const native = {
  inTauri,

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
      return { url: `vault://localhost/${token}`, close: () => invoke('media_drop', { token }).catch(() => {}) };
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

  /** Dock 角标 + 菜单栏数字 */
  setUnread(count) {
    if (inTauri) invoke('set_unread', { count }).catch(() => {});
  },

  /** Dock 图标跳动（窗口不在前台时） */
  /**
   * 会话口令：用本机硬件 UUID 派生的密钥加密后，存在应用配置目录里（浏览器版不保存）。
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

  attention() {
    if (inTauri) invoke('request_attention').catch(() => {});
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
};
