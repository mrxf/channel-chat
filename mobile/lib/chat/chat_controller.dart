// 聊天协议核心：移植自桌面端 src/main.js，协议完全兼容（同一个房间里桌面端和手机端可以互聊）。
//   - 成员与服务器分配的连接 ID 绑定，别人不能冒用身份
//   - 群聊广播；私聊只发给对方连接，并在密文里标明收件人
//   - 已读：正在看这个会话、App 在前台、停留够阅读时长才算已读，并发回执
//   - 焚毁：只保留最近 N 轮；已读后可倒计时焚毁；未读消息不焚毁
//   - 附件：元数据走加密文本帧，内容 64KB 分块加密走二进制帧；接收方点查看才解密
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:video_player/video_player.dart';

import '../core/crypto.dart';
import '../core/media.dart';
import '../core/native.dart';
import '../core/net.dart';
import '../core/prefs.dart';
import '../core/version.dart';
import 'models.dart';

const _caps = ['media', 'dm'];
const _maxSkew = Duration(minutes: 10);
const _tick = 250;
const _actionTtl = 20;
const _maxActionLen = 200;
final _cidRe = RegExp(r'^[a-f0-9]{16}$');
final _thumbRe = RegExp(r'^data:image/jpeg;base64,[A-Za-z0-9+/=]+$');

enum ConnState { idle, connecting, online, reconnecting }

class ChatController extends ChangeNotifier with WidgetsBindingObserver {
  ChatController(this.prefs) {
    WidgetsBinding.instance.addObserver(this);
  }

  final Prefs prefs;

  // 会话
  String name = '';
  String cid = '';
  Session? session;
  Uri? wsUrl;
  String serverName = '';
  WebSocket? _ws;
  String? myId;
  bool entered = false;
  ConnState conn = ConnState.idle;
  int online = 1;
  RoomCfg cfg = const RoomCfg();
  bool _cfgTouched = false;
  bool serverMedia = false;
  bool serverDirect = false;
  List<ActionDef> serverActions = const [];
  String active = group;

  final Map<String, Member> members = {};
  final Map<String, String> _conns = {}; // 连接 ID → cid
  final List<ChatItem> items = [];
  final Map<String, List<Entry>> _timeline = {};
  final Set<String> _seen = {};
  final Map<String, ChatItem> _incoming = {};
  final Set<String> _compacted = {};
  final Map<String, List<String>> _receipts = {};
  final Map<String, List<String>> _acked = {};
  int _memberSeq = 0;
  int _retry = 0;
  int _gen = 0;
  Timer? _reconnectTimer;
  Timer? _ticker;
  Timer? _mediaWatch;
  Completer<void>? _joined;
  DateTime _lastAction = DateTime.fromMillisecondsSinceEpoch(0);
  DateTime _lastNotify = DateTime.fromMillisecondsSinceEpoch(0);
  bool _foreground = true;

  final _toasts = StreamController<String>.broadcast();
  final _nudges = StreamController<void>.broadcast();
  Stream<String> get toasts => _toasts.stream;
  Stream<void> get nudges => _nudges.stream;
  void toast(String t) => _toasts.add(t);

  bool get isReading => entered && _foreground;

  /* ================================================================
   *  进入 / 离开
   * ================================================================ */

  Future<void> join({required String server, required String displayName, required String pass}) async {
    final url = toWsUrl(server);
    name = displayName;
    cid = randomId();
    wsUrl = url;
    session = await deriveSession(pass);
    try {
      await _open(first: true);
    } catch (e) {
      session?.destroy();
      session = null;
      final ws = _ws;
      _ws = null;
      await ws?.close();
      conn = ConnState.idle;
      rethrow;
    }
    entered = true;
    _ticker = Timer.periodic(const Duration(milliseconds: _tick), (_) => _readTick());
    _mediaWatch = Timer.periodic(const Duration(seconds: 5), (_) => _checkStalled());
    notifyListeners();
  }

  void leave() {
    final ws = _ws;
    _burnAll();
    _gen++;
    _reconnectTimer?.cancel();
    _ticker?.cancel();
    _mediaWatch?.cancel();
    session?.destroy();
    session = null;
    _ws = null;
    entered = false;
    conn = ConnState.idle;
    _cfgTouched = false;
    active = group;
    cfg = const RoomCfg();
    items.clear();
    for (final c in [members, _conns, _incoming, _receipts, _acked, _timeline]) {
      c.clear();
    }
    _seen.clear();
    _compacted.clear();
    MemoryMediaServer.instance.clear();
    Native.clearNotifications();
    ws?.close();
    notifyListeners();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (_foreground) {
      Native.clearNotifications();
      // 回到前台时连接已断开：立即重连，不等退避
      if (entered && session != null && (_ws == null || _ws!.closeCode != null)) {
        _retry = 0;
        _reconnectTimer?.cancel();
        _open(first: false).catchError((_) {});
      }
    }
    notifyListeners();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    leave();
    super.dispose();
  }

  /* ================================================================
   *  网络
   * ================================================================ */

