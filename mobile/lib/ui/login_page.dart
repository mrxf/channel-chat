// 登录页：服务器（实时在线检测 + 局域网发现）、显示名称、会话口令
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../chat/chat_controller.dart';
import '../core/crypto.dart';
import '../core/native.dart';
import '../core/net.dart';
import '../core/prefs.dart';
import '../core/version.dart';
import 'theme.dart';
import 'widgets.dart';

enum _Phase { idle, deriving, connecting }

class LoginPage extends StatefulWidget {
  const LoginPage({super.key, required this.chat, required this.prefs});
  final ChatController chat;
  final Prefs prefs;
  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _server = TextEditingController();
  final _name = TextEditingController();
  final _pass = TextEditingController();
  final _passFocus = FocusNode();
  bool _obscure = true;
  bool _remember = true;
  String? _savedKey;
  _Phase _phase = _Phase.idle;
  String? _error;

  // 服务器检测
  String _hint = '';
  int _hintKind = 0; // 0 普通 1 好 -1 坏
  int _probeSeq = 0;
  Timer? _probeTimer;
  bool _scanning = false;
  List<FoundServer> _found = [];
  String _passHint = '';

  Prefs get prefs => widget.prefs;

  @override
  void initState() {
    super.initState();
    _server.text = prefs.server;
    _name.text = prefs.name;
    _remember = prefs.rememberKey;
    _server.addListener(_onServerChanged);
    _init();
  }

  Future<void> _init() async {
    if (_remember) {
      _savedKey = await prefs.getSecret();
      if (_savedKey != null && _pass.text.isEmpty && mounted) setState(() => _pass.text = _savedKey!);
    }
    final saved = _server.text.trim();
    if (saved.isEmpty) _setHint('正在搜索局域网…');
    final results = await Future.wait([discoverMdns(), saved.isNotEmpty ? _check(saved) : Future.value(false)]);
    if (!mounted) return;
    final list = results[0] as List<FoundServer>;
    final ok = results[1] as bool;
    if (!_applyFound(list, force: !ok) && saved.isEmpty) _setHint('没有自动发现服务器 · 点雷达图标再找一次，或手动输入');
  }

  @override
  void dispose() {
    _probeTimer?.cancel();
    _server.dispose();
    _name.dispose();
    _pass.dispose();
    _passFocus.dispose();
    super.dispose();
  }

  void _setHint(String t, [int kind = 0]) {
    if (mounted) setState(() => (_hint = t, _hintKind = kind));
  }

  String _lastProbed = '';
  void _onServerChanged() {
    final v = _server.text.trim();
    if (v == _lastProbed) return;
    _lastProbed = v;
    _probeTimer?.cancel();
    if (v.isEmpty) {
      _probeSeq++;
      _setHint('');
      return;
    }
    _probeTimer = Timer(const Duration(milliseconds: 400), () => _check(v));
  }

  Future<bool> _check(String v) async {
    final seq = ++_probeSeq;
    try {
      toWsUrl(v);
    } on FormatException catch (e) {
      _setHint(e.message, -1);
      return false;
    }
    _setHint('正在检测…');
    final info = await checkServer(v);
    if (seq != _probeSeq) return info != null;
    if (info != null) {
      final more = _found.length > 1 ? ' · 局域网共 ${_found.length} 个' : '';
      _setHint('在线 · ${info.name}$more', 1);
    } else {
      _setHint('无法连接', -1);
    }
    return info != null;
  }

  bool _applyFound(List<FoundServer> list, {required bool force}) {
    final seen = <String>{};
    _found = list.where((f) => seen.add(f.url)).toList();
    if (_found.isEmpty) return false;
    final cur = _server.text.trim();
    if (force && !_found.any((f) => f.url == cur)) {
      _lastProbed = _found.first.url;
      _server.text = _found.first.url;
    }
    _check(_server.text.trim());
    return true;
  }

  Future<void> _scan() async {
    if (_scanning) return;
    HapticFeedback.selectionClick();
    setState(() => _scanning = true);
    try {
      _setHint('正在搜索局域网…');
      var list = await discoverMdns(wait: const Duration(seconds: 2));
      if (list.isEmpty) {
        _setHint('正在扫描本网段端口 $defaultPort…');
        list = await scanSubnet();
      }
      if (!mounted) return;
      if (!_applyFound(list, force: true)) _setHint('局域网里没有找到服务器，请手动输入地址', -1);
    } finally {
      if (mounted) setState(() => _scanning = false);
    }
  }

