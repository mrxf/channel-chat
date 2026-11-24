// 附件预处理（发送方）：图片在本地重新编码（最长边 2048、去 EXIF/GPS）、生成 32px 缩略图；视频读取元数据。
// 以及视频播放用的内存回环服务器：解密后的视频只放在内存里，通过 127.0.0.1 随机地址交给播放器。
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:math';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_image_compress/flutter_image_compress.dart';
import 'package:image/image.dart' as img;
import 'package:video_player/video_player.dart';

import 'crypto.dart';

const maxVideo = 50 * 1024 * 1024;
const maxImageRaw = 40 * 1024 * 1024;
const maxAudio = 5 * 1024 * 1024;
const maxGif = 10 * 1024 * 1024;
const maxInflight = 300 * 1024 * 1024;
const imageMime = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const videoMime = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'];
const audioMime = ['audio/wav', 'audio/mp4', 'audio/webm', 'audio/ogg'];
const _extMime = {'mp4': 'video/mp4', 'm4v': 'video/x-m4v', 'mov': 'video/quicktime', 'webm': 'video/webm'};
const _imageMaxSide = 2048;
const _thumbSide = 32;

String fmtSize(int n) => n < 1024
    ? '$n B'
    : n < 1048576
        ? '${(n / 1024).toStringAsFixed(0)} KB'
        : '${(n / 1048576).toStringAsFixed(1)} MB';

String fmtDur(num s) => '${s ~/ 60}:${(s.round() % 60).toString().padLeft(2, '0')}';

class PreparedMedia {
  PreparedMedia({required this.kind, required this.mime, required this.bytes, required this.w, required this.h, this.dur = 0, this.thumb = '', this.peaks});
  final String kind; // image | video | audio
  final String mime;
  final Uint8List bytes;
  final int w, h;
  final num dur;
  final String thumb; // data:image/jpeg;base64,...（桌面端只接受这个格式）
  final List<int>? peaks;
}

class MediaError implements Exception {
  MediaError(this.message);
  final String message;
  @override
  String toString() => message;
}

Future<({int w, int h})> _dims(Uint8List bytes) async {
  final buf = await ui.ImmutableBuffer.fromUint8List(bytes);
  final desc = await ui.ImageDescriptor.encoded(buf);
  final r = (w: desc.width, h: desc.height);
  desc.dispose();
  buf.dispose();
  return r;
}

(int, int) _fit(int w, int h, int max) {
  final k = min(1.0, max / (w > h ? w : h));
  return (((w * k).round()).clamp(1, 1 << 30), ((h * k).round()).clamp(1, 1 << 30));
}

/// 32px 缩略图：解码时直接缩小，再编码成 JPEG data URL
Future<String> _thumb(Uint8List bytes, int w, int h) async {
  try {
    final (tw, th) = _fit(w, h, _thumbSide);
    final codec = await ui.instantiateImageCodec(bytes, targetWidth: tw, targetHeight: th);
    final frame = await codec.getNextFrame();
    final data = await frame.image.toByteData(format: ui.ImageByteFormat.rawRgba);
    final iw = frame.image.width, ih = frame.image.height;
    frame.image.dispose();
    codec.dispose();
    if (data == null) return '';
    final im = img.Image.fromBytes(width: iw, height: ih, bytes: data.buffer, numChannels: 4);
    return 'data:image/jpeg;base64,${base64Encode(img.encodeJpg(im, quality: 60))}';
  } catch (_) {
    return '';
  }
}

Future<PreparedMedia> prepareImage(Uint8List raw, {required bool isGif}) async {
  if (raw.length > maxImageRaw) throw MediaError('图片太大（上限 ${fmtSize(maxImageRaw)}）');
  final ({int w, int h}) d0;
  try {
    d0 = await _dims(raw);
  } catch (_) {
    throw MediaError('无法读取这张图片');
  }
  // GIF 保留动图原样发送；其他格式统一重新编码，顺便去掉 EXIF/GPS 等元数据
  if (isGif && raw.length <= maxGif) {
    return PreparedMedia(kind: 'image', mime: 'image/gif', bytes: raw, w: d0.w, h: d0.h, thumb: await _thumb(raw, d0.w, d0.h));
  }
  // flutter_image_compress 的缩放比例 = max(1, min(w/minW, h/minH))，minW = minH 时与方向无关
  final lo = min(d0.w, d0.h), hi = max(d0.w, d0.h);
  final m = hi > _imageMaxSide ? (lo * _imageMaxSide / hi).floor().clamp(1, _imageMaxSide) : lo;
  final out = await FlutterImageCompress.compressWithList(raw, minWidth: m, minHeight: m, quality: 86, format: CompressFormat.jpeg, keepExif: false);
  final d = await _dims(out);
  return PreparedMedia(kind: 'image', mime: 'image/jpeg', bytes: out, w: d.w, h: d.h, thumb: await _thumb(out, d.w, d.h));
}

