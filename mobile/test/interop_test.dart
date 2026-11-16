// 端到端互通：真实中继服务器（server/index.js）+ 桌面端协议对端（tool/peer.mjs）+ 手机端 ChatController
//   flutter test test/interop_test.dart
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:agent_mobile/chat/chat_controller.dart';
import 'package:agent_mobile/chat/models.dart';
import 'package:agent_mobile/core/media.dart';
import 'package:agent_mobile/core/prefs.dart';
import 'package:crypto/crypto.dart' as hash;
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart' hide group;
import 'package:shared_preferences/shared_preferences.dart';

Future<void> waitFor(bool Function() cond, String what, {Duration timeout = const Duration(seconds: 10)}) async {
  final end = DateTime.now().add(timeout);
  while (!cond()) {
    if (DateTime.now().isAfter(end)) fail('timeout waiting for $what');
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null; // 测试绑定默认拦截网络，这里需要真实连接

  late Process server, peer;
  final peerLog = <Map<String, dynamic>>[];
  final port = 18000 + Random().nextInt(1000);
  const pass = 'interop-test-key';

  setUpAll(() async {
    server = await Process.start('node', ['../server/index.js', '--port', '$port', '--no-discovery', '--quiet']);
    await Future<void>.delayed(const Duration(milliseconds: 800));
  });

  tearDownAll(() {
    peer.kill();
    server.kill();
  });

  test('desktop peer ↔ mobile controller', () async {
    SharedPreferences.setMockInitialValues({});
    final chat = ChatController(await Prefs.load());
    await chat.join(server: '127.0.0.1:$port', displayName: 'phone', pass: pass);
    expect(chat.conn, ConnState.online);

    peer = await Process.start('node', ['tool/peer.mjs', 'ws://127.0.0.1:$port/ws', pass]);
    peer.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((l) {
      try {
        peerLog.add(jsonDecode(l) as Map<String, dynamic>);
      } catch (_) {}
    });
    peer.stderr.transform(utf8.decoder).listen((e) => printOnFailure('peer stderr: $e'));

    // 对端加入 → 手机端看到成员（手机先进房间，所以由后来的对端沿用手机的设置）
    await waitFor(() => chat.onlineMembers.length == 1, 'member online');
    final desk = chat.onlineMembers.single;
    expect(desk.name, 'desk');
    expect(desk.hasCap('dm'), isTrue);
    await waitFor(() => peerLog.any((l) => l['t'] == 'hi' && l['cfg']?['keep'] == 1), 'phone replies hi with cfg');

    // 群聊 + 私聊 + 图片 + 拍一拍
    await waitFor(() => chat.convItems(group).any((i) => i.text == '来自桌面端的群聊消息'), 'group msg');
    final dm = dmConv(desk.cid);
    await waitFor(() => chat.convItems(dm).any((i) => i.text == '来自桌面端的私聊'), 'dm msg');
    await waitFor(() => chat.convItems(dm).any((i) => i.kind == ItemKind.action && i.action?.prefix == '拍了拍'), 'action');
    await waitFor(() => chat.convItems(group).any((i) => i.kind == ItemKind.media && i.status == MediaStatus.ready), 'image received');
    expect(peerLog.any((l) => l['t'] == 'mrecv'), isTrue, reason: '收齐分块后应回 mrecv');

    // 群聊消息停留够阅读时长后发回执
    final groupMsg = chat.convItems(group).firstWhere((i) => i.kind == ItemKind.msg);
    await waitFor(() => peerLog.any((l) => l['t'] == 'read' && (l['ids'] as List).contains(groupMsg.id)), 'read receipt', timeout: const Duration(seconds: 6));

    // 查看图片：解密结果与原图一致，并回 mview
    final img = chat.convItems(group).firstWhere((i) => i.kind == ItemKind.media);
    await chat.viewMedia(img);
    expect(img.status, MediaStatus.viewing);
    final sentSha = peerLog.firstWhere((l) => l['ev'] == 'sent-image')['sha'];
    expect(hash.sha256.convert(img.plain!).toString(), sentSha);
    await waitFor(() => peerLog.any((l) => l['t'] == 'mview' && l['id'] == img.id), 'mview');

    // 手机 → 桌面：群聊文字，桌面回执后变已读
    expect(chat.sendText('来自手机的消息'), isTrue);
    final mine = chat.items.lastWhere((i) => i.mine && i.kind == ItemKind.msg);
    await waitFor(() => peerLog.any((l) => l['t'] == 'msg' && l['text'] == '来自手机的消息' && l['dm'] == null), 'peer got group msg');
    await waitFor(() => chat.receiptDone(mine), 'my msg read');

    // 手机 → 桌面：私聊（带 dm 字段，服务器定向转发）
    chat.switchConv(dm);
    expect(chat.sendText('手机私聊'), isTrue);
    await waitFor(() => peerLog.any((l) => l['t'] == 'msg' && l['text'] == '手机私聊' && l['dm'] == desk.cid), 'peer got dm');

    // 手机 → 桌面：私聊附件（0x02 定向二进制帧，3 个分块）
    final bytes = Uint8List.fromList(List.generate(150 * 1024, (i) => (i * 7) & 255));
    final sha = hash.sha256.convert(bytes).toString();
    await chat.sendMedia(PreparedMedia(kind: 'image', mime: 'image/jpeg', bytes: Uint8List.fromList(bytes), w: 10, h: 10));
    await waitFor(() => peerLog.any((l) => l['ev'] == 'media-complete' && l['ok'] == true && l['sha'] == sha), 'peer decrypted media');
    final sentMedia = chat.items.lastWhere((i) => i.mine && i.kind == ItemKind.media);
    await waitFor(() => sentMedia.status == MediaStatus.viewed, 'media viewed status');

    // 设置同步：手机改设置 → 桌面收到 cfg
    chat.setCfg(ttl: 30);
    await waitFor(() => peerLog.any((l) => l['t'] == 'cfg' && l['ttl'] == 30), 'cfg broadcast');

    // 对端离开 → 成员离线
    peer.kill();
    await waitFor(() => chat.onlineMembers.isEmpty, 'peer left');

    // 前后台切换快速 Ping 探活：正常连接不被误断，且 2.5s 后恢复常规心跳
    chat.didChangeAppLifecycleState(AppLifecycleState.paused);
    chat.didChangeAppLifecycleState(AppLifecycleState.resumed);
    await Future<void>.delayed(const Duration(milliseconds: 2600));
    expect(chat.conn, ConnState.online);

    // 后台期间服务器强制断开（无 closeCode）并进入退避等待 → 回到前台应取消退避并立即重连
    chat.didChangeAppLifecycleState(AppLifecycleState.paused);
    server.kill();
    await server.exitCode;
    await waitFor(() => chat.conn == ConnState.reconnecting, 'disconnected in background');
    await Future<void>.delayed(const Duration(milliseconds: 1800)); // 让前两次重试失败，进入数秒退避期
    server = await Process.start('node', ['../server/index.js', '--port', '$port', '--no-discovery', '--quiet']);
    await Future<void>.delayed(const Duration(milliseconds: 400));
    expect(chat.conn, ConnState.reconnecting);
    chat.didChangeAppLifecycleState(AppLifecycleState.resumed);
    await waitFor(() => chat.conn == ConnState.online, 'instant reconnect on resume', timeout: const Duration(milliseconds: 1000));

    chat.leave();
    expect(chat.items, isEmpty);
    expect(chat.session, isNull);
  }, timeout: const Timeout(Duration(seconds: 60)));
}