  Future<void> _open({required bool first}) async {
    final gen = ++_gen;
    conn = first ? ConnState.connecting : ConnState.reconnecting;
    notifyListeners();
    WebSocket ws;
    try {
      ws = await WebSocket.connect(wsUrl.toString()).timeout(const Duration(seconds: 6));
    } catch (_) {
      if (first) throw Exception('无法连接服务器');
      if (gen == _gen) _scheduleReconnect();
      return;
    }
    if (gen != _gen || session == null) {
      ws.close();
      return;
    }
    ws.pingInterval = const Duration(seconds: 15); // 检测半开连接（手机休眠后常见）
    _ws = ws;
    final joined = _joined = Completer<void>();
    ws.listen(
      (data) => _onData(ws, data),
      onDone: () => _onClosed(ws),
      onError: (_) {},
      cancelOnError: false,
    );
    try {
      await joined.future.timeout(const Duration(seconds: 6));
    } catch (_) {
      if (first) {
        ws.close();
        throw Exception('连接超时，请检查服务器地址');
      }
      ws.close();
    }
  }

  void _scheduleReconnect() {
    _reconnectTimer?.cancel();
    final delay = min(8000, 500 * pow(2, _retry++).toInt());
    _reconnectTimer = Timer(Duration(milliseconds: delay), () {
      if (session != null) _open(first: false).catchError((_) {});
    });
  }

  void _onClosed(WebSocket ws) {
    if (_ws != ws || session == null || !entered) return;
    conn = ConnState.reconnecting;
    _markAllOffline();
    _scheduleReconnect();
    notifyListeners();
  }

