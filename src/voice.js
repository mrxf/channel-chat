// 纯内存语音采集与单次播放引擎（零落盘、16kHz 16-bit mono WAV、与 Android 端 100% 互通）
// - 录音：getUserMedia → Web Audio 采集 Float32 PCM → 降采样到 16kHz → 内存编码为 WAV，取消或发送后立即清零缓冲
// - 播放：AudioContext.decodeAudioData 纯内存解码播放（不生成 blob URL、不进磁盘缓存），支持实时进度、单次播完即焚与老板键瞬间静音销毁

export const VOICE_SAMPLE_RATE = 16000;
export const MAX_VOICE_SEC = 60;
export const PEAK_COUNT = 28;

/** 将任意采样率的 Float32 单声道 PCM 线性降采样到 targetRate（默认 16kHz） */
function downsample(chunks, srcRate, targetRate = VOICE_SAMPLE_RATE) {
  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  if (!totalLen) return new Float32Array(0);

  if (srcRate === targetRate) {
    const merged = new Float32Array(totalLen);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    return merged;
  }

  const ratio = srcRate / targetRate;
  const outLen = Math.max(1, Math.floor(totalLen / ratio));
  const out = new Float32Array(outLen);

  // 合并源数组以便精准抗混叠均值采样，合并后由调用方清零
  const src = new Float32Array(totalLen);
  let off = 0;
  for (const c of chunks) {
    src.set(c, off);
    off += c.length;
  }

  let pos = 0;
  for (let i = 0; i < outLen; i++) {
    const next = Math.min(totalLen, Math.round((i + 1) * ratio));
    let sum = 0;
    let cnt = 0;
    for (let j = pos; j < next; j++) {
      sum += src[j];
      cnt++;
    }
    out[i] = cnt ? sum / cnt : src[Math.min(pos, totalLen - 1)];
    pos = next;
  }
  src.fill(0);
  return out;
}

/** 计算归一化波形峰值数组（0..100），用于未播放时的波形预览 */
export function computePeaks(samples, count = PEAK_COUNT) {
  if (!samples.length) return new Array(count).fill(8);
  const step = Math.max(1, Math.floor(samples.length / count));
  const raw = new Float32Array(count);
  let maxRms = 0.001;
  for (let i = 0; i < count; i++) {
    const start = i * step;
    const end = i === count - 1 ? samples.length : Math.min(samples.length, start + step);
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j] * samples[j];
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    raw[i] = rms;
    if (rms > maxRms) maxRms = rms;
  }
  const peaks = [];
  for (let i = 0; i < count; i++) {
    const norm = Math.min(1, raw[i] / maxRms);
    peaks.push(Math.max(8, Math.min(100, Math.round(norm * 92 + 8))));
  }
  return peaks;
}

/** 纯内存编码 16-bit mono PCM WAV */
export function encodeWav(samples, sampleRate = VOICE_SAMPLE_RATE) {
  const dataLen = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM format
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  v.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Uint8Array(buf);
}

/**
 * 纯内存麦克风录音器
 * @param {{ onTick?: (sec: number, level: number) => void, onAutoStop?: () => void }} opts
 */
export function createVoiceRecorder({ onTick, onAutoStop } = {}) {
  let active = false;
  let stream = null;
  let ctx = null;
  let source = null;
  let proc = null;
  let silentGain = null;
  let chunks = [];
  let srcRate = 48000;
  let startedAt = 0;
  let timer = null;
  let lastLevel = 0;

  const cleanup = () => {
    active = false;
    clearInterval(timer);
    timer = null;
    try { proc?.disconnect(); } catch { /* ignore */ }
    try { source?.disconnect(); } catch { /* ignore */ }
    try { silentGain?.disconnect(); } catch { /* ignore */ }
    proc = source = silentGain = null;
    if (stream) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
      stream = null;
    }
    if (ctx) {
      try { ctx.close(); } catch { /* ignore */ }
      ctx = null;
    }
  };

  const zeroChunks = () => {
    for (const c of chunks) c.fill(0);
    chunks = [];
  };

  return {
    get recording() { return active; },

    async start() {
      if (active) return;
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('NO_MIC_API');
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      ctx = new AudioCtx();
      if (ctx.state === 'suspended') await ctx.resume();
      srcRate = ctx.sampleRate || 48000;
      source = ctx.createMediaStreamSource(stream);
      // ScriptProcessorNode 在 WKWebView / WebView2 下最稳，且无需额外 worklet 文件路径
      proc = ctx.createScriptProcessor(4096, 1, 1);
      silentGain = ctx.createGain();
      silentGain.gain.value = 0;
      chunks = [];
      lastLevel = 0;
      active = true;
      startedAt = Date.now();

      proc.onaudioprocess = (ev) => {
        if (!active) return;
        const input = ev.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input.length);
        copy.set(input);
        chunks.push(copy);
        let sum = 0;
        for (let i = 0; i < input.length; i += 4) sum += input[i] * input[i];
        lastLevel = Math.min(1, Math.sqrt(sum / Math.max(1, input.length / 4)) * 3.5);
      };

      source.connect(proc);
      proc.connect(silentGain);
      silentGain.connect(ctx.destination);

      timer = setInterval(() => {
        if (!active) return;
        const sec = (Date.now() - startedAt) / 1000;
        onTick?.(sec, lastLevel);
        if (sec >= MAX_VOICE_SEC) {
          onAutoStop?.();
        }
      }, 100);
    },

    /** 停止录音并返回内存 WAV 字节与元数据，同时立即清零中间 PCM 缓冲 */
    stop() {
      if (!active) return null;
      const dur = Math.max(0.1, (Date.now() - startedAt) / 1000);
      const captured = chunks;
      chunks = [];
      cleanup();
      const pcm = downsample(captured, srcRate, VOICE_SAMPLE_RATE);
      for (const c of captured) c.fill(0);
      if (pcm.length < VOICE_SAMPLE_RATE * 0.4) {
        pcm.fill(0);
        return { tooShort: true };
      }
      const peaks = computePeaks(pcm, PEAK_COUNT);
      const bytes = encodeWav(pcm, VOICE_SAMPLE_RATE);
      pcm.fill(0);
      return {
        kind: 'audio',
        mime: 'audio/wav',
        bytes,
        w: 1,
        h: 1,
        dur: Math.max(1, Math.min(MAX_VOICE_SEC, Math.round(dur))),
        thumb: '',
        peaks,
      };
    },

    /** 取消录音（包括老板键触发）：立即关麦并清零全部缓冲 */
    cancel() {
      cleanup();
      zeroChunks();
    },
  };
}

