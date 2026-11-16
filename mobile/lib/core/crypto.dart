// 端到端加密，与桌面端 src/crypto.js（@noble）逐字节兼容：
//   口令 → scrypt(N=2^15, r=8, p=1) → HKDF-SHA256 派生 (加密密钥, 房间 ID, 指纹)
//   消息：XChaCha20-Poly1305，AAD = 房间 ID，明文按 256 字节补空格，输出 base64(nonce ‖ 密文 ‖ tag)
//   附件分块：[版本 1B][附件 ID 8B][块序号 u32 BE][nonce 24B][密文]，AAD = 房间 ID ‖ 帧头 ‖ 总块数
import 'dart:convert';
import 'dart:isolate';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:cryptography/dart.dart';
import 'package:pointycastle/export.dart' as pc;
import 'package:unorm_dart/unorm_dart.dart' as unorm;

final _rng = Random.secure();
const _aead = DartXchacha20.poly1305Aead();
const _pad = 256;

Uint8List randomBytes(int n) {
  final out = Uint8List(n);
  for (var i = 0; i < n; i++) {
    out[i] = _rng.nextInt(256);
  }
  return out;
}

String toHex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Uint8List fromHex(String hex) {
  final out = Uint8List(hex.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

String randomId() => toHex(randomBytes(8));

class Session {
  Session({required this.key, required this.roomId, required this.fingerprint})
      : _secret = SecretKeyData(key),
        _roomAad = Uint8List.fromList(utf8.encode(roomId));

  final Uint8List key;
  final String roomId;
  final String fingerprint;
  final SecretKeyData _secret;
  final Uint8List _roomAad;

  void destroy() => key.fillRange(0, key.length, 0);
}

Uint8List _hmac(Uint8List key, Uint8List data) {
  final mac = pc.HMac(pc.SHA256Digest(), 64)..init(pc.KeyParameter(key));
  return mac.process(data);
}

/// RFC 5869 HKDF-SHA256；salt 为空时等同 32 字节 0（与 noble 一致）
Uint8List hkdf(Uint8List ikm, String info, int length, {Uint8List? salt}) {
  final prk = _hmac(salt ?? Uint8List(32), ikm);
  final infoBytes = utf8.encode(info);
  final out = BytesBuilder();
  var t = Uint8List(0);
  for (var i = 1; out.length < length; i++) {
    t = _hmac(prk, Uint8List.fromList([...t, ...infoBytes, i]));
    out.add(t);
  }
  return Uint8List.fromList(out.takeBytes().sublist(0, length));
}

Map<String, String> _derive(String passphrase) {
  final pass = Uint8List.fromList(utf8.encode(unorm.nfkc(passphrase)));
  final scrypt = pc.Scrypt()
    ..init(pc.ScryptParameters(1 << 15, 8, 1, 32, Uint8List.fromList(utf8.encode('lan-burn-chat/v1'))));
  final master = scrypt.process(pass);
  final result = {
    'key': toHex(hkdf(master, 'enc', 32)),
    'roomId': toHex(hkdf(master, 'room', 32)),
    'fingerprint': toHex(hkdf(master, 'fingerprint', 4)),
  };
  master.fillRange(0, master.length, 0);
  pass.fillRange(0, pass.length, 0);
  return result;
}

/// scrypt 比较耗时（约 1 秒），放到后台 isolate，界面不卡
Future<Session> deriveSession(String passphrase) async {
  final r = await Isolate.run(() => _derive(passphrase));
  return Session(key: fromHex(r['key']!), roomId: r['roomId']!, fingerprint: r['fingerprint']!);
}

Session deriveSessionSync(String passphrase) {
  final r = _derive(passphrase);
  return Session(key: fromHex(r['key']!), roomId: r['roomId']!, fingerprint: r['fingerprint']!);
}

Uint8List _encrypt(Session s, Uint8List nonce, List<int> plain, List<int> aad) {
  final box = _aead.encryptSync(plain, secretKey: s._secret, nonce: nonce, aad: aad);
  final out = Uint8List(24 + box.cipherText.length + 16);
  out.setAll(0, nonce);
  out.setAll(24, box.cipherText);
  out.setAll(24 + box.cipherText.length, box.mac.bytes);
  return out;
}

/// 输入 nonce ‖ 密文 ‖ tag，失败返回 null
Uint8List? _decrypt(Session s, Uint8List buf, List<int> aad) {
  if (buf.length < 24 + 16) return null;
  try {
    final box = SecretBox(
      Uint8List.sublistView(buf, 24, buf.length - 16),
      nonce: Uint8List.sublistView(buf, 0, 24),
      mac: Mac(Uint8List.sublistView(buf, buf.length - 16)),
    );
    final pt = _aead.decryptSync(box, secretKey: s._secret, aad: aad);
    return pt is Uint8List ? pt : Uint8List.fromList(pt);
  } catch (_) {
    return null;
  }
}

String seal(Session s, Map<String, dynamic> obj) {
  final raw = utf8.encode(jsonEncode(obj));
  final padded = Uint8List(((raw.length + 1) / _pad).ceil() * _pad);
  padded.fillRange(0, padded.length, 0x20);
  padded.setAll(0, raw);
  return base64Encode(_encrypt(s, randomBytes(24), padded, s._roomAad));
}

Map<String, dynamic>? open(Session s, String data) {
  try {
    final pt = _decrypt(s, base64Decode(data), s._roomAad);
    if (pt == null) return null;
    final v = jsonDecode(utf8.decode(pt));
    return v is Map<String, dynamic> ? v : null;
  } catch (_) {
    return null;
  }
}

/* ---------- 口令生成：4 组 × 4 位，去掉易混淆字符 ---------- */
const _keyAlphabet = 'abcdefghjkmnpqrstuvwxyz23456789';

String generateKey({int groups = 4, int size = 4}) {
  final groupsOut = <String>[];
  for (var g = 0; g < groups; g++) {
    final sb = StringBuffer();
    for (var i = 0; i < size; i++) {
      sb.write(_keyAlphabet[_rng.nextInt(_keyAlphabet.length)]);
    }
    groupsOut.add(sb.toString());
  }
  return groupsOut.join('-');
}

/* ---------- 附件分块 ---------- */
const chunkVer = 1;
const chunkHead = 13;
const chunkSize = 64 * 1024;
const chunkOverhead = chunkHead + 24 + 16;

Uint8List _chunkAad(Session s, Uint8List header, int total) {
  final aad = Uint8List(s._roomAad.length + chunkHead + 4);
  aad.setAll(0, s._roomAad);
  aad.setAll(s._roomAad.length, header);
  ByteData.sublistView(aad).setUint32(s._roomAad.length + chunkHead, total);
  return aad;
}

Uint8List sealChunk(Session s, String idHex, int index, int total, Uint8List plain) {
  final header = Uint8List(chunkHead);
  header[0] = chunkVer;
  header.setAll(1, fromHex(idHex));
  ByteData.sublistView(header).setUint32(9, index);
  final body = _encrypt(s, randomBytes(24), plain, _chunkAad(s, header, total));
  return Uint8List(chunkHead + body.length)
    ..setAll(0, header)
    ..setAll(chunkHead, body);
}

/// 只读明文帧头用于路由，不解密
({String id, int index})? chunkHeader(Uint8List frame) {
  if (frame.length < chunkOverhead || frame[0] != chunkVer) return null;
  return (id: toHex(frame.sublist(1, 9)), index: ByteData.sublistView(frame).getUint32(9));
}

Uint8List? openChunk(Session s, Uint8List frame, int total) {
  if (frame.length < chunkOverhead) return null;
  final header = Uint8List.sublistView(frame, 0, chunkHead);
  return _decrypt(s, Uint8List.sublistView(frame, chunkHead), _chunkAad(s, header, total));
}