Future<PreparedMedia> prepareVideo(File file) async {
  final ext = file.path.split('.').last.toLowerCase();
  final mime = _extMime[ext];
  if (mime == null) throw MediaError('只支持 mp4 / mov / webm 视频');
  final size = await file.length();
  if (size > maxVideo) throw MediaError('视频太大（上限 ${fmtSize(maxVideo)}）');
  var w = 16, h = 9;
  num dur = 0;
  final c = VideoPlayerController.file(file);
  try {
    await c.initialize().timeout(const Duration(seconds: 5));
    w = c.value.size.width.round().clamp(1, 10000);
    h = c.value.size.height.round().clamp(1, 10000);
    dur = c.value.duration.inMilliseconds / 1000;
  } catch (_) {
  } finally {
    await c.dispose();
  }
  return PreparedMedia(kind: 'video', mime: mime, bytes: await file.readAsBytes(), w: w, h: h, dur: dur.round());
}

/* ---------- 解密：放到后台 isolate，界面不卡 ---------- */

/// frames 全部解开并拼接；任一块失败返回 null
Future<Uint8List?> decryptFrames(Session s, List<Uint8List> frames, int size) {
  final key = Uint8List.fromList(s.key);
  final roomId = s.roomId, fp = s.fingerprint;
  return Isolate.run(() {
    final ss = Session(key: key, roomId: roomId, fingerprint: fp);
    final plain = Uint8List(size);
    var off = 0;
    for (final f in frames) {
      final pt = openChunk(ss, f, frames.length);
      if (pt == null || off + pt.length > size) {
        plain.fillRange(0, plain.length, 0);
        return null;
      }
      plain.setAll(off, pt);
      off += pt.length;
      pt.fillRange(0, pt.length, 0);
    }
    ss.destroy();
    return off == size ? plain : null;
  });
}

/* ---------- 内存视频服务器 ---------- */

class MemoryMediaServer {
  MemoryMediaServer._();
  static final instance = MemoryMediaServer._();

  HttpServer? _server;
  final Map<String, ({Uint8List bytes, String mime})> _blobs = {};

  Future<Uri> put(Uint8List bytes, String mime) async {
    _server ??= await _start();
    final token = randomId() + randomId();
    _blobs[token] = (bytes: bytes, mime: mime);
    return Uri.parse('http://127.0.0.1:${_server!.port}/$token');
  }

  void remove(Uri? url) {
    if (url == null) return;
    final b = _blobs.remove(url.pathSegments.isEmpty ? '' : url.pathSegments.first);
    b?.bytes.fillRange(0, b.bytes.length, 0);
  }

  void clear() {
    for (final b in _blobs.values) {
      b.bytes.fillRange(0, b.bytes.length, 0);
    }
    _blobs.clear();
  }

  Future<HttpServer> _start() async {
    final s = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    s.listen(_handle, onError: (_) {});
    return s;
  }

  Future<void> _handle(HttpRequest req) async {
    final res = req.response;
    try {
      if (req.connectionInfo?.remoteAddress.isLoopback != true) {
        res.statusCode = HttpStatus.forbidden;
        return;
      }
      final blob = _blobs[req.uri.pathSegments.isEmpty ? '' : req.uri.pathSegments.first];
      if (blob == null) {
        res.statusCode = HttpStatus.notFound;
        return;
      }
      final total = blob.bytes.length;
      var start = 0, end = total - 1;
      final range = req.headers.value(HttpHeaders.rangeHeader);
      res.headers
        ..contentType = ContentType.parse(blob.mime)
        ..set(HttpHeaders.acceptRangesHeader, 'bytes')
        ..set(HttpHeaders.cacheControlHeader, 'no-store');
      final m = range == null ? null : RegExp(r'bytes=(\d*)-(\d*)').firstMatch(range);
      if (m != null) {
        if (m[1]!.isNotEmpty) start = int.parse(m[1]!);
        if (m[2]!.isNotEmpty) end = min(int.parse(m[2]!), total - 1);
        if (m[1]!.isEmpty && m[2]!.isNotEmpty) {
          start = max(0, total - int.parse(m[2]!));
          end = total - 1;
        }
        if (start > end || start >= total) {
          res.statusCode = HttpStatus.requestedRangeNotSatisfiable;
          res.headers.set(HttpHeaders.contentRangeHeader, 'bytes */$total');
          return;
        }
        res.statusCode = HttpStatus.partialContent;
        res.headers.set(HttpHeaders.contentRangeHeader, 'bytes $start-$end/$total');
      }
      res.contentLength = end - start + 1;
      if (req.method != 'HEAD') res.add(Uint8List.sublistView(blob.bytes, start, end + 1));
    } catch (_) {
    } finally {
      try {
        await res.close();
      } catch (_) {}
    }
  }
}