  void _pickServer() {
    final recent = prefs.recentServers.where((r) => !_found.any((f) => f.url == r)).toList();
    if (_found.isEmpty && recent.isEmpty) {
      _scan();
      return;
    }
    final p = context.pal;
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(8, 0, 8, 12),
          children: [
            if (_found.isNotEmpty) _sheetTitle('局域网', p),
            for (final f in _found)
              ListTile(
                leading: Icon(Icons.wifi_tethering_rounded, color: p.good),
                title: Text(f.name),
                subtitle: Text(f.url, style: TextStyle(color: p.muted, fontFamily: monoFamily, fontSize: 12.5)),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                onTap: () => _choose(ctx, f.url),
              ),
            if (recent.isNotEmpty) _sheetTitle('最近使用', p),
            for (final r in recent)
              ListTile(
                leading: Icon(Icons.history_rounded, color: p.muted),
                title: Text(r, style: const TextStyle(fontFamily: monoFamily, fontSize: 14.5)),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                onTap: () => _choose(ctx, r),
              ),
          ],
        ),
      ),
    );
  }

  Widget _sheetTitle(String t, Palette p) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 6),
        child: Text(t, style: TextStyle(color: p.muted, fontSize: 12.5, fontWeight: FontWeight.w600)),
      );

  void _choose(BuildContext ctx, String url) {
    Navigator.pop(ctx);
    _server.text = url;
  }

  Future<void> _generate() async {
    final k = generateKey();
    setState(() {
      _pass.text = k;
      _obscure = false;
    });
    await Clipboard.setData(ClipboardData(text: k));
    HapticFeedback.lightImpact();
    setState(() => _passHint = '已生成并复制，发给对方即可');
  }

  Future<void> _submit() async {
    if (_phase != _Phase.idle) return;
    FocusScope.of(context).unfocus();
    setState(() => _error = null);
    final name = _name.text.trim();
    final pass = _pass.text;
    try {
      toWsUrl(_server.text);
    } on FormatException catch (e) {
      return setState(() => _error = e.message);
    }
    if (name.isEmpty) return setState(() => _error = '请填写显示名称');
    if (pass.length < 4) return setState(() => _error = '口令至少 4 位');

    setState(() => _phase = _Phase.deriving);
    if (prefs.notify) Native.requestNotifyPermission();
    // scrypt 在后台 isolate 里跑；派生完成后才开始连接
    final sub = widget.chat.addListener;
    void onChat() {
      if (mounted && widget.chat.session != null && _phase == _Phase.deriving) setState(() => _phase = _Phase.connecting);
    }

    sub(onChat);
    try {
      await widget.chat.join(server: _server.text, displayName: name.length > 24 ? name.substring(0, 24) : name, pass: pass);
      if (_remember && pass != _savedKey) {
        await prefs.setSecret(pass);
      } else if (!_remember) {
        await prefs.deleteSecret();
      }
      await prefs.rememberLogin(name, _server.text.trim());
      HapticFeedback.mediumImpact();
    } catch (e) {
      if (mounted) setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      widget.chat.removeListener(onChat);
      if (mounted) setState(() => _phase = _Phase.idle);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final busy = _phase != _Phase.idle;
    final hintColor = _hintKind == 1 ? p.good : (_hintKind == -1 ? p.bad : p.muted);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 32, 24, 24),
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: AutofillGroup(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Align(alignment: Alignment.centerLeft, child: SpinningMark(size: 40, spinning: busy)),
                    const SizedBox(height: 22),
                    Text('欢迎回来', style: TextStyle(fontFamily: serifFamily, fontSize: 32, height: 1.15, color: p.text, fontWeight: FontWeight.w500)),
                    const SizedBox(height: 8),
                    Text('连接到局域网会话，消息端到端加密，阅后即焚。', style: TextStyle(color: p.muted, fontSize: 15, height: 1.5)),
                    const SizedBox(height: 32),
                    _label('服务器', p),
                    TextField(
                      controller: _server,
                      enabled: !busy,
                      keyboardType: TextInputType.url,
                      autocorrect: false,
                      textInputAction: TextInputAction.next,
                      style: const TextStyle(fontFamily: monoFamily, fontSize: 15),
                      decoration: InputDecoration(
                        hintText: '192.168.1.5:10686',
                        suffixIcon: Row(mainAxisSize: MainAxisSize.min, children: [
                          IconButton(
                            tooltip: '在局域网里查找',
                            onPressed: busy ? null : _scan,
                            icon: _scanning
                                ? SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: p.muted))
                                : Icon(Icons.radar_rounded, color: p.muted),
                          ),
                          IconButton(
                            tooltip: '选择服务器',
                            onPressed: busy ? null : _pickServer,
                            icon: Icon(Icons.expand_more_rounded, color: p.muted),
                          ),
                          const SizedBox(width: 4),
                        ]),
                      ),
                    ),
                    _hintRow(
                      AnimatedSwitcher(
                        duration: const Duration(milliseconds: 200),
                        child: Row(
                          key: ValueKey('$_hint$_hintKind'),
                          children: [
                            if (_hintKind != 0) ...[StatusDot(color: hintColor, size: 7), const SizedBox(width: 6)],
                            Expanded(child: Text(_hint, style: TextStyle(color: hintColor, fontSize: 12.5), overflow: TextOverflow.ellipsis)),
                          ],
                        ),
                      ),
                    ),
                    _label('显示名称', p),
                    TextField(
                      controller: _name,
                      enabled: !busy,
                      maxLength: 24,
                      textInputAction: TextInputAction.next,
                      autofillHints: const [AutofillHints.nickname],
                      decoration: const InputDecoration(hintText: '对方看到的名字', counterText: ''),
                      onSubmitted: (_) => _passFocus.requestFocus(),
                    ),
                    const SizedBox(height: 18),
                    _label('会话口令', p),
                    TextField(
                      controller: _pass,
                      focusNode: _passFocus,
                      enabled: !busy,
                      obscureText: _obscure,
                      autocorrect: false,
                      enableSuggestions: false,
                      keyboardType: TextInputType.visiblePassword,
                      textInputAction: TextInputAction.go,
                      style: const TextStyle(fontFamily: monoFamily, fontSize: 15, letterSpacing: 0.5),
                      onSubmitted: (_) => _submit(),
                      decoration: InputDecoration(
                        hintText: '双方约定的口令',
                        hintStyle: TextStyle(fontFamily: null, letterSpacing: 0, color: p.muted.withValues(alpha: 0.8)),
                        suffixIcon: Row(mainAxisSize: MainAxisSize.min, children: [
                          IconButton(
                            onPressed: () => setState(() => _obscure = !_obscure),
                            icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined, color: p.muted, size: 21),
                          ),
                          Padding(
                            padding: const EdgeInsets.only(right: 6),
                            child: TextButton(
                              onPressed: busy ? null : _generate,
                              style: TextButton.styleFrom(foregroundColor: p.text, visualDensity: VisualDensity.compact),
                              child: const Text('生成'),
                            ),
                          ),
                        ]),
                      ),
                    ),
                    _hintRow(Text(_passHint, style: TextStyle(color: p.good, fontSize: 12.5))),
                    _RememberRow(
                      value: _remember,
                      onChanged: (v) async {
                        setState(() => _remember = v);
                        await prefs.setRememberKey(v);
                        if (!v && _savedKey != null) {
                          _savedKey = null;
                          setState(() => _passHint = '');
                        }
                      },
                    ),
                    const SizedBox(height: 20),
                    AnimatedSwitcher(
                      duration: const Duration(milliseconds: 220),
                      child: _error == null
                          ? const SizedBox.shrink()
                          : Container(
                              key: ValueKey(_error),
                              margin: const EdgeInsets.only(bottom: 14),
                              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                              decoration: BoxDecoration(color: p.bad.withValues(alpha: 0.09), borderRadius: BorderRadius.circular(12)),
                              child: Row(children: [
                                Icon(Icons.error_outline_rounded, color: p.bad, size: 18),
                                const SizedBox(width: 10),
                                Expanded(child: Text(_error!, style: TextStyle(color: p.bad, fontSize: 14))),
                              ]),
                            ),
                    ),
                    FilledButton(
                      onPressed: busy ? null : _submit,
                      child: AnimatedSwitcher(
                        duration: const Duration(milliseconds: 200),
                        child: busy
                            ? Row(key: ValueKey(_phase), mainAxisSize: MainAxisSize.min, children: [
                                SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: p.muted)),
                                const SizedBox(width: 12),
                                Text(_phase == _Phase.deriving ? '正在派生密钥…' : '正在连接…', style: TextStyle(color: p.muted)),
                              ])
                            : const Text('继续', key: ValueKey('go')),
                      ),
                    ),
                    const SizedBox(height: 28),
                    Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Icon(Icons.lock_outline_rounded, size: 15, color: p.muted),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          '口令在本地经 scrypt 拉伸，不会离开这台设备。\n消息使用 XChaCha20-Poly1305 端到端加密，服务器只转发密文。',
                          style: TextStyle(color: p.muted, fontSize: 12, height: 1.6),
                        ),
                      ),
                    ]),
                    const SizedBox(height: 14),
                    Text('v$appVersion', textAlign: TextAlign.right, style: TextStyle(color: p.muted.withValues(alpha: 0.7), fontSize: 11.5)),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _label(String t, Palette p) => Padding(
        padding: const EdgeInsets.only(left: 2, bottom: 8),
        child: Text(t, style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: p.text)),
      );

  Widget _hintRow(Widget child) => Padding(padding: const EdgeInsets.fromLTRB(4, 7, 4, 11), child: SizedBox(height: 17, child: child));
}

class _RememberRow extends StatelessWidget {
  const _RememberRow({required this.value, required this.onChanged});
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: () => onChanged(!value),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
        child: Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('在本机记住口令', style: TextStyle(fontSize: 14.5, color: p.text)),
              const SizedBox(height: 2),
              Text('使用系统密钥库加密保存，只能在这台手机上解开', style: TextStyle(fontSize: 12, color: p.muted)),
            ]),
          ),
          Switch(value: value, onChanged: onChanged),
        ]),
      ),
    );
  }
}
