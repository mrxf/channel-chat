import 'package:agent_mobile/core/call_engine.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('parseIceServers', () {
    test('returns empty list for blank input (LAN direct mode)', () {
      expect(parseIceServers(''), isEmpty);
      expect(parseIceServers('   \n  '), isEmpty);
    });

    test('parses stun and turn entries with optional credentials', () {
      const raw = '''
        stun:stun.example.com:3478
        turn:turn.example.com:3478|alice|secret123
        invalid://ignored.example.com
        turns:turn.example.com:5349?transport=tcp|bob|pw
      ''';
      final parsed = parseIceServers(raw);
      expect(parsed.length, 3);
      expect(parsed[0], {'urls': 'stun:stun.example.com:3478'});
      expect(parsed[1], {
        'urls': 'turn:turn.example.com:3478',
        'username': 'alice',
        'credential': 'secret123',
      });
      expect(parsed[2], {
        'urls': 'turns:turn.example.com:5349?transport=tcp',
        'username': 'bob',
        'credential': 'pw',
      });
    });
  });
}
