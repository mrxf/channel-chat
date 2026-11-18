// 后台通知与角标数字同步测试
import 'package:agent_mobile/chat/chat_controller.dart';
import 'package:agent_mobile/core/native.dart';
import 'package:agent_mobile/core/prefs.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('background notifications track unread count, silent throttling, burn, and resume clear', () async {
    SharedPreferences.setMockInitialValues({});
    final events = <String>[];
    Native.debugOnNotify = (body, count, silent) => events.add('notify:$count:${silent ? 'silent' : 'alert'}:$body');
    Native.debugOnClear = () => events.add('clear');
    addTearDown(() {
      Native.debugOnNotify = null;
      Native.debugOnClear = null;
    });

    final prefs = await Prefs.load();
    final chat = ChatController(prefs)..cid = 'fedcba9876543210';
    addTearDown(chat.dispose);

    final now = DateTime.now().millisecondsSinceEpoch;
    const peerConn = '010203040506';
    const peerCid = '0123456789abcdef';

    // 前台收到消息：不弹通知
    chat.debugInject(peerConn, {'t': 'msg', 'cid': peerCid, 'name': 'Alice', 'id': 'm0', 'text': 'hi', 'ts': now});
    expect(events, isEmpty);
    chat.wipeScreen();

    // 切到后台/锁屏
    chat.didChangeAppLifecycleState(AppLifecycleState.paused);
    events.clear();

    // 第一条消息：响铃提醒，count = 1
    chat.debugInject(peerConn, {'t': 'msg', 'cid': peerCid, 'name': 'Alice', 'id': 'm1', 'text': 'first', 'ts': now});
    expect(events, ['notify:1:alert:你有 1 条新消息，点击查看']);

    // 8 秒内连收群聊第二条 + 私聊一条：静默刷新锁屏文案与角标数（2 -> 3），不重复响铃
    chat.debugInject(peerConn, {'t': 'msg', 'cid': peerCid, 'name': 'Alice', 'id': 'm2', 'text': 'second', 'ts': now + 100});
    chat.debugInject(peerConn, {'t': 'action', 'cid': peerCid, 'dm': chat.cid, 'name': 'Alice', 'id': 'a1', 'prefix': '拍了拍', 'suffix': '肩膀', 'ts': now + 200});
    expect(events, [
      'notify:1:alert:你有 1 条新消息，点击查看',
      'notify:2:silent:你有 2 条新消息，点击查看',
      'notify:3:silent:你有 3 条新消息，点击查看',
    ]);

    // 后台期间对端清空群聊（burn）：剩余 1 条私聊未读，只发一次静默更新（不逐条抖动）
    events.clear();
    chat.debugInject(peerConn, {'t': 'burn', 'cid': peerCid, 'name': 'Alice'});
    expect(events, ['notify:1:silent:你有一条新的动态，点击查看']);

    // 对端再清空私聊：未读全部归零，自动清除锁屏通知与桌面角标
    events.clear();
    chat.debugInject(peerConn, {'t': 'burn', 'cid': peerCid, 'dm': chat.cid, 'name': 'Alice'});
    expect(events, ['clear']);

    // 单独收到拍一拍：_notifiedCount 已清零，count = 1 仍会补发通知与角标
    events.clear();
    chat.debugInject(peerConn, {'t': 'action', 'cid': peerCid, 'name': 'Alice', 'id': 'a2', 'prefix': '戳了戳', 'suffix': '', 'ts': now + 300});
    expect(events, ['notify:1:silent:你有一条新的动态，点击查看']);

    // 回到前台（解锁亮屏进入 App）：自动清除通知与角标
    events.clear();
    chat.didChangeAppLifecycleState(AppLifecycleState.resumed);
    expect(events, ['clear']);

    // 再次切后台收到消息后（回到前台已重置节流计时，新锁屏周期首条正常响铃），关闭「新消息通知」开关：立即清除通知与角标
    chat.wipeScreen();
    chat.didChangeAppLifecycleState(AppLifecycleState.paused);
    events.clear();
    chat.debugInject(peerConn, {'t': 'msg', 'cid': peerCid, 'name': 'Alice', 'id': 'm3', 'text': 'third', 'ts': now + 400});
    expect(events, ['notify:1:alert:你有 1 条新消息，点击查看']);
    events.clear();
    await prefs.setNotify(false);
    expect(events, ['clear']);
  });
}