  void _onData(WebSocket ws, dynamic data) {
    if (_ws != ws) return;
    if (data is List<int>) {
      _onChunk(data is Uint8List ? data : Uint8List.fromList(data));
      return;
    }
    Map<String, dynamic> m;
    try {
      m = jsonDecode(data as String) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    switch (m['type']) {
      case 'welcome':
        final n = m['name'];
        serverName = n is String ? (n.length > 40 ? n.substring(0, 40) : n) : '';
        final features = m['features'] is List ? (m['features'] as List) : const [];
        serverMedia = features.contains('media');
        serverDirect = features.contains('direct');
        serverActions = (m['actions'] is List ? m['actions'] as List : const []).map((a) => ActionDef.sanitize(a)).whereType<ActionDef>().take(50).toList();
        ws.add(jsonEncode({'type': 'join', 'room': session!.roomId}));
        break;
      case 'joined':
        myId = m['id'] as String?;
        _retry = 0;
        _markAllOffline();
        _updateCount(m['count']);
        _send({'t': 'hello', 'caps': _caps, 'v': appVersion});
        // 重连后几秒内没回来的人视为已离线：不再等他们的旧消息回执
        Timer(const Duration(seconds: 5), () {
          for (final p in members.values.toList()) {
            p.quiet = false;
            if (!p.online) _dropFromNeed(p.cid);
          }
        });
        if (_joined != null && !_joined!.isCompleted) _joined!.complete();
        break;
      case 'join':
        _updateCount(m['count']);
        break;
      case 'leave':
        _updateCount(m['count']);
        final id = m['id'];
        final p = members[_conns[id]];
        _conns.remove(id);
        if (p != null && p.conn == id) _memberGone(p);
        break;
      case 'relay':
        final s = session;
        if (s == null || m['data'] is! String || m['from'] is! String) return;
        final inner = open(s, m['data']);
        if (inner != null) _onInner(m['from'], inner);
        break;
    }
  }

  void _updateCount(Object? n) {
    online = n is int ? n : online;
    conn = ConnState.online;
    notifyListeners();
  }

  /// 发送加密消息。to = 目标连接 ID（只发给这个人），不填则发给房间里所有人
  bool _send(Map<String, dynamic> obj, [String? to]) {
    final ws = _ws, s = session;
    if (ws == null || s == null || ws.readyState != WebSocket.open) return false;
    final inner = {'name': name, 'cid': cid, ...obj};
    ws.add(jsonEncode({'type': 'relay', 'data': seal(s, inner), 'to': ?to}));
    return true;
  }

  /// 发到某个会话：群聊发给所有人；私聊只发给对方，并在密文里标明收件人
  bool _sendTo(String conv, Map<String, dynamic> obj) {
    if (conv == group) return _send(obj);
    final p = convPeer(conv);
    if (p == null || !p.online || p.conn == null) return false;
    return _send({...obj, 'dm': p.cid}, p.conn);
  }

  /// 回执只发给原消息的发送者
  void _replyTo(ChatItem it, Map<String, dynamic> obj) {
    final p = members[it.cid];
    if (p == null || !p.online || p.conn == null) return;
    _send(it.conv == group ? obj : {...obj, 'dm': p.cid}, p.conn);
  }

  /* ================================================================
   *  成员
   * ================================================================ */

  Member? convPeer(String conv) => isDm(conv) ? members[conv.substring(2)] : null;
  List<Member> get onlineMembers => members.values.where((p) => p.online).toList();

  String _cleanName(Object? n) {
    if (n is! String || n.trim().isEmpty) return 'peer';
    final t = n.trim();
    return t.length > 24 ? t.substring(0, 24) : t;
  }

  ({Member p, bool isNew, bool back}) _bindMember(String connId, Map<String, dynamic> m) {
    var c = _conns[connId];
    if (c == null) {
      final claimed = m['cid'];
      c = claimed is String && _cidRe.hasMatch(claimed) && claimed != cid ? claimed : connId;
      _conns[connId] = c;
    }
    final nm = _cleanName(m['name']);
    var p = members[c];
    var isNew = false;
    if (p == null) {
      // 对方重启了应用（cid 变了）：沿用同名的离线成员，私聊记录接得上
      final prev = members.values.where((x) => !x.online && x.name == nm).firstOrNull;
      if (prev != null) {
        _rekeyMember(prev, c);
        p = prev;
      } else {
        p = Member(cid: c, name: nm, seq: ++_memberSeq);
        members[c] = p;
        isNew = true;
      }
    }
    final back = !p.online && !isNew;
    if (p.conn != null && p.conn != connId) _conns.remove(p.conn);
    p.conn = connId;
    p.online = true;
    p.name = nm;
    return (p: p, isNew: isNew, back: back);
  }

  void _rekeyMember(Member p, String newCid) {
    final old = p.cid;
    final from = dmConv(old), to = dmConv(newCid);
    members.remove(old);
    p.cid = newCid;
    members[newCid] = p;
    var dropped = false;
    for (final it in items) {
      if (it.conv == from) it.conv = to;
      if (it.cid == old) it.cid = newCid;
      if (it.need?.remove(old) == true) {
        _progress(it);
        dropped = true;
      }
      for (final set in [it.readBy, it.recvBy, it.viewBy]) {
        if (set.remove(old)) set.add(newCid);
      }
    }
    final tl = _timeline.remove(from);
    if (tl != null) _timeline[to] = tl;
    for (final map in [_receipts, _acked]) {
      final v = map.remove(from);
      if (v != null) map[to] = v;
    }
    if (_compacted.remove(from)) _compacted.add(to);
    if (active == from) active = to;
    if (dropped) _enforceKeep();
  }

  /// 显示名：重名时加 cid 前缀区分；颜色与桌面端算法一致
  Map<String, Label> labels() {
    final list = members.values.toList()..sort((a, b) => a.seq.compareTo(b.seq));
    final count = <String, int>{};
    for (final p in list) {
      if (p.online || convItems(dmConv(p.cid)).isNotEmpty) count[p.name] = (count[p.name] ?? 0) + 1;
    }
    return {
      for (final p in list)
        p.cid: () {
          final dup = (count[p.name] ?? 0) > 1 || p.name == name;
          return Label(dup ? '${p.name}·${p.cid.substring(0, 3)}' : p.name, hashNum(dup ? p.cid : p.name) % 8);
        }(),
    };
  }

  Label labelOf(Member p) => labels()[p.cid] ?? Label(p.name, 0);

  void _markAllOffline() {
    for (final p in members.values) {
      if (p.online) p.quiet = true;
      p.online = false;
      p.conn = null;
    }
    _conns.clear();
    notifyListeners();
  }

  void _dropFromNeed(String c) {
    var touched = false;
    for (final it in items) {
      if (!it.mine || it.need?.contains(c) != true) continue;
      if (it.kind == ItemKind.media ? !it.viewBy.contains(c) : !it.readBy.contains(c)) {
        it.need!.remove(c);
        _progress(it);
        touched = true;
      }
    }
    if (touched) _enforceKeep();
  }

  void _memberGone(Member p) {
    p.online = false;
    p.conn = null;
    _sys('{who} 已离开', cid: p.cid);
    if (_timeline.containsKey(dmConv(p.cid))) _sys('{who} 已离开', cid: p.cid, conv: dmConv(p.cid));
    _dropFromNeed(p.cid);
    notifyListeners();
  }

  void _checkPeerVersion(Member p, Map<String, dynamic> m) {
    final v = m['v'];
    p.v = v is String && RegExp(r'^\d+\.\d+\.\d+$').hasMatch(v) ? v : null;
    p.caps = m['caps'] is List ? (m['caps'] as List).whereType<String>().take(10).toList() : const [];
    if (p.warned || p.hasCap('dm')) return;
    p.warned = true;
    _sys('{who} 的客户端版本较旧，不支持私聊', cid: p.cid);
  }

  bool _fresh(Map<String, dynamic> m) {
    final id = m['id'], ts = m['ts'];
    if (id is! String || _seen.contains(id)) return false;
    if (ts is! num || (DateTime.now().millisecondsSinceEpoch - ts).abs() > _maxSkew.inMilliseconds) return false;
    _seen.add(id);
    return true;
  }

  /* ================================================================
   *  收到的加密消息
   * ================================================================ */

  void _onInner(String from, Map<String, dynamic> m) {
    // 私聊带收件人 cid；不是发给我的直接丢弃
    if (m.containsKey('dm') && m['dm'] != cid) return;
    final b = _bindMember(from, m);
    final p = b.p;
    final conv = m['dm'] != null ? dmConv(p.cid) : group;
    switch (m['t']) {
      case 'hello':
      case 'hi':
        _checkPeerVersion(p, m);
        if (m['t'] == 'hello') {
          _send({'t': 'hi', 'cfg': cfg.toJson(), 'caps': _caps, 'v': appVersion}, from);
          if (!b.isNew) _resendAcked(p, from);
        } else {
          if (!_cfgTouched && m['cfg'] is Map) {
            _setCfg(Map<String, dynamic>.from(m['cfg']), broadcast: false);
            _cfgTouched = true;
          }
          if (p.quiet) _resendAcked(p, from);
        }
        if ((b.isNew || b.back) && !p.quiet) {
          _sys('{who} 加入了会话', cid: p.cid);
          if (b.back && _timeline.containsKey(dmConv(p.cid))) _sys('{who} 回来了', cid: p.cid, conv: dmConv(p.cid));
        }
        p.quiet = false;
        _flushReceipts();
        notifyListeners();
        break;
      case 'cfg':
        if (conv != group) return;
        _setCfg(m, broadcast: false);
        _sys('{who} 更新了设置 · 保留 ${cfg.keep} 轮 · 已读后焚毁 ${ttlLabel(cfg.ttl)} · 媒体 ${cfg.mview}s', cid: p.cid);
        break;
      case 'msg':
        final text = m['text'];
        if (text is! String || !_fresh(m)) return;
        _addItem(ChatItem(id: m['id'], conv: conv, kind: ItemKind.msg, mine: false, cid: p.cid, text: text.length > 4000 ? text.substring(0, 4000) : text));
        break;
      case 'action':
        final a = ActionDef.sanitize(m);
        if (a == null || !_fresh(m)) return;
        _addItem(ChatItem(id: m['id'], conv: conv, kind: ItemKind.action, mine: false, cid: p.cid, action: a, all: conv == group && m['all'] == true));
        if (prefs.haptics) HapticFeedback.heavyImpact();
        _nudges.add(null);
        break;
      case 'read':
        final ids = m['ids'];
        if (ids is! List) return;
        for (final id in ids.take(100)) {
          final it = items.where((i) => i.id == id && i.mine && i.conv == conv && i.kind != ItemKind.media).firstOrNull;
          if (it == null) continue;
          if (it.need != null) {
            if (it.readBy.add(p.cid)) _progress(it);
          } else if (!it.read) {
            _markRead(it);
          }
        }
        notifyListeners();
        break;
      case 'media':
        _onMediaMeta(m, p, conv);
        break;
      case 'mrecv':
      case 'mview':
        final it = items.where((i) => i.id == m['id'] && i.kind == ItemKind.media && i.mine && i.conv == conv).firstOrNull;
        if (it == null) return;
        (m['t'] == 'mrecv' ? it.recvBy : it.viewBy).add(p.cid);
        if (m['t'] == 'mview') it.recvBy.add(p.cid);
        _progress(it);
        notifyListeners();
        break;
      case 'burn':
        _burnConv(conv);
        break;
    }
  }

  /* ================================================================
   *  消息 / 已读 / 焚毁
   * ================================================================ */

  List<ChatItem> convItems(String conv) => items.where((i) => i.conv == conv).toList();
  List<Entry> timeline(String conv) => _timeline[conv] ?? const [];
  bool hasThread(String conv) => _timeline.containsKey(conv);

  int unreadIn(String conv) => items.where((i) => i.conv == conv && !i.mine && !i.seen).length;
  int get unreadTotal => items.where((i) => !i.mine && !i.seen).length;
  int get unreadElsewhere => items.where((i) => !i.mine && !i.seen && i.conv != active).length;

  void _timelineAdd(String conv, Entry e) => (_timeline[conv] ??= []).add(e);

  ({Set<String> need, int total}) _recipients(String conv, [String? cap]) {
    final peer = convPeer(conv);
    final list = peer != null ? [peer] : onlineMembers.where((p) => cap == null || p.hasCap(cap));
    final need = list.map((p) => p.cid).toSet();
    return (need: need, total: need.length);
  }

  ChatItem _addItem(ChatItem it) {
    it.seen = it.mine;
    it.dwell = it.kind == ItemKind.msg ? min(8000, 1500 + it.text!.length * 60) : 600;
    _timelineAdd(it.conv, it);
    items.add(it);
    _enforceKeep();
    _updateUnread(arrived: !it.mine);
    notifyListeners();
    return it;
  }

  void _readTick() {
    if (!isReading) return;
    var changed = false;
    for (final it in items.toList()) {
      if (it.conv != active) continue;
      if (!it.seen) {
        it.seen = true;
        changed = true;
      }
      if (!it.mine && !it.read && it.kind != ItemKind.media) {
        it.readMs += _tick;
        if (it.readMs >= it.dwell) {
          _markRead(it);
          changed = true;
        }
      }
    }
    _flushReceipts();
    if (changed) {
      _updateUnread(arrived: false);
      notifyListeners();
    }
  }

  void _rememberAck(String conv, String id) {
    final list = _acked[conv] ??= [];
    if (!list.contains(id)) list.add(id);
    if (list.length > 60) list.removeRange(0, list.length - 60);
  }

  void _resendAcked(Member p, String to) {
    final g = _acked[group];
    if (g != null && g.isNotEmpty) _send({'t': 'read', 'ids': g}, to);
    final dm = _acked[dmConv(p.cid)];
    if (dm != null && dm.isNotEmpty) _send({'t': 'read', 'ids': dm, 'dm': p.cid}, to);
  }

  void _queueReceipt(ChatItem it) {
    _rememberAck(it.conv, it.id);
    (_receipts[it.conv] ??= []).add(it.id);
  }

  void _markRead(ChatItem it) {
    if (it.read) return;
    it.read = true;
    if (!it.mine && it.kind == ItemKind.msg) _queueReceipt(it);
    _startTtl(it);
    _enforceKeep();
  }

  void _flushReceipts() {
    for (final conv in _receipts.keys.toList()) {
      final ids = _receipts[conv]!;
      if (ids.isNotEmpty && _sendTo(conv, {'t': 'read', 'ids': ids.take(100).toList()})) ids.removeRange(0, min(100, ids.length));
      if (ids.isEmpty) _receipts.remove(conv);
    }
  }

  /// 我发出的消息是否所有接收者都已读
  bool receiptDone(ChatItem it) => it.readBy.isNotEmpty && (it.need ?? const {}).every(it.readBy.contains);

  void _progress(ChatItem it) {
    if (it.burning) return;
    if (it.kind == ItemKind.media) {
      if (const [MediaStatus.viewed, MediaStatus.sending, MediaStatus.failed].contains(it.status)) return;
      final viewed = it.need!.every(it.viewBy.contains);
      if (it.viewBy.isNotEmpty && viewed) {
        it.status = MediaStatus.viewed;
        Timer(const Duration(seconds: 5), () => _burn(it));
      } else if (it.viewBy.isNotEmpty) {
        it.status = MediaStatus.partview;
      } else if (it.recvBy.isNotEmpty) {
        it.status = MediaStatus.delivered;
      }
      return;
    }
    if (receiptDone(it)) _markRead(it);
  }

  /// 保留 N 轮：同一个人连续发的消息算一轮；更早轮次里已读的（或无人可回执的我的消息）焚毁
  void _enforceKeep() {
    final byConv = <String, List<ChatItem>>{};
    for (final i in items) {
      if (i.kind == ItemKind.msg) (byConv[i.conv] ??= []).add(i);
    }
    for (final msgs in byConv.values) {
      var turn = 0;
      String? prev;
      for (var k = msgs.length - 1; k >= 0; k--) {
        final m = msgs[k];
        final who = m.mine ? '' : m.cid;
        if (who != prev) {
          turn++;
          prev = who;
        }
        if (turn > cfg.keep && (m.read || (m.mine && (m.need?.isEmpty ?? true)))) _burn(m);
      }
    }
  }

  void _startTtl(ChatItem it) {
    final ttl = it.kind == ItemKind.action ? _actionTtl : cfg.ttl;
    if (ttl == 0 || it.timer != null || it.burning) return;
    it.timer = Timer(Duration(seconds: ttl), () => _burn(it));
    if (it.kind == ItemKind.msg) {
      it.ttlStart = DateTime.now();
      it.ttlSec = ttl;
    }
  }

  void _resetTimers() {
    for (final it in items) {
      if (it.kind != ItemKind.msg) continue;
      it.timer?.cancel();
      it.timer = null;
      it.ttlStart = null;
      if (it.read) _startTtl(it);
    }
  }

  void _burn(ChatItem it, {bool instant = false}) {
    if (!items.remove(it)) return;
    it.timer?.cancel();
    if (it.kind == ItemKind.media) _cleanupMedia(it);
    it.text = null;
    it.action = null;
    final tl = _timeline[it.conv];
    if (instant) {
      tl?.remove(it);
    } else {
      it.burning = true;
      Timer(const Duration(milliseconds: 650), () {
        _timeline[it.conv]?.remove(it);
        notifyListeners();
      });
      if (!_compacted.contains(it.conv) && it.kind == ItemKind.msg && tl != null) {
        _compacted.add(it.conv);
        tl.insert(0, CompactNote());
      }
    }
    _updateUnread(arrived: false);
    notifyListeners();
  }

  void _burnAll() {
    _acked.clear();
    for (final it in items.toList()) {
      _burn(it, instant: true);
    }
  }

  void _burnConv(String conv) {
    _acked.remove(conv);
    for (final it in convItems(conv)) {
      _burn(it, instant: true);
    }
    _compacted.remove(conv);
    _timeline[conv]?.clear();
    notifyListeners();
  }

  /// 清屏：只清自己屏幕（未读消息顺带发回执，避免对方卡未读）
  void wipeScreen([String? c]) {
    final conv = c ?? active;
    for (final it in convItems(conv)) {
      if (!it.mine) {
        it.seen = true;
        if (!it.read && it.kind == ItemKind.msg) _queueReceipt(it);
      }
      _burn(it, instant: true);
    }
    _flushReceipts();
    _compacted.remove(conv);
    _timeline[conv]?.clear();
    notifyListeners();
  }

  /// 清空当前会话（双方一起）
  void clearConv() {
    _burnConv(active);
    _sendTo(active, {'t': 'burn'});
  }

  /// 手动清除单条（仅本地）
  void dismiss(ChatItem it) {
    if (!it.mine) {
      it.seen = true;
      if (!it.read && it.kind == ItemKind.msg) {
        _queueReceipt(it);
        _flushReceipts();
      }
    }
    _burn(it);
    _enforceKeep();
  }

  void dismissSys(Entry e) {
    for (final tl in _timeline.values) {
      tl.remove(e);
    }
    notifyListeners();
  }

  void _sys(String text, {String? cid, String conv = group}) {
    final note = SysNote(text, cid: cid);
    _timelineAdd(conv, note);
    notifyListeners();
    Timer(const Duration(seconds: 8), () {
      note.fading = true;
      notifyListeners();
      Timer(const Duration(milliseconds: 500), () => dismissSys(note));
    });
  }

  void _updateUnread({required bool arrived}) {
    final count = unreadTotal;
    if (arrived && count > 0 && prefs.notify && !_foreground && DateTime.now().difference(_lastNotify) > const Duration(seconds: 8)) {
      _lastNotify = DateTime.now();
      Native.notify(items.lastOrNull?.kind == ItemKind.action ? '你有一条新的动态' : '你有新消息，点击查看');
    }
  }

  /* ================================================================
   *  发送
   * ================================================================ */

  void switchConv(String conv) {
    if (conv != group && convPeer(conv) == null) conv = group;
    active = conv;
    _timeline[conv] ??= [];
    notifyListeners();
  }

  /// 返回 true 表示已发送（输入框可以清空）
  bool sendText(String raw) {
    final text = raw.trim();
    if (text.isEmpty) return false;
    final conv = active;
    final peer = convPeer(conv);
    if (peer != null && !peer.online) {
      toast('${labelOf(peer).text} 已离线，回来后才能收到');
      return false;
    }
    final id = randomId();
    if (!_sendTo(conv, {'t': 'msg', 'id': id, 'text': text, 'ts': DateTime.now().millisecondsSinceEpoch})) {
      toast('未连接，稍后再试');
      return false;
    }
    _seen.add(id);
    final r = _recipients(conv);
    final it = ChatItem(id: id, conv: conv, kind: ItemKind.msg, mine: true, text: text)
      ..need = r.need
      ..total = r.total;
    _addItem(it);
    if (prefs.haptics) HapticFeedback.selectionClick();
    return true;
  }

  ({String who, bool all, Member? peer}) actionTarget() {
    final peer = convPeer(active);
    if (peer != null) return (who: labelOf(peer).text, all: false, peer: peer);
    final all = onlineMembers.length >= 2;
    return (who: all ? '大家' : '对方', all: all, peer: null);
  }

  bool sendAction(ActionDef a) {
    if (DateTime.now().difference(_lastAction) < const Duration(milliseconds: 1500)) {
      toast('慢一点～');
      return false;
    }
    final conv = active;
    final t = actionTarget();
    if (t.peer != null && !t.peer!.online) {
      toast('${t.who} 已离线');
      return false;
    }
    final id = randomId();
    final m = {'t': 'action', 'id': id, 'ts': DateTime.now().millisecondsSinceEpoch, ...a.toJson(), if (t.all) 'all': true};
    if (!_sendTo(conv, m)) {
      toast('未连接，稍后再试');
      return false;
    }
    _lastAction = DateTime.now();
    _seen.add(id);
    final it = _addItem(ChatItem(id: id, conv: conv, kind: ItemKind.action, mine: true, action: a, target: t.who));
    _markRead(it);
    if (prefs.haptics) HapticFeedback.mediumImpact();
    return true;
  }

  int get maxActionLen => _maxActionLen;

  /* ================================================================
   *  设置（全房间同步）
   * ================================================================ */

  void setCfg({int? keep, int? ttl, int? mview}) => _setCfg({'keep': keep ?? cfg.keep, 'ttl': ttl ?? cfg.ttl, 'mview': mview ?? cfg.mview}, broadcast: true);

  void _setCfg(Map<String, dynamic> c, {required bool broadcast}) {
    final k = (c['keep'] is num ? (c['keep'] as num).toInt() : int.tryParse('${c['keep']}') ?? 1).clamp(1, 50);
    final t = int.tryParse('${c['ttl']}');
    final mv = int.tryParse('${c['mview']}');
    final ttl = ttlOptions.contains(t) ? t! : cfg.ttl;
    final mview = mviewOptions.contains(mv) ? mv! : cfg.mview;
    final ttlChanged = ttl != cfg.ttl;
    cfg = RoomCfg(keep: k, ttl: ttl, mview: mview);
    _enforceKeep();
    if (ttlChanged) _resetTimers();
    if (broadcast) {
      _cfgTouched = true;
      _send({'t': 'cfg', 'name': name, ...cfg.toJson()});
    }
    notifyListeners();
  }

  /* ================================================================
   *  附件
   * ================================================================ */

  int get _inflightBytes => items.fold(0, (n, i) => n + (i.kind == ItemKind.media && !i.mine && i.frames != null ? i.size : 0));

  void _onMediaMeta(Map<String, dynamic> m, Member p, String conv) {
    final mtype = m['mtype'];
    if (mtype != 'image' && mtype != 'video') return;
    if (!(mtype == 'image' ? imageMime : videoMime).contains(m['mime'])) return;
    final limit = mtype == 'image' ? maxImageRaw : maxVideo;
    final size = m['size'], chunks = m['chunks'];
    if (size is! int || size <= 0 || size > limit) return;
    if (chunks != (size / chunkSize).ceil()) return;
    if (!_fresh(m)) return;
    if (_inflightBytes + size > maxInflight) {
      _sys('附件已跳过 · 内存上限', conv: conv);
      return;
    }
    Uint8List? thumb;
    final t = m['thumb'];
    if (t is String && t.length < 16000 && _thumbRe.hasMatch(t)) {
      try {
        thumb = base64Decode(t.substring(t.indexOf(',') + 1));
      } catch (_) {}
    }
    int clampInt(Object? v, int def) => v is num && v.toInt() > 0 ? v.toInt().clamp(1, 10000) : def;
    final it = ChatItem(id: m['id'], conv: conv, kind: ItemKind.media, mine: false, cid: p.cid)
      ..mtype = mtype
      ..mime = m['mime']
      ..size = size
      ..chunks = chunks as int
      ..w = clampInt(m['w'], 16)
      ..h = clampInt(m['h'], 9)
      ..dur = (m['dur'] is num ? (m['dur'] as num) : 0).clamp(0, 36000)
      ..thumb = thumb
      ..status = MediaStatus.receiving
      ..frames = List<Uint8List?>.filled(chunks, null)
      ..lastAt = DateTime.now();
    _addItem(it);
    _incoming[it.id] = it;
  }

  void _onChunk(Uint8List frame) {
    final h = chunkHeader(frame);
    if (h == null || frame.length > chunkSize + chunkOverhead) return;
    final it = _incoming[h.id];
    if (it == null || h.index >= it.chunks || it.frames![h.index] != null) return;
    it.frames![h.index] = frame; // 保持加密状态，点查看前不解密
    it.got++;
    it.lastAt = DateTime.now();
    if (it.got == it.chunks) {
      _incoming.remove(h.id);
      it.status = MediaStatus.ready;
      _replyTo(it, {'t': 'mrecv', 'id': it.id});
      notifyListeners();
    } else if (it.got % 8 == 0) {
      it.pct = (it.got * 100 / it.chunks).floor();
      notifyListeners();
    }
  }

  /// 45 秒没有新分块判定失败并释放内存
  void _checkStalled() {
    for (final it in _incoming.values.toList()) {
      if (DateTime.now().difference(it.lastAt) > const Duration(seconds: 45)) {
        _incoming.remove(it.id);
        for (final f in it.frames ?? <Uint8List?>[]) {
          f?.fillRange(0, f.length, 0);
        }
        it.frames = null;
        it.status = MediaStatus.failed;
        Timer(const Duration(seconds: 8), () => _burn(it));
        notifyListeners();
      }
    }
  }

  /// 发送前检查；返回 null 表示可以发送
  String? mediaBlocker() {
    if (!serverMedia) return '服务器版本过旧，不支持图片 / 视频';
    final peer = convPeer(active);
    if (peer != null) {
      final who = labelOf(peer).text;
      if (!peer.online) return '$who 已离线 · 附件需要对方在线才能接收';
      if (!peer.hasCap('media')) return '$who 的客户端版本过旧，收不到图片 / 视频';
      if (!serverDirect) return '服务器版本过旧，私聊不能发图片 / 视频';
      return null;
    }
    final others = onlineMembers;
    if (others.isEmpty) return '其他人都不在线 · 附件需要对方在线才能接收';
    if (others.every((p) => !p.hasCap('media'))) return '对方的客户端版本过旧，收不到图片 / 视频';
    return null;
  }

  Future<void> sendMedia(PreparedMedia prep) async {
    final blocker = mediaBlocker();
    final bytes = prep.bytes;
    if (blocker != null) {
      bytes.fillRange(0, bytes.length, 0);
      toast(blocker);
      return;
    }
    final conv = active;
    final peer = convPeer(conv);
    final ws = _ws!;
    final s = session!;
    final id = randomId();
    final total = max(1, (bytes.length / chunkSize).ceil());
    final meta = {
      't': 'media', 'id': id, 'ts': DateTime.now().millisecondsSinceEpoch, 'mtype': prep.kind, 'mime': prep.mime, //
      'size': bytes.length, 'chunks': total, 'w': prep.w, 'h': prep.h, 'dur': prep.dur.round(), 'thumb': prep.thumb,
    };
    final connId = peer?.conn;
    final route = connId != null ? fromHex(connId) : null;
    if (!_sendTo(conv, meta)) {
      bytes.fillRange(0, bytes.length, 0);
      toast('未连接，稍后再试');
      return;
    }
    _seen.add(id);
    final r = _recipients(conv, 'media');
    final it = ChatItem(id: id, conv: conv, kind: ItemKind.media, mine: true)
      ..mtype = prep.kind
      ..mime = prep.mime
      ..size = bytes.length
      ..chunks = total
      ..w = prep.w
      ..h = prep.h
      ..dur = prep.dur
      ..thumb = prep.thumb.isEmpty ? null : base64Decode(prep.thumb.substring(prep.thumb.indexOf(',') + 1))
      ..status = MediaStatus.sending
      ..need = r.need
      ..total = r.total;
    _addItem(it);
    try {
      for (var i = 0; i < total; i++) {
        if (_ws != ws || ws.readyState != WebSocket.open || session != s) throw Exception('disconnected');
        if (peer != null && peer.conn != connId) throw Exception('peer reconnected');
        final end = min((i + 1) * chunkSize, bytes.length);
        final frame = sealChunk(s, id, i, total, Uint8List.sublistView(bytes, i * chunkSize, end));
        if (route != null) {
          ws.add(Uint8List(1 + route.length + frame.length)
            ..[0] = 0x02
            ..setAll(1, route)
            ..setAll(1 + route.length, frame));
        } else {
          ws.add(frame);
        }
        if (i % 8 == 7) {
          it.pct = ((i + 1) * 100 / total).floor();
          notifyListeners();
          await Future<void>.delayed(const Duration(milliseconds: 12)); // 让出事件循环，也给网络留出发送时间
        }
      }
      if (it.status == MediaStatus.sending) {
        it.status = MediaStatus.sent;
        _progress(it); // 发送过程中可能已经收到回执
        Timer(const Duration(seconds: 20), () {
          if (it.status == MediaStatus.sent && !it.burning && items.contains(it)) {
            it.status = MediaStatus.undelivered;
            notifyListeners();
          }
        });
      }
    } catch (_) {
      it.status = MediaStatus.failed;
    } finally {
      bytes.fillRange(0, bytes.length, 0); // 发送方不保留副本
      notifyListeners();
    }
  }

  Future<void> viewMedia(ChatItem it) async {
    if (it.status != MediaStatus.ready || it.frames == null || session == null) return;
    it.status = MediaStatus.opening;
    notifyListeners();
    final frames = it.frames!.cast<Uint8List>();
    it.frames = null;
    final plain = await decryptFrames(session!, frames, it.size);
    for (final f in frames) {
      f.fillRange(0, f.length, 0);
    }
    if (plain == null || it.burning || !items.contains(it)) {
      plain?.fillRange(0, plain.length, 0);
      it.status = MediaStatus.failed;
      notifyListeners();
      return;
    }
    _replyTo(it, {'t': 'mview', 'id': it.id});
    final n = cfg.mview;
    try {
      if (it.isVideo) {
        final url = await MemoryMediaServer.instance.put(plain, it.mime!);
        it.videoUrl = url;
        final c = VideoPlayerController.networkUrl(url, videoPlayerOptions: VideoPlayerOptions(mixWithOthers: true));
        it.video = c;
        await c.initialize();
        if (it.burning || !items.contains(it)) return;
        c.addListener(() {
          final v = c.value;
          if (v.isInitialized && !v.isPlaying && v.duration > Duration.zero && v.position >= v.duration - const Duration(milliseconds: 200)) {
            _countdown(it, n);
          }
        });
        await c.play();
        // 兜底：一直不看完也会在「时长 + 2 分钟 + N 秒」后焚毁
        it.capTimer = Timer(Duration(seconds: (it.dur + 120 + n).round()), () => _burn(it));
      } else {
        it.plain = plain;
        _countdown(it, n);
      }
      it.status = MediaStatus.viewing;
    } catch (_) {
      plain.fillRange(0, plain.length, 0);
      it.status = MediaStatus.failed;
    }
    notifyListeners();
  }

  void _countdown(ChatItem it, int sec) {
    if (it.countdown != null || it.burning) return;
    it.countdown = Timer(Duration(seconds: sec), () => _burn(it));
    it.cdStart = DateTime.now();
    it.cdSec = sec;
    notifyListeners();
  }

  void _cleanupMedia(ChatItem it) {
    it.countdown?.cancel();
    it.capTimer?.cancel();
    _incoming.remove(it.id);
    for (final f in it.frames ?? <Uint8List?>[]) {
      f?.fillRange(0, f.length, 0);
    }
    it.frames = null;
    final plain = it.plain;
    if (plain != null) {
      MemoryImage(plain).evict();
      PaintingBinding.instance.imageCache.clearLiveImages();
      plain.fillRange(0, plain.length, 0);
      it.plain = null;
    }
    final v = it.video;
    it.video = null;
    if (v != null) {
      v.pause().whenComplete(v.dispose);
    }
    MemoryMediaServer.instance.remove(it.videoUrl);
    it.videoUrl = null;
  }

  @visibleForTesting
  void debugInject(String from, Map<String, dynamic> m) => _onInner(from, m);
}
