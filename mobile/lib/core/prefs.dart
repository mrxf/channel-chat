// 本地偏好（不含任何消息内容）与记住的口令（Android Keystore 加密保存）
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

class ActionDef {
  const ActionDef(this.prefix, this.suffix);
  final String prefix;
  final String suffix;

  Map<String, String> toJson() => {'prefix': prefix, 'suffix': suffix};

  /// 与桌面端 sanitizeAction 一致
  static ActionDef? sanitize(Object? a, {int maxLen = 200}) {
    if (a is! Map || a['prefix'] is! String) return null;
    final ws = RegExp(r'\s+');
    final prefix = (a['prefix'] as String).trim().replaceAll(ws, ' ');
    final suffix = a['suffix'] is String ? (a['suffix'] as String).trim().replaceAll(ws, ' ') : '';
    if (prefix.isEmpty || prefix.length + suffix.length > maxLen) return null;
    return ActionDef(prefix, suffix);
  }

  /// 「{prefix}{target}的{suffix}」，suffix 为空时省略「的」
  String text(String target) => '$prefix$target${suffix.isNotEmpty ? '的$suffix' : ''}';

  @override
  bool operator ==(Object other) => other is ActionDef && other.prefix == prefix && other.suffix == suffix;
  @override
  int get hashCode => Object.hash(prefix, suffix);
}

class Prefs extends ChangeNotifier {
  Prefs._(this._sp);
  final SharedPreferences _sp;
  static const _secure = FlutterSecureStorage();
  static const _secretKey = 'session_key';

  static Future<Prefs> load() async => Prefs._(await SharedPreferences.getInstance());

  String get name => _sp.getString('name') ?? '';
  String get server => _sp.getString('server') ?? '';
  List<String> get recentServers => _sp.getStringList('recentServers') ?? const [];
  bool get rememberKey => _sp.getBool('rememberKey') ?? true;
  bool get notify => _sp.getBool('notify') ?? true;
  bool get protect => _sp.getBool('protect') ?? true;
  bool get haptics => _sp.getBool('haptics') ?? true;
  ThemeMode get themeMode => ThemeMode.values.firstWhere((m) => m.name == _sp.getString('theme'), orElse: () => ThemeMode.system);

  List<ActionDef> get customActions {
    try {
      final list = jsonDecode(_sp.getString('customActions') ?? '[]') as List;
      return list.map((a) => ActionDef.sanitize(a)).whereType<ActionDef>().toList();
    } catch (_) {
      return [];
    }
  }

  Future<void> setCustomActions(List<ActionDef> list) async {
    await _sp.setString('customActions', jsonEncode(list.take(30).map((a) => a.toJson()).toList()));
    notifyListeners();
  }

  Future<void> rememberLogin(String name, String server) async {
    await _sp.setString('name', name);
    await _sp.setString('server', server);
    await _sp.setStringList('recentServers', [server, ...recentServers.where((s) => s != server)].take(8).toList());
  }

  Future<void> setRememberKey(bool v) async {
    await _sp.setBool('rememberKey', v);
    if (!v) await deleteSecret();
    notifyListeners();
  }

  Future<void> setNotify(bool v) async {
    await _sp.setBool('notify', v);
    notifyListeners();
  }

  Future<void> setProtect(bool v) async {
    await _sp.setBool('protect', v);
    notifyListeners();
  }

  Future<void> setHaptics(bool v) async {
    await _sp.setBool('haptics', v);
    notifyListeners();
  }

  Future<void> setThemeMode(ThemeMode m) async {
    await _sp.setString('theme', m.name);
    notifyListeners();
  }

  Future<String?> getSecret() async {
    try {
      return await _secure.read(key: _secretKey);
    } catch (_) {
      return null;
    }
  }

  Future<void> setSecret(String v) async {
    try {
      await _secure.write(key: _secretKey, value: v);
    } catch (_) {}
  }

  Future<void> deleteSecret() async {
    try {
      await _secure.delete(key: _secretKey);
    } catch (_) {}
  }
}
