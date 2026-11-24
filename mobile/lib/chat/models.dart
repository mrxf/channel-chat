// 会话数据模型（只在内存里）
import 'dart:async';
import 'dart:typed_data';

import 'package:video_player/video_player.dart';

import '../core/prefs.dart';

const group = 'g';
String dmConv(String cid) => 'd:$cid';
bool isDm(String conv) => conv.startsWith('d:');

/// 与桌面端一致的哈希（用于颜色分配），两端同一个人颜色相同
int hashNum(String s) {
  var a = 7;
  for (final r in s.runes) {
    final c = r > 0xFFFF ? (0xD800 + ((r - 0x10000) >> 10)) : r; // JS charCodeAt(0) 取高位代理
    a = (a * 31 + c) & 0xFFFFFFFF;
  }
  return a;
}

class Member {
  Member({required this.cid, required this.name, required this.seq});
  String cid;
  String name;
  String? conn;
  bool online = false;
  bool quiet = false;
  bool warned = false;
  List<String> caps = const [];
  String? v;
  final int seq;
  bool hasCap(String c) => caps.contains(c);
}

class Label {
  const Label(this.text, this.colorIndex);
  final String text;
  final int colorIndex;
}

/// 时间线上的一项：消息 / 系统提示 / 「更早的消息已焚毁」
sealed class Entry {
  Entry() : seq = ++_seq;
  static int _seq = 0;
  final int seq;
}

enum ItemKind { msg, action, media }

enum MediaStatus { receiving, sending, ready, opening, viewing, sent, delivered, partview, viewed, undelivered, failed }

class ChatItem extends Entry {
  ChatItem({
    required this.id,
    required this.conv,
    required this.kind,
    required this.mine,
    this.cid,
    this.text,
    this.action,
    this.all = false,
    this.target,
  });

  final String id;
  String conv;
  final ItemKind kind;
  final bool mine;
  String? cid;
  String? text;
  ActionDef? action;
  bool all;
  String? target;
  final DateTime at = DateTime.now();

  bool seen = false;
  bool read = false;
  int readMs = 0;
  int dwell = 600;
  Timer? timer;
  DateTime? ttlStart;
  int ttlSec = 0;
  bool burning = false;

  // 我发出的：送达 / 已读进度。need = 发送时在线的接收者
  Set<String>? need;
  int total = 0;
  final Set<String> readBy = {};
  final Set<String> recvBy = {};
  final Set<String> viewBy = {};

  // 附件
  String? mtype;
  String? mime;
  int size = 0;
  int chunks = 0;
  int w = 16;
  int h = 9;
  num dur = 0;
  Uint8List? thumb;
  MediaStatus status = MediaStatus.ready;
  int pct = 0;
  List<Uint8List?>? frames;
  int got = 0;
  DateTime lastAt = DateTime.now();
  Uint8List? plain; // 解密后的图片（只在内存里）
  Uri? videoUrl;
  VideoPlayerController? video;
  Timer? countdown;
  Timer? capTimer;
  DateTime? cdStart;
  int cdSec = 0;
  List<int>? peaks;
  double audioProgress = 0;
  int? audioRemain;

  bool get isVideo => mtype == 'video';
  bool get isAudio => mtype == 'audio';
}

class SysNote extends Entry {
  SysNote(this.text, {this.cid});
  final String text; // 可含 {who} 占位符，渲染为带颜色的成员名
  final String? cid;
  bool fading = false;
}

class CompactNote extends Entry {}

class RoomCfg {
  const RoomCfg({this.keep = 1, this.ttl = 0, this.mview = 10});
  final int keep;
  final int ttl;
  final int mview;
  Map<String, dynamic> toJson() => {'keep': keep, 'ttl': ttl, 'mview': mview};
}

const ttlOptions = [0, 10, 30, 60, 300];
const mviewOptions = [5, 10, 30, 60];

String ttlLabel(int s) => s == 0 ? '关闭' : (s < 60 ? '${s}s' : '${s ~/ 60}min');
