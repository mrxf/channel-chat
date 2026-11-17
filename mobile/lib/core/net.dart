// 服务器地址处理、在线检测、局域网发现（Bonjour/mDNS + 本网段端口探测）
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:nsd/nsd.dart' as nsd;

const defaultPort = 10686;
const mdnsType = '_agentws._tcp';

/// 「192.168.1.5」「192.168.1.5:10686」「http://x」→ ws://host:port/ws（与桌面端 toWsUrl 一致）
Uri toWsUrl(String input) {
  var s = input.trim();
  if (s.isEmpty) throw const FormatException('请填写服务器地址');
  if (!RegExp(r'^[a-z]+://', caseSensitive: false).hasMatch(s)) s = 'ws://$s';
  Uri u;
  try {
    u = Uri.parse(s);
  } catch (_) {
    throw const FormatException('服务器地址格式不对，例如 192.168.1.5:10686');
  }
  if (u.host.isEmpty) throw const FormatException('服务器地址格式不对，例如 192.168.1.5:10686');
  var scheme = u.scheme.toLowerCase();
  if (scheme == 'http') scheme = 'ws';
  if (scheme == 'https') scheme = 'wss';
  if (scheme != 'ws' && scheme != 'wss') throw const FormatException('不支持的协议');
  final port = u.hasPort ? u.port : (scheme == 'ws' ? defaultPort : null);
  return Uri(scheme: scheme, host: u.host, port: port, path: '/ws');
}

Uri httpUrl(Uri ws, String path) => ws.replace(scheme: ws.scheme == 'wss' ? 'https' : 'http', path: path);

String shortServer(Uri ws) => ws.hasPort ? '${ws.host}:${ws.port}' : ws.host;

class ServerInfo {
  const ServerInfo({required this.name});
  final String name;
}

/// GET /health，3 秒超时；不是本项目的服务器返回 null
Future<ServerInfo?> checkServer(String input, {Duration timeout = const Duration(seconds: 3)}) async {
  final Uri url;
  try {
    url = httpUrl(toWsUrl(input), '/health');
  } catch (_) {
    return null;
  }
  final client = HttpClient()..connectionTimeout = timeout;
  try {
    final req = await client.getUrl(url).timeout(timeout);
    final res = await req.close().timeout(timeout);
    final body = await res.transform(utf8.decoder).join().timeout(timeout);
    final d = jsonDecode(body);
    if (d is! Map || d['app'] != 'agent-relay') return null;
    final name = d['name'] is String ? (d['name'] as String) : 'relay';
    return ServerInfo(name: name.length > 40 ? name.substring(0, 40) : name);
  } catch (_) {
    return null;
  } finally {
    client.close(force: true);
  }
}

class FoundServer {
  const FoundServer({required this.name, required this.host, required this.port});
  final String name;
  final String host;
  final int port;
  String get url => '$host:$port';
}

/// 监听 Bonjour 广播 [wait] 时长，返回发现的服务器
Future<List<FoundServer>> discoverMdns({Duration wait = const Duration(milliseconds: 1800)}) async {
  final found = <String, FoundServer>{};
  nsd.Discovery? d;
  try {
    d = await nsd.startDiscovery(mdnsType, ipLookupType: nsd.IpLookupType.v4);
    await Future<void>.delayed(wait);
    for (final s in d.services) {
      final ip = s.addresses?.firstWhere((a) => a.type == InternetAddressType.IPv4, orElse: () => s.addresses!.first).address;
      final host = ip ?? s.host;
      if (host == null || s.port == null) continue;
      final txtName = s.txt?['name'];
      final name = txtName != null ? utf8.decode(txtName, allowMalformed: true) : (s.name ?? 'relay');
      final f = FoundServer(name: name, host: host, port: s.port!);
      found[f.url] = f;
    }
  } catch (_) {
    // 部分系统或网络禁止组播，静默失败，交给子网扫描
  } finally {
    if (d != null) {
      try {
        await nsd.stopDiscovery(d);
      } catch (_) {}
    }
  }
  return found.values.toList();
}

/// 兜底：在本机所在 /24 网段探测约定端口，再用 /health 确认
Future<List<FoundServer>> scanSubnet({int port = defaultPort}) async {
  final prefixes = <String>{};
  final self = <String>{};
  try {
    for (final ni in await NetworkInterface.list(type: InternetAddressType.IPv4)) {
      for (final a in ni.addresses) {
        if (a.isLoopback || a.isLinkLocal) continue;
        final parts = a.address.split('.');
        if (parts.length != 4) continue;
        prefixes.add(parts.take(3).join('.'));
        self.add(a.address);
      }
    }
  } catch (_) {}
  final candidates = [
    for (final p in prefixes)
      for (var i = 1; i < 255; i++) '$p.$i',
  ];
  final open = <String>[];
  var next = 0;
  Future<void> worker() async {
    while (next < candidates.length) {
      final host = candidates[next++];
      try {
        final s = await Socket.connect(host, port, timeout: const Duration(milliseconds: 450));
        s.destroy();
        open.add(host);
      } catch (_) {}
    }
  }

  await Future.wait(List.generate(48, (_) => worker()));
  final out = <FoundServer>[];
  await Future.wait(open.map((h) async {
    final info = await checkServer('$h:$port');
    if (info != null) out.add(FoundServer(name: info.name, host: h, port: port));
  }));
  out.sort((a, b) => a.host.compareTo(b.host));
  return out;
}
