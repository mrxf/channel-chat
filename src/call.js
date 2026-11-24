// 1 对 1 实时语音 / 视频通话引擎（基于浏览器原生 WebRTC，纯内存 DTLS-SRTP 加密）
// - 信令（offer / answer / ice / hangup / state）全部通过现有 E2EE 通道定向转发给对方，中继服务器不可见
// - 局域网默认零配置直连（不向第三方 STUN 泄露 IP）；支持用户在设置中可选配置自定义 STUN / TURN
// - 支持语音通话中动态开启/关闭视频摄像头（完美重协商），支持老板键瞬间静音、关摄像头并隐藏画面

const RING_TIMEOUT_MS = 35_000;
const CALL_ID_BYTES = 8;

function genCallId() {
  const b = new Uint8Array(CALL_ID_BYTES);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * 解析用户填写的 ICE 服务器列表（每行或逗号分隔一条）：
 *   stun:host:port
 *   turn:host:port|username|credential
 *   turns:host:port?transport=tcp|username|credential
 * 留空则返回 []（仅局域网直连，不访问任何外部 STUN）
 */
export function parseIceServers(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const out = [];
  const entries = raw.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  for (const line of entries.slice(0, 12)) {
    const parts = line.split('|').map((s) => s.trim());
    const urls = parts[0];
    if (!/^(stun|stuns|turn|turns):/i.test(urls)) continue;
    const item = { urls };
    if (parts[1]) item.username = parts[1];
    if (parts[2]) item.credential = parts[2];
    out.push(item);
  }
  return out;
}

/**
 * 创建 1v1 WebRTC 通话管理器
 * @param {{
 *   sendSignal: (peerCid: string, payload: object) => boolean,
 *   getIceServers: () => RTCIceServer[],
 *   onStateChange: (snapshot: object) => void,
 *   onRemoteStream: (stream: MediaStream | null) => void,
 *   onLocalStream: (stream: MediaStream | null) => void,
 *   onError?: (code: string, detail?: string) => void,
 *   onEnded?: (reason: string, peerCid: string | null, durationSec: number) => void,
 * }} opts
 */
export function createCallManager(opts) {
  let pc = null;
  let localStream = null;
  let remoteStream = null;
  let pendingIce = [];
  let ringTimer = null;
  let durTimer = null;
  let bossMutedBefore = null; // 记录老板键前状态，退出老板键后不自动开麦/开摄，但恢复远端音频静音状态

  // phase: 'idle' | 'calling' | 'ringing' | 'connecting' | 'connected'
  let st = {
    phase: 'idle',
    callId: null,
    peerCid: null,
    video: false,
    micOn: true,
    camOn: false,
    peerMicOn: true,
    peerCamOn: false,
    startedAt: 0,
    duration: 0,
    incomingOffer: null,
    bossHidden: false,
  };

  function snapshot() {
    return {
      phase: st.phase,
      callId: st.callId,
      peerCid: st.peerCid,
      video: st.video,
      micOn: st.micOn,
      camOn: st.camOn,
      peerMicOn: st.peerMicOn,
      peerCamOn: st.peerCamOn,
      duration: st.duration,
      bossHidden: st.bossHidden,
      active: st.phase !== 'idle',
    };
  }

  function emit() {
    opts.onStateChange?.(snapshot());
  }

  function clearTimers() {
    clearTimeout(ringTimer);
    ringTimer = null;
    clearInterval(durTimer);
    durTimer = null;
  }

  function startDurationTimer() {
    if (durTimer) return;
    st.startedAt = Date.now();
    st.duration = 0;
    durTimer = setInterval(() => {
      st.duration = Math.max(0, Math.floor((Date.now() - st.startedAt) / 1000));
      emit();
    }, 1000);
  }

  function stopLocalTracks() {
    if (!localStream) return;
    for (const track of localStream.getTracks()) {
      try { track.stop(); } catch { /* ignore */ }
    }
    localStream = null;
    opts.onLocalStream?.(null);
  }

  function cleanupInternal(reason = 'hangup', notifyEnd = true) {
    const prevPeer = st.peerCid;
    const prevPhase = st.phase;
    const prevDur = st.duration;
    clearTimers();
    pendingIce = [];
    bossMutedBefore = null;
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      try { pc.close(); } catch { /* ignore */ }
      pc = null;
    }
    stopLocalTracks();
    remoteStream = null;
    opts.onRemoteStream?.(null);
    st = {
      phase: 'idle',
      callId: null,
      peerCid: null,
      video: false,
      micOn: true,
      camOn: false,
      peerMicOn: true,
      peerCamOn: false,
      startedAt: 0,
      duration: 0,
      incomingOffer: null,
      bossHidden: false,
    };
    emit();
    if (notifyEnd && prevPhase !== 'idle') {
      opts.onEnded?.(reason, prevPeer, prevDur);
    }
  }

  async function acquireMedia(wantVideo) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
    }
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: wantVideo
        ? { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 24, max: 30 } }
        : false,
    };
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      const name = err?.name || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        throw Object.assign(err, { code: wantVideo ? 'perm_av' : 'perm_mic' });
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        throw Object.assign(err, { code: wantVideo ? 'no_device_av' : 'no_device_mic' });
      }
      throw Object.assign(err, { code: 'media_err' });
    }
  }

  function createPeerConnection(callId, peerCid) {
    const iceServers = opts.getIceServers?.() || [];
    const conn = new RTCPeerConnection({ iceServers });
    remoteStream = new MediaStream();

    conn.onicecandidate = (ev) => {
      if (!ev.candidate || st.callId !== callId) return;
      opts.sendSignal(peerCid, {
        t: 'call',
        callId,
        op: 'ice',
        cand: {
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
        },
      });
    };

    conn.ontrack = (ev) => {
      if (st.callId !== callId) return;
      if (ev.streams && ev.streams[0]) {
        remoteStream = ev.streams[0];
      } else if (ev.track) {
        remoteStream.addTrack(ev.track);
      }
      if (ev.track?.kind === 'video') {
        st.video = true;
        st.peerCamOn = true;
      }
      opts.onRemoteStream?.(remoteStream);
      emit();
    };

    const handleState = () => {
      if (st.callId !== callId) return;
      const cs = conn.connectionState || conn.iceConnectionState;
      if (cs === 'connected' || cs === 'completed') {
        clearTimeout(ringTimer);
        ringTimer = null;
        if (st.phase !== 'connected') {
          st.phase = 'connected';
          startDurationTimer();
          emit();
        }
      } else if (cs === 'failed') {
        opts.sendSignal(peerCid, { t: 'call', callId, op: 'hangup', reason: 'error' });
        cleanupInternal('error', true);
      } else if (cs === 'closed') {
        cleanupInternal('hangup', true);
      }
    };
    conn.onconnectionstatechange = handleState;
    conn.oniceconnectionstatechange = handleState;
    return conn;
  }

  async function flushPendingIce() {
    if (!pc || !pc.remoteDescription) return;
    const list = pendingIce;
    pendingIce = [];
    for (const c of list) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      } catch { /* ignore late/invalid candidate */ }
    }
  }

  async function startCall(peerCid, { video = false } = {}) {
    if (st.phase !== 'idle') return false;
    if (typeof RTCPeerConnection === 'undefined') {
      opts.onError?.('unsupported');
      return false;
    }
    const callId = genCallId();
    st = {
      phase: 'calling',
      callId,
      peerCid,
      video: !!video,
      micOn: true,
      camOn: !!video,
      peerMicOn: true,
      peerCamOn: !!video,
      startedAt: 0,
      duration: 0,
      incomingOffer: null,
      bossHidden: false,
    };
    emit();

    try {
      localStream = await acquireMedia(!!video);
    } catch (err) {
      cleanupInternal('error', false);
      opts.onError?.(err.code || 'media_err', err.message);
      return false;
    }
    if (st.callId !== callId) {
      stopLocalTracks();
      return false;
    }
    opts.onLocalStream?.(localStream);

    pc = createPeerConnection(callId, peerCid);
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (st.callId !== callId) return false;
      const sent = opts.sendSignal(peerCid, {
        t: 'call',
        callId,
        op: 'offer',
        video: !!video,
        sdp: offer.sdp,
      });
      if (!sent) {
        cleanupInternal('offline', false);
        opts.onError?.('offline');
        return false;
      }
      ringTimer = setTimeout(() => {
        if (st.callId === callId && st.phase === 'calling') {
          opts.sendSignal(peerCid, { t: 'call', callId, op: 'hangup', reason: 'timeout' });
          cleanupInternal('timeout', true);
        }
      }, RING_TIMEOUT_MS);
      return true;
    } catch (err) {
      cleanupInternal('error', false);
      opts.onError?.('webrtc_err', err.message);
      return false;
    }
  }

  async function acceptCall({ video = st.video } = {}) {
    if (st.phase !== 'ringing' || !st.incomingOffer) return false;
    const { callId, peerCid } = st;
    const offerSdp = st.incomingOffer;
    const wantVideo = !!video;
    st.phase = 'connecting';
    st.video = st.video || wantVideo;
    st.camOn = wantVideo;
    st.micOn = true;
    st.incomingOffer = null;
    clearTimeout(ringTimer);
    ringTimer = null;
    emit();

    try {
      localStream = await acquireMedia(wantVideo);
    } catch (err) {
      opts.sendSignal(peerCid, { t: 'call', callId, op: 'hangup', reason: 'error' });
      cleanupInternal('error', false);
      opts.onError?.(err.code || 'media_err', err.message);
      return false;
    }
    if (st.callId !== callId) {
      stopLocalTracks();
      return false;
    }
    opts.onLocalStream?.(localStream);

    pc = createPeerConnection(callId, peerCid);
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
      await flushPendingIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (st.callId !== callId) return false;
      opts.sendSignal(peerCid, {
        t: 'call',
        callId,
        op: 'answer',
        video: wantVideo,
        sdp: answer.sdp,
      });
      opts.sendSignal(peerCid, {
        t: 'call',
        callId,
        op: 'state',
        mic: st.micOn,
        cam: st.camOn,
      });
      return true;
    } catch (err) {
      opts.sendSignal(peerCid, { t: 'call', callId, op: 'hangup', reason: 'error' });
      cleanupInternal('error', false);
      opts.onError?.('webrtc_err', err.message);
      return false;
    }
  }

  function rejectCall() {
    if (st.phase !== 'ringing') return;
    opts.sendSignal(st.peerCid, { t: 'call', callId: st.callId, op: 'hangup', reason: 'reject' });
    cleanupInternal('reject', true);
  }

  function hangup(reason) {
    if (st.phase === 'idle') return;
    const r = reason || (st.phase === 'calling' ? 'cancel' : st.phase === 'ringing' ? 'reject' : 'hangup');
    if (st.peerCid && st.callId) {
      opts.sendSignal(st.peerCid, { t: 'call', callId: st.callId, op: 'hangup', reason: r });
    }
    cleanupInternal(r, true);
  }

  function setMic(on) {
    if (st.phase === 'idle' || !localStream) return;
    st.micOn = !!on;
    for (const t of localStream.getAudioTracks()) t.enabled = st.micOn;
    if (st.peerCid && st.callId) {
      opts.sendSignal(st.peerCid, { t: 'call', callId: st.callId, op: 'state', mic: st.micOn, cam: st.camOn });
    }
    emit();
  }

  function toggleMic() {
    setMic(!st.micOn);
  }

  async function toggleCam() {
    if (st.phase !== 'connected' && st.phase !== 'connecting') return;
    if (!localStream || !pc) return;
    const existing = localStream.getVideoTracks()[0];
    if (existing) {
      st.camOn = !st.camOn;
      existing.enabled = st.camOn;
      opts.sendSignal(st.peerCid, { t: 'call', callId: st.callId, op: 'state', mic: st.micOn, cam: st.camOn });
      emit();
      return;
    }
    // 语音通话中首次开启摄像头：获取视频轨并动态重协商
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 24, max: 30 } },
      });
      const vTrack = camStream.getVideoTracks()[0];
      if (!vTrack || !pc || st.phase === 'idle') {
        camStream.getTracks().forEach((t) => t.stop());
        return;
      }
      localStream.addTrack(vTrack);
      pc.addTrack(vTrack, localStream);
      st.video = true;
      st.camOn = true;
      opts.onLocalStream?.(localStream);
      emit();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      opts.sendSignal(st.peerCid, {
        t: 'call',
        callId: st.callId,
        op: 'offer',
        video: true,
        renegotiate: true,
        sdp: offer.sdp,
      });
      opts.sendSignal(st.peerCid, { t: 'call', callId: st.callId, op: 'state', mic: st.micOn, cam: true });
    } catch (err) {
      opts.onError?.(err?.name === 'NotAllowedError' ? 'perm_av' : 'no_device_av', err?.message);
    }
  }

  /** 老板键联动：瞬间静音麦克风 + 关闭摄像头 + 隐藏通话画面（不断线，退出老板键可自行恢复或挂断） */
  function setBossHidden(on) {
    if (st.phase === 'idle') return;
    st.bossHidden = !!on;
    if (on) {
      if (!bossMutedBefore) bossMutedBefore = { micOn: st.micOn, camOn: st.camOn };
      if (localStream) {
        for (const t of localStream.getAudioTracks()) t.enabled = false;
        for (const t of localStream.getVideoTracks()) t.enabled = false;
      }
      st.micOn = false;
      st.camOn = false;
      if (st.peerCid && st.callId) {
        opts.sendSignal(st.peerCid, { t: 'call', callId: st.callId, op: 'state', mic: false, cam: false });
      }
    } else {
      bossMutedBefore = null;
    }
    emit();
  }

  /** 处理收到的加密通话信令 */
  async function handleSignal(peerCid, m) {
    if (!m || typeof m.op !== 'string' || typeof m.callId !== 'string') return;
    const { op, callId } = m;

    if (op === 'offer') {
      if (typeof m.sdp !== 'string') return;
      // 重协商（通话中动态开启视频）
      if (m.renegotiate && st.callId === callId && st.peerCid === peerCid && pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: m.sdp }));
          await flushPendingIce();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          st.video = st.video || !!m.video;
          st.peerCamOn = !!m.video;
          opts.sendSignal(peerCid, {
            t: 'call',
            callId,
            op: 'answer',
            video: st.camOn,
            renegotiate: true,
            sdp: answer.sdp,
          });
          emit();
        } catch { /* ignore renegotiate error */ }
        return;
      }
      // 正在与其他人通话，回复忙线
      if (st.phase !== 'idle') {
        if (st.callId !== callId) {
          opts.sendSignal(peerCid, { t: 'call', callId, op: 'hangup', reason: 'busy' });
        }
        return;
      }
      st = {
        phase: 'ringing',
        callId,
        peerCid,
        video: !!m.video,
        micOn: true,
        camOn: false,
        peerMicOn: true,
        peerCamOn: !!m.video,
        startedAt: 0,
        duration: 0,
        incomingOffer: m.sdp,
        bossHidden: false,
      };
      pendingIce = [];
      ringTimer = setTimeout(() => {
        if (st.callId === callId && st.phase === 'ringing') {
          cleanupInternal('timeout', true);
        }
      }, RING_TIMEOUT_MS);
      emit();
      return;
    }

    if (st.callId !== callId || st.peerCid !== peerCid) return;

    if (op === 'answer') {
      if (typeof m.sdp !== 'string' || !pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: m.sdp }));
        await flushPendingIce();
        if (!m.renegotiate) {
          st.phase = 'connecting';
          st.peerCamOn = !!m.video;
          clearTimeout(ringTimer);
          ringTimer = null;
          emit();
        }
      } catch (err) {
        opts.onError?.('webrtc_err', err.message);
        hangup('error');
      }
      return;
    }

    if (op === 'ice') {
      const c = m.cand;
      if (!c || typeof c.candidate !== 'string') return;
      if (pc && pc.remoteDescription) {
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch { /* ignore */ }
      } else if (pendingIce.length < 120) {
        pendingIce.push(c);
      }
      return;
    }

    if (op === 'state') {
      if (typeof m.mic === 'boolean') st.peerMicOn = m.mic;
      if (typeof m.cam === 'boolean') {
        st.peerCamOn = m.cam;
        if (m.cam) st.video = true;
      }
      emit();
      return;
    }

    if (op === 'hangup') {
      cleanupInternal(typeof m.reason === 'string' ? m.reason : 'hangup', true);
    }
  }

  function onPeerOffline(peerCid) {
    if (st.phase !== 'idle' && st.peerCid === peerCid) {
      cleanupInternal('offline', true);
    }
  }

  function destroy() {
    if (st.phase !== 'idle') hangup('hangup');
    else cleanupInternal('hangup', false);
  }

  return {
    get state() { return snapshot(); },
    startCall,
    acceptCall,
    rejectCall,
    hangup,
    setMic,
    toggleMic,
    toggleCam,
    setBossHidden,
    handleSignal,
    onPeerOffline,
    destroy,
  };
}
