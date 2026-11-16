// 与桌面端 crypto.js 的交叉验证（向量由 tool/gen_vectors.mjs 生成）
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:agent_mobile/core/crypto.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final vectors = (jsonDecode(File('test/vectors.json').readAsStringSync()) as List).cast<Map<String, dynamic>>();

  for (final v in vectors) {
    test('derive + open + chunk: ${v['pass']}', () {
      final sw = Stopwatch()..start();
      final s = deriveSessionSync(v['pass']);
      // ignore: avoid_print
      print('scrypt ${sw.elapsedMilliseconds}ms');
      expect(toHex(s.key), v['key']);
      expect(s.roomId, v['roomId']);
      expect(s.fingerprint, v['fingerprint']);

      final m = open(s, v['sealed'])!;
      expect(m['text'], '你好 hello');
      expect(m['id'], '0123456789abcdef');

      // 自己加密 → 自己解开，长度按 256 对齐
      final sealed = seal(s, {'t': 'msg', 'text': 'x' * 300});
      expect(base64Decode(sealed).length, 24 + 512 + 16);
      expect(open(s, sealed)!['text'], 'x' * 300);

      final frame = Uint8List.fromList(base64Decode(v['chunk']));
      final h = chunkHeader(frame)!;
      expect(h.id, '0011223344556677');
      expect(h.index, 3);
      final pt = openChunk(s, frame, 9)!;
      expect(pt.length, 1000);
      expect(pt[999], 999 & 255);
      expect(openChunk(s, frame, 8), isNull); // 总块数不同 → 解密失败

      final mine = sealChunk(s, 'aabbccddeeff0011', 0, 1, Uint8List.fromList([1, 2, 3]));
      expect(openChunk(s, mine, 1), [1, 2, 3]);
    });
  }

  test('generateKey format', () {
    expect(RegExp(r'^[a-z2-9]{4}(-[a-z2-9]{4}){3}$').hasMatch(generateKey()), isTrue);
  });

  test('chunk throughput', () {
    final s = deriveSessionSync('abcd');
    final data = Uint8List(chunkSize);
    final sw = Stopwatch()..start();
    for (var i = 0; i < 32; i++) {
      final f = sealChunk(s, 'aabbccddeeff0011', i, 32, data);
      openChunk(s, f, 32);
    }
    // ignore: avoid_print
    print('2MB seal+open ${sw.elapsedMilliseconds}ms');
  });
}