/**
 * 纯内存单次语音播放器（AudioContext.decodeAudioData）
 * - 不生成任何 URL，不走磁盘缓存
 * - 播完或中断立即释放并清零 AudioBuffer 通道数据
 */
export function createVoicePlayer() {
  let ctx = null;
  let source = null;
  let audioBuf = null;
  let raf = 0;
  let startedAt = 0;
  let duration = 0;
  let activeId = null;
  let onEndCb = null;

  const zeroAudioBuffer = (buf) => {
    if (!buf) return;
    try {
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        buf.getChannelData(ch).fill(0);
      }
    } catch { /* ignore */ }
  };

  const stopInternal = (triggerEnd = false) => {
    cancelAnimationFrame(raf);
    raf = 0;
    const endCb = onEndCb;
    onEndCb = null;
    activeId = null;
    if (source) {
      source.onended = null;
      try { source.stop(); } catch { /* ignore */ }
      try { source.disconnect(); } catch { /* ignore */ }
      source = null;
    }
    if (audioBuf) {
      zeroAudioBuffer(audioBuf);
      audioBuf = null;
    }
    if (ctx) {
      try { ctx.close(); } catch { /* ignore */ }
      ctx = null;
    }
    if (triggerEnd && endCb) endCb();
  };

  return {
    get playingId() { return activeId; },

    /**
     * 解码并单次播放音频字节；调用后即清零传入的 Uint8Array
     * @param {string} id
     * @param {Uint8Array} bytes
     * @param {{ onProgress?: (frac: number, remainSec: number) => void, onEnded?: () => void }} cbs
     */
    async play(id, bytes, { onProgress, onEnded } = {}) {
      stopInternal(false);
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      ctx = new AudioCtx();
      if (ctx.state === 'suspended') await ctx.resume();

      // decodeAudioData 会 detach 传入的 ArrayBuffer，复制一份独立 buffer，原 bytes 立即清零
      const copy = bytes.slice().buffer;
      bytes.fill(0);

      let decoded;
      try {
        decoded = await ctx.decodeAudioData(copy);
      } catch (err) {
        stopInternal(false);
        throw err;
      } finally {
        try { new Uint8Array(copy).fill(0); } catch { /* detached */ }
      }

      if (!ctx) {
        zeroAudioBuffer(decoded);
        return;
      }

      audioBuf = decoded;
      duration = Math.max(0.1, decoded.duration || 0.1);
      activeId = id;
      onEndCb = onEnded || null;

      source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(ctx.destination);
      source.onended = () => {
        if (activeId === id) stopInternal(true);
      };

      startedAt = ctx.currentTime;
      source.start(0);

      const tick = () => {
        if (activeId !== id || !ctx) return;
        const elapsed = Math.max(0, ctx.currentTime - startedAt);
        const frac = Math.min(1, elapsed / duration);
        const remain = Math.max(0, Math.ceil(duration - elapsed));
        onProgress?.(frac, remain);
        if (frac < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    },

    /** 立即静音并销毁（手动停止、老板键、退出会话） */
    stop(id = null) {
      if (id && activeId !== id) return;
      stopInternal(false);
    },
  };
}
