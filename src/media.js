// 附件预处理：图片重新编码（去 EXIF/GPS、限尺寸）、生成极小缩略图；视频读取元数据。
// 只处理发送方自己选择的文件；接收方的数据永远只在内存里。
export const CHUNK = 64 * 1024;
export const MAX_VIDEO = 50 * 1024 * 1024;
export const MAX_IMAGE_RAW = 40 * 1024 * 1024; // 原图读取上限（重新编码后会小很多）
export const MAX_AUDIO = 5 * 1024 * 1024;      // 语音上限（60s 16kHz WAV 约 1.9MB）
export const MAX_GIF = 10 * 1024 * 1024;
export const MAX_INFLIGHT = 300 * 1024 * 1024; // 接收方同时持有的附件总量上限
const IMAGE_MAX_SIDE = 2048;
const THUMB_SIDE = 32;

export const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
export const VIDEO_MIME = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'];
export const AUDIO_MIME = ['audio/wav', 'audio/mp4', 'audio/webm', 'audio/ogg'];
const EXT_MIME = { mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm' };

export const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function fit(w, h, max) {
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

function toBlob(canvas, type, q) {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('编码失败'))), type, q));
}

function thumbOf(source, w, h) {
  const [tw, th] = fit(w, h, THUMB_SIDE);
  const c = document.createElement('canvas');
  c.width = tw; c.height = th;
  c.getContext('2d').drawImage(source, 0, 0, tw, th);
  return c.toDataURL('image/jpeg', 0.6);
}

async function prepareImage(file) {
  if (file.size > MAX_IMAGE_RAW) throw new Error(`图片太大（上限 ${fmtSize(MAX_IMAGE_RAW)}）`);
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('无法读取这张图片'); }
  const { width: w0, height: h0 } = bmp;
  const thumb = thumbOf(bmp, w0, h0);

  // GIF 保留动图原样发送；其他格式统一重新编码，顺便去掉 EXIF/GPS 等元数据
  if (file.type === 'image/gif' && file.size <= MAX_GIF) {
    bmp.close();
    return { kind: 'image', mime: 'image/gif', bytes: new Uint8Array(await file.arrayBuffer()), w: w0, h: h0, thumb };
  }
  const [w, h] = fit(w0, h0, IMAGE_MAX_SIDE);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const blob = await toBlob(c, 'image/jpeg', 0.86);
  c.width = c.height = 0;
  return { kind: 'image', mime: 'image/jpeg', bytes: new Uint8Array(await blob.arrayBuffer()), w, h, thumb };
}

function videoMeta(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file); // 指向发送方自己的原文件，不产生新副本
    const v = document.createElement('video');
    v.muted = true; v.preload = 'metadata'; v.playsInline = true;
    let done = false;
    const finish = (meta) => { if (done) return; done = true; v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); resolve(meta); };
    setTimeout(() => finish({ w: v.videoWidth || 16, h: v.videoHeight || 9, dur: v.duration || 0, thumb: '' }), 4000);
    v.onloadedmetadata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); };
    v.onseeked = () => {
      let thumb = '';
      try { thumb = thumbOf(v, v.videoWidth, v.videoHeight); } catch { /* ignore */ }
      finish({ w: v.videoWidth, h: v.videoHeight, dur: v.duration, thumb });
    };
    v.onerror = () => finish({ w: 16, h: 9, dur: 0, thumb: '' });
    v.src = url;
  });
}

async function prepareVideo(file) {
  const mime = VIDEO_MIME.includes(file.type) ? file.type : EXT_MIME[file.name.split('.').pop()?.toLowerCase()];
  if (!mime) throw new Error('只支持 mp4 / mov / webm 视频');
  if (file.size > MAX_VIDEO) throw new Error(`视频太大（上限 ${fmtSize(MAX_VIDEO)}）`);
  const meta = await videoMeta(file);
  return { kind: 'video', mime, bytes: new Uint8Array(await file.arrayBuffer()), ...meta };
}

export async function prepareFile(file) {
  if (file.type.startsWith('image/')) return prepareImage(file);
  if (file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm)$/i.test(file.name)) return prepareVideo(file);
  throw new Error('只支持图片和视频');
}
