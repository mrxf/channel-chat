// 桌面端独立模块：局域网建房间（本机充当独立服务器 Host）与局域网雷达扫描（Scan）
// 把原本晦涩的「Host / Scan」按钮升级为普通用户一眼就能看懂的向导式卡片与设置行。
import { t } from './i18n.js';
import { DISCOVERY_PORT } from './config.js';

export function createLanModule({
  native,
  getServerInput,
  setServerInput,
  getDisplayName,
  checkServer,
  renderServerList,
  setServerHint,
  showJoinError,
  copyText,
  toast,
  isEntered,
  getWsHost,
  getServerName,
  onReconnectToLocal,
}) {
  let lanFound = []; // 局域网自动发现的其他人房间 [{ name, host, port }]
  let relayInfo = { running: false, name: '', port: 0, localAddr: '', shareAddr: '', addrs: [], clients: 0, rooms: 0 };
  let relayBusy = false;
  let scanning = false;
  let copiedFlashTimer = null;

  const $ = (s) => document.querySelector(s);
  const lanUrl = (f) => `${f.host}:${f.port}`;

  function isLocalRelayHost(hostPort) {
    if (!relayInfo.running || !hostPort) return false;
    return hostPort === relayInfo.localAddr || hostPort === `localhost:${relayInfo.port}` || relayInfo.addrs.includes(hostPort);
  }

  function renderUI() {
    // 1. 登录页独立连接向导模块
    const guide = $('#lan-guide');
    if (guide && native.canDiscover) {
      guide.hidden = false;
      const hostCard = $('#lan-host-card');
      const hostIdle = $('#lan-host-idle');
      const hostRunning = $('#lan-host-running');
      const hostBtn = $('#srv-host');
      const hostStopBtn = $('#srv-host-stop');
      const hostCopyBtn = $('#srv-host-copy');
      const hostAddrEl = $('#lan-share-addr');
      const scanBtn = $('#srv-scan');

      if (hostCard) hostCard.classList.toggle('active', relayInfo.running);
      if (hostIdle) hostIdle.hidden = relayInfo.running;
      if (hostRunning) hostRunning.hidden = !relayInfo.running;

      if (hostBtn) {
        hostBtn.disabled = relayBusy;
        hostBtn.textContent = relayBusy ? '…' : t('join.hostBtn');
      }
      if (hostStopBtn) {
        hostStopBtn.disabled = relayBusy;
        hostStopBtn.textContent = relayBusy ? '…' : t('join.hostStopBtn');
      }
      if (hostAddrEl && relayInfo.running) {
        hostAddrEl.textContent = relayInfo.shareAddr;
      }
      if (hostCopyBtn && !copiedFlashTimer) {
        hostCopyBtn.textContent = t('join.hostCopyBtn');
      }
      if (scanBtn) {
        scanBtn.disabled = scanning;
        scanBtn.textContent = scanning ? t('join.scanningBtn') : t('join.scanBtn');
      }
    }

    // 2. 设置弹窗里的「本机充当服务器」模块行
    const row = $('#relay-row');
    if (row && native.canHost) {
      row.hidden = false;
      const toggle = $('#relay-toggle');
      const sub = $('#relay-sub');
      const copyChip = $('#relay-copy-btn');
      if (toggle) {
        toggle.checked = relayInfo.running;
        toggle.disabled = relayBusy;
      }
      if (sub) {
        sub.textContent = relayInfo.running
          ? t('set.relaySubOn', { addr: relayInfo.shareAddr, clients: relayInfo.clients })
          : t('set.relaySubOff');
      }
      if (copyChip) {
        copyChip.hidden = !relayInfo.running;
        copyChip.textContent = t('set.relayCopy');
      }
    }

    // 3. 设置弹窗里的当前连接服务器展示
    const serverInfoEl = $('#server-info');
    if (serverInfoEl && isEntered()) {
      const curHost = getWsHost();
      if (curHost) {
        if (isLocalRelayHost(curHost)) {
          serverInfoEl.textContent = t('set.serverLocalTag', { addr: relayInfo.shareAddr });
          serverInfoEl.title = t('set.serverLocalTitle', { addr: relayInfo.shareAddr });
        } else {
          const sName = getServerName();
          serverInfoEl.textContent = sName ? `${sName} · ${curHost}` : curHost;
          serverInfoEl.title = '';
        }
      }
    }
  }

  function syncServerOptions() {
    const localOpt = relayInfo.running
      ? [{ url: relayInfo.localAddr, name: t('join.localServerOpt', { name: relayInfo.name || t('appName'), addr: relayInfo.shareAddr }) }]
      : [];
    const lanOpts = lanFound.map((f) => ({
      url: lanUrl(f),
      name: t('join.lanServerOpt', { name: String(f.name || 'relay').slice(0, 40) }),
    }));
    renderServerList([...localOpt, ...lanOpts]);
  }

  // force：当前地址为空 / 不可用 / 用户主动点了扫描时，直接填入发现的第一个
  function applyFound(list, force) {
    const seen = new Set();
    const others = (list || []).filter(
      (f) => f && typeof f.host === 'string' && !(relayInfo.running && relayInfo.addrs.includes(lanUrl(f))),
    );
    lanFound = others.filter((f) => !seen.has(lanUrl(f)) && seen.add(lanUrl(f)));
    syncServerOptions();
    if (!lanFound.length) return false;
    const cur = getServerInput();
    if (force && !lanFound.some((f) => lanUrl(f) === cur)) {
      setServerInput(lanUrl(lanFound[0]));
    }
    checkServer(getServerInput());
    return true;
  }

  async function refreshStatus(recheckJoin = false) {
    if (!native.canHost) return relayInfo;
    relayInfo = await native.relayStatus();
    renderUI();
    syncServerOptions();
    if (recheckJoin && !isEntered() && getServerInput()) {
      checkServer(getServerInput());
    }
    return relayInfo;
  }

  async function scanLan() {
    if (!native.canDiscover || scanning) return;
    scanning = true;
    renderUI();
    try {
      setServerHint(t('join.searchingLan'));
      let list = await native.discover(2000);
      if (!list.filter((f) => !(relayInfo.running && relayInfo.addrs.includes(lanUrl(f)))).length) {
        setServerHint(t('join.scanningSubnet', { port: DISCOVERY_PORT }));
        list = await native.scanSubnet(DISCOVERY_PORT);
      }
      if (!applyFound(list, true)) {
        if (relayInfo.running) checkServer(getServerInput());
        else setServerHint(t('join.scanNotFound'), 'bad');
      }
    } finally {
      scanning = false;
      renderUI();
    }
  }

  async function startHostFromJoin() {
    if (!native.canHost || relayBusy || relayInfo.running) return;
    relayBusy = true;
    renderUI();
    showJoinError('');
    try {
      const name = getDisplayName();
      relayInfo = await native.relayStart({ name });
      renderUI();
      applyFound(lanFound, false);
      setServerInput(relayInfo.localAddr);
      await checkServer(relayInfo.localAddr);
      if (!$('#name').value.trim()) $('#name').focus();
      else if (!$('#pass').value) $('#pass').focus();
      else $('#join-btn').focus();
    } catch (err) {
      const msg = typeof err === 'string' ? err : err?.message || t('toast.relayOpErr');
      setServerHint(msg, 'bad');
    } finally {
      relayBusy = false;
      renderUI();
    }
  }

  async function stopHostFromJoin(wasLocalCheck) {
    if (!native.canHost || relayBusy || !relayInfo.running) return;
    relayBusy = true;
    renderUI();
    showJoinError('');
    try {
      const wasLocal = wasLocalCheck ? wasLocalCheck(relayInfo) : false;
      relayInfo = await native.relayStop();
      renderUI();
      applyFound(lanFound, false);
      if (wasLocal) {
        setServerInput('');
        setServerHint(t('join.hostStopped'));
        const list = await native.discover(1000);
        applyFound(list, true);
      }
    } catch (err) {
      const msg = typeof err === 'string' ? err : err?.message || t('toast.relayOpErr');
      setServerHint(msg, 'bad');
    } finally {
      relayBusy = false;
      renderUI();
    }
  }

  async function setLocalRelayFromSettings(wantOn, { shouldSwitchSession }) {
    if (!native.canHost || relayBusy) return;
    relayBusy = true;
    renderUI();
    try {
      if (wantOn) {
        relayInfo = await native.relayStart({ name: getDisplayName() });
        renderUI();
        syncServerOptions();
        if (shouldSwitchSession?.()) {
          onReconnectToLocal?.(relayInfo.localAddr);
          toast(t('toast.relayStartedSwitch', { addr: relayInfo.shareAddr }));
        } else {
          toast(t('toast.relayStarted', { addr: relayInfo.shareAddr }));
        }
      } else {
        const curHost = getWsHost();
        const wasUsingLocal = curHost && isLocalRelayHost(curHost);
        relayInfo = await native.relayStop();
        renderUI();
        syncServerOptions();
        toast(wasUsingLocal ? t('toast.relayStoppedDisc') : t('toast.relayStopped'));
      }
    } catch (err) {
      toast(typeof err === 'string' ? err : err?.message || t('toast.relayOpErr'));
    } finally {
      relayBusy = false;
      renderUI();
    }
  }

  async function copyShareAddrFromJoin() {
    if (!relayInfo.running) return;
    const ok = await copyText(relayInfo.shareAddr);
    const btn = $('#srv-host-copy');
    if (ok && btn) {
      clearTimeout(copiedFlashTimer);
      btn.textContent = t('join.hostCopied');
      copiedFlashTimer = setTimeout(() => {
        copiedFlashTimer = null;
        renderUI();
      }, 1600);
    }
  }

  async function copyShareAddrWithToast() {
    if (!relayInfo.running) return;
    const ok = await copyText(relayInfo.shareAddr);
    toast(ok ? t('toast.shareCopied', { addr: relayInfo.shareAddr }) : relayInfo.shareAddr);
  }

  async function shareableAddr(fallbackHost) {
    if (native.canHost) {
      await refreshStatus();
      if (isLocalRelayHost(fallbackHost)) return relayInfo.shareAddr;
    }
    return fallbackHost;
  }

  async function hostCommand(shouldSwitchSession) {
    if (!native.canHost) {
      toast(t('toast.desktopOnlyHost'));
      return;
    }
    await refreshStatus();
    if (!relayInfo.running) await setLocalRelayFromSettings(true, { shouldSwitchSession });
    if (relayInfo.running) {
      const ok = await copyText(relayInfo.shareAddr);
      toast(
        ok
          ? t('toast.hostCmdCopied', { n: relayInfo.clients, addr: relayInfo.shareAddr })
          : t('toast.hostCmdAddr', { addr: relayInfo.shareAddr }),
      );
    }
  }

  function bindJoinEvents({ parseHostOfInput }) {
    if (!native.canDiscover) return false;
    $('#lan-guide').hidden = false;
    $('#srv-scan').onclick = scanLan;
    $('#srv-host').onclick = startHostFromJoin;
    $('#srv-host-stop').onclick = () => stopHostFromJoin(() => isLocalRelayHost(parseHostOfInput()));
    $('#srv-host-copy').onclick = copyShareAddrFromJoin;
    const relayCopyBtn = $('#relay-copy-btn');
    if (relayCopyBtn) relayCopyBtn.onclick = copyShareAddrWithToast;

    (async () => {
      await refreshStatus();
      const saved = getServerInput();
      if (!saved && relayInfo.running) {
        setServerInput(relayInfo.localAddr);
        await checkServer(relayInfo.localAddr);
        return;
      }
      if (!saved) setServerHint(t('join.searchingLan'));
      const [list, ok] = await Promise.all([native.discover(1500), saved ? checkServer(saved) : false]);
      if (!applyFound(list, !saved && !ok) && !saved) {
        setServerHint(t('join.autoNotFound'));
      }
    })();
    return true;
  }

  return {
    get relayInfo() { return relayInfo; },
    get lanFound() { return lanFound; },
    isLocalRelayHost,
    renderUI,
    syncServerOptions,
    refreshStatus,
    scanLan,
    setLocalRelayFromSettings,
    shareableAddr,
    hostCommand,
    bindJoinEvents,
  };
}
