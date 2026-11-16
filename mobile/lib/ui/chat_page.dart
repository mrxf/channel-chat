// 主界面：顶栏（会话名 + 在线状态）、消息流、底部输入框
import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';

import '../chat/chat_controller.dart';
import '../chat/models.dart';
import '../core/media.dart';
import '../core/native.dart';
import '../core/net.dart';
import '../core/prefs.dart';
import 'drawer.dart';
import 'messages.dart';
import 'settings_page.dart';
import 'sheets.dart';
import 'theme.dart';
import 'widgets.dart';

class ChatPage extends StatefulWidget {
  const ChatPage({super.key, required this.chat, required this.prefs});
  final ChatController chat;
  final Prefs prefs;
  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> with SingleTickerProviderStateMixin {
  final _scaffold = GlobalKey<ScaffoldState>();
  final _input = TextEditingController();
  final _focus = FocusNode();
  final _scroll = ScrollController();
  late final _shake = AnimationController(vsync: this, duration: const Duration(milliseconds: 480));
  StreamSubscription<String>? _toastSub;
  StreamSubscription<void>? _nudgeSub;
  bool _showJump = false;
  bool _preparing = false;
  String _lastConv = group;
  int _lastCount = 0;

  ChatController get chat => widget.chat;

  @override
  void initState() {
    super.initState();
    _toastSub = chat.toasts.listen(_toast);
    _nudgeSub = chat.nudges.listen((_) => _shake.forward(from: 0));
    _input.addListener(() => setState(() {}));
    _scroll.addListener(() {
      final show = _scroll.hasClients && _scroll.offset > 400;
      if (show != _showJump) setState(() => _showJump = show);
    });
    chat.addListener(_onChat);
  }

  @override
  void dispose() {
    chat.removeListener(_onChat);
    _toastSub?.cancel();
    _nudgeSub?.cancel();
    _shake.dispose();
    _input.dispose();
    _focus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  /// 新消息到达时：如果在底部附近就保持在底部（列表是倒序的，底部 = offset 0）
  void _onChat() {
    final tl = chat.timeline(chat.active);
    if (chat.active != _lastConv) {
      _lastConv = chat.active;
      _lastCount = tl.length;
      if (_scroll.hasClients) _scroll.jumpTo(0);
      return;
    }
    if (tl.length > _lastCount && _scroll.hasClients && _scroll.offset < 160) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) _scroll.animateTo(0, duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
      });
    }
    _lastCount = tl.length;
  }

  void _toast(String t) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(t), duration: const Duration(seconds: 2)));
  }

  void _send() {
    if (chat.sendText(_input.text)) {
      _input.clear();
      if (_scroll.hasClients) _scroll.animateTo(0, duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
    }
  }

  Future<void> _confirmLeave() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('退出会话？'),
        content: const Text('内存里的所有消息会立即清除，无法恢复。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), style: TextButton.styleFrom(foregroundColor: context.pal.bad), child: const Text('退出')),
        ],
      ),
    );
    if (ok == true) {
      if (!mounted) return;
      Navigator.of(context).popUntil((r) => r.isFirst);
      chat.leave();
    }
  }

  void _openSettings() {
    if (_scaffold.currentState?.isDrawerOpen ?? false) Navigator.of(context).pop();
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => SettingsPage(chat: chat, prefs: widget.prefs, onLeave: _confirmLeave),
    ));
  }

  Future<void> _confirmClear() async {
    final peer = chat.convPeer(chat.active);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('清空会话？'),
        content: Text(peer != null ? '你和 ${chat.labelOf(peer).text} 的屏幕都会被清空。' : '群聊里所有在线成员的屏幕都会被清空。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), style: TextButton.styleFrom(foregroundColor: context.pal.bad), child: const Text('清空')),
        ],
      ),
    );
    if (ok == true) {
      chat.clearConv();
      HapticFeedback.mediumImpact();
    }
  }

  /* ---------------- 附件 ---------------- */

  Future<void> _attach() async {
    _focus.unfocus();
    final c = await showAttachSheet(context);
    if (c == null || !mounted) return;
    if (c == AttachChoice.action) {
      await showActionSheet(context, chat, widget.prefs);
      return;
    }
    final blocker = chat.mediaBlocker();
    if (blocker != null) return _toast(blocker);
    final picker = ImagePicker();
    try {
      switch (c) {
        case AttachChoice.gallery:
          final files = await picker.pickMultiImage(limit: 5, requestFullMetadata: false);
          for (final f in files.take(5)) {
            await _sendImage(f);
          }
        case AttachChoice.camera:
          final f = await picker.pickImage(source: ImageSource.camera, requestFullMetadata: false);
          if (f != null) await _sendImage(f);
        case AttachChoice.video:
          final f = await picker.pickVideo(source: ImageSource.gallery);
          if (f != null) await _sendVideo(f);
        case AttachChoice.action:
          break;
      }
    } catch (e) {
      _toast('无法读取文件');
    }
  }

  Future<void> _withPreparing(Future<void> Function() fn) async {
    setState(() => _preparing = true);
    try {
      await fn();
    } on MediaError catch (e) {
      _toast(e.message);
    } finally {
      if (mounted) setState(() => _preparing = false);
    }
  }

  /// 选图器复制到缓存目录的临时文件，读完立即删除
  Future<void> _deleteTemp(XFile f) async {
    try {
      await File(f.path).delete();
    } catch (_) {}
  }

  Future<void> _sendImage(XFile f) => _withPreparing(() async {
        final bytes = await f.readAsBytes();
        final isGif = (f.mimeType ?? '').contains('gif') || f.path.toLowerCase().endsWith('.gif');
        await _deleteTemp(f);
        final prep = await prepareImage(bytes, isGif: isGif);
        await chat.sendMedia(prep);
      });

  Future<void> _sendVideo(XFile f) => _withPreparing(() async {
        try {
          final prep = await prepareVideo(File(f.path));
          await _deleteTemp(f);
          await chat.sendMedia(prep);
        } finally {
          await _deleteTemp(f);
        }
      });

  void _onLongPress(ChatItem it) {
    HapticFeedback.mediumImpact();
    final p = context.pal;
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            if (it.kind == ItemKind.msg && it.text != null)
              ListTile(
                leading: Icon(Icons.copy_rounded, color: p.text),
                title: const Text('复制'),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                onTap: () {
                  Clipboard.setData(ClipboardData(text: it.text!));
                  Navigator.pop(ctx);
                  _toast('已复制');
                },
              ),
            ListTile(
              leading: Icon(Icons.delete_outline_rounded, color: p.bad),
              title: Text('从我的屏幕清除', style: TextStyle(color: p.bad)),
              subtitle: Text('只影响自己，对方的屏幕不变', style: TextStyle(color: p.muted, fontSize: 12.5)),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              onTap: () {
                Navigator.pop(ctx);
                chat.dismiss(it);
              },
            ),
          ]),
        ),
      ),
    );
  }

  void _openImage(ChatItem it) {
    Navigator.of(context).push(PageRouteBuilder<void>(
      opaque: false,
      barrierColor: Colors.black,
      transitionDuration: const Duration(milliseconds: 220),
      pageBuilder: (_, a, _) => FadeTransition(opacity: a, child: ImageViewerPage(it: it, chat: chat)),
    ));
  }

  /* ---------------- 构建 ---------------- */

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        if (_scaffold.currentState?.isDrawerOpen ?? false) {
          Navigator.of(context).pop();
        } else if (chat.active != group) {
          chat.switchConv(group);
        } else {
          Native.moveToBack();
        }
      },
      child: Scaffold(
        key: _scaffold,
        drawerEdgeDragWidth: 48,
        drawer: ConvDrawer(chat: chat, onSettings: _openSettings, onLeave: _confirmLeave),
        onDrawerChanged: (open) {
          if (open) _focus.unfocus();
        },
        appBar: PreferredSize(preferredSize: const Size.fromHeight(60), child: _TopBar(chat: chat, onMenu: () => _scaffold.currentState?.openDrawer(), onSettings: _openSettings, onClear: _confirmClear)),
        body: AnimatedBuilder(
          animation: _shake,
          builder: (_, child) => Transform.translate(offset: Offset(math.sin(_shake.value * math.pi * 6) * 7 * (1 - _shake.value), 0), child: child),
          child: Column(children: [
            _ConnBanner(chat: chat),
            Expanded(
              child: ListenableBuilder(
                listenable: chat,
                builder: (context, _) {
                  final tl = chat.timeline(chat.active);
                  if (tl.isEmpty) return _EmptyState(chat: chat);
                  return Stack(children: [
                    ListView.builder(
                      controller: _scroll,
                      reverse: true,
                      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
                      padding: const EdgeInsets.only(top: 12, bottom: 12),
                      itemCount: tl.length,
                      itemBuilder: (context, i) {
                        final idx = tl.length - 1 - i;
                        final e = tl[idx];
                        var header = true;
                        if (e is ChatItem && !e.mine && idx > 0) {
                          final prev = tl[idx - 1];
                          header = !(prev is ChatItem && !prev.mine && prev.cid == e.cid && prev.kind != ItemKind.action);
                        }
                        return EntryView(key: ObjectKey(e), entry: e, chat: chat, showHeader: header, onLongPress: _onLongPress, onOpenImage: _openImage);
                      },
                    ),
                    Positioned(
                      right: 16,
                      bottom: 12,
                      child: AnimatedScale(
                        scale: _showJump ? 1 : 0,
                        duration: const Duration(milliseconds: 200),
                        curve: Curves.easeOutBack,
                        child: Material(
                          color: p.panel,
                          shape: CircleBorder(side: BorderSide(color: p.line)),
                          elevation: 3,
                          shadowColor: Colors.black26,
                          child: InkWell(
                            customBorder: const CircleBorder(),
                            onTap: () => _scroll.animateTo(0, duration: const Duration(milliseconds: 300), curve: Curves.easeOut),
                            child: Padding(padding: const EdgeInsets.all(9), child: Icon(Icons.arrow_downward_rounded, size: 20, color: p.text)),
                          ),
                        ),
                      ),
                    ),
                  ]);
                },
              ),
            ),
            _Composer(
              chat: chat,
              controller: _input,
              focus: _focus,
              preparing: _preparing,
              onSend: _send,
              onAttach: _attach,
            ),
          ]),
        ),
      ),
    );
  }
}

/* ---------------- 顶栏 ---------------- */

class _TopBar extends StatelessWidget {
  const _TopBar({required this.chat, required this.onMenu, required this.onSettings, required this.onClear});
  final ChatController chat;
  final VoidCallback onMenu;
  final VoidCallback onSettings;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return ListenableBuilder(
      listenable: chat,
      builder: (context, _) {
        final peer = chat.convPeer(chat.active);
        final title = peer != null ? chat.labelOf(peer).text : '群聊';
        final online = chat.conn == ConnState.online;
        String sub;
        Color dot;
        if (!online) {
          sub = '正在重新连接…';
          dot = const Color(0xFFE0A030);
        } else if (peer != null) {
          sub = peer.online ? '私聊 · 在线' : '私聊 · 已离线';
          dot = peer.online ? p.good : p.muted;
        } else {
          final n = chat.onlineMembers.length;
          sub = n > 0 ? '${n + 1} 人在线' : '等待其他人加入';
          dot = n > 0 ? p.good : p.muted;
        }
        final elsewhere = chat.unreadElsewhere;
        return AppBar(
          toolbarHeight: 60,
          leading: IconButton(
            onPressed: onMenu,
            icon: Badge(
              isLabelVisible: elsewhere > 0,
              backgroundColor: brand,
              smallSize: 9,
              label: Text('$elsewhere'),
              child: Icon(Icons.menu_rounded, color: p.text),
            ),
          ),
          title: Column(mainAxisSize: MainAxisSize.min, children: [
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 200),
              child: Text(title, key: ValueKey(title), style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, color: p.text), overflow: TextOverflow.ellipsis),
            ),
            const SizedBox(height: 2),
            Row(mainAxisSize: MainAxisSize.min, children: [
              StatusDot(color: dot, size: 6, pulse: !online),
              const SizedBox(width: 5),
              Text(sub, style: TextStyle(fontSize: 12, color: p.muted, fontWeight: FontWeight.w400)),
            ]),
          ]),
          actions: [
            PopupMenuButton<String>(
              icon: Icon(Icons.more_horiz_rounded, color: p.text),
              position: PopupMenuPosition.under,
              onSelected: (v) {
                switch (v) {
                  case 'wipe':
                    chat.wipeScreen();
                    HapticFeedback.lightImpact();
                  case 'clear':
                    onClear();
                  case 'share':
                    final addr = shortServer(chat.wsUrl!);
                    Clipboard.setData(ClipboardData(text: addr));
                    chat.toast('已复制服务器地址 $addr（口令请单独告诉对方）');
                  case 'settings':
                    onSettings();
                }
              },
              itemBuilder: (_) => [
                _menu('wipe', Icons.cleaning_services_outlined, '清屏', '只清空自己的屏幕', p),
                _menu('clear', Icons.local_fire_department_outlined, '清空会话', '双方屏幕一起清空', p, danger: true),
                const PopupMenuDivider(),
                _menu('share', Icons.link_rounded, '复制服务器地址', null, p),
                _menu('settings', Icons.tune_rounded, '设置', null, p),
              ],
            ),
            const SizedBox(width: 4),
          ],
        );
      },
    );
  }

  PopupMenuItem<String> _menu(String v, IconData icon, String title, String? sub, Palette p, {bool danger = false}) => PopupMenuItem(
        value: v,
        child: Row(children: [
          Icon(icon, size: 20, color: danger ? p.bad : p.text),
          const SizedBox(width: 12),
          Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(title, style: TextStyle(fontSize: 14.5, color: danger ? p.bad : p.text)),
            if (sub != null) Text(sub, style: TextStyle(fontSize: 11.5, color: p.muted)),
          ]),
        ]),
      );
}

class _ConnBanner extends StatelessWidget {
  const _ConnBanner({required this.chat});
  final ChatController chat;
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return ListenableBuilder(
      listenable: chat,
      builder: (context, _) {
        final show = chat.conn == ConnState.reconnecting;
        return AnimatedSize(
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOut,
          child: show
              ? Container(
                  width: double.infinity,
                  margin: const EdgeInsets.fromLTRB(16, 0, 16, 6),
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                  decoration: BoxDecoration(color: const Color(0xFFE0A030).withValues(alpha: 0.12), borderRadius: BorderRadius.circular(12)),
                  child: Row(children: [
                    const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 1.8, color: Color(0xFFE0A030))),
                    const SizedBox(width: 10),
                    Expanded(child: Text('连接已断开，正在重新连接…', style: TextStyle(fontSize: 13, color: p.text.withValues(alpha: 0.8)))),
                  ]),
                )
              : const SizedBox(width: double.infinity),
        );
      },
    );
  }
}

/* ---------------- 空状态 ---------------- */

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.chat});
  final ChatController chat;

  String _greeting() {
    final h = DateTime.now().hour;
    if (h < 5) return '夜深了';
    if (h < 11) return '早上好';
    if (h < 13) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final peer = chat.convPeer(chat.active);
    final cfg = chat.cfg;
    return LayoutBuilder(
      builder: (context, c) => SingleChildScrollView(
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: c.maxHeight),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
              const SpinningMark(size: 34, spinning: false),
              const SizedBox(height: 18),
              Text(
                '${_greeting()}，${chat.name}',
                textAlign: TextAlign.center,
                style: TextStyle(fontFamily: serifFamily, fontSize: 28, height: 1.25, color: p.text, fontWeight: FontWeight.w500),
              ),
              const SizedBox(height: 10),
              Text(
                peer != null ? '与 ${chat.labelOf(peer).text} 的私聊，只有你们两人能收到' : (chat.onlineMembers.isEmpty ? '把服务器地址和口令发给对方，对方加入后就能开始聊天' : '群聊里的消息，在线的人都能看到'),
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 14.5, color: p.muted, height: 1.5),
              ),
              const SizedBox(height: 22),
              Wrap(alignment: WrapAlignment.center, spacing: 8, runSpacing: 8, children: [
                _chip(context, Icons.layers_outlined, '保留 ${cfg.keep} 轮'),
                _chip(context, Icons.timer_outlined, cfg.ttl == 0 ? '已读后不倒计时' : '已读 ${ttlLabel(cfg.ttl)} 后焚毁'),
                _chip(context, Icons.lock_outline_rounded, '端到端加密'),
              ]),
            ]),
          ),
        ),
      ),
    );
  }

  Widget _chip(BuildContext context, IconData icon, String text) {
    final p = context.pal;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
      decoration: BoxDecoration(border: Border.all(color: p.line), borderRadius: BorderRadius.circular(20)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 14, color: p.muted),
        const SizedBox(width: 5),
        Text(text, style: TextStyle(fontSize: 12.5, color: p.muted)),
      ]),
    );
  }
}

/* ---------------- 输入框 ---------------- */

class _Composer extends StatelessWidget {
  const _Composer({required this.chat, required this.controller, required this.focus, required this.preparing, required this.onSend, required this.onAttach});
  final ChatController chat;
  final TextEditingController controller;
  final FocusNode focus;
  final bool preparing;
  final VoidCallback onSend;
  final VoidCallback onAttach;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final canSend = controller.text.trim().isNotEmpty;
    return ListenableBuilder(
      listenable: chat,
      builder: (context, _) {
        final peer = chat.convPeer(chat.active);
        final hint = peer != null ? '发消息给 ${chat.labelOf(peer).text}' : '回复群聊';
        return SafeArea(
          top: false,
          minimum: const EdgeInsets.only(bottom: 8),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
            child: Container(
              decoration: BoxDecoration(
                color: p.panel,
                borderRadius: BorderRadius.circular(26),
                border: Border.all(color: p.line),
                boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.05), blurRadius: 18, offset: const Offset(0, 4))],
              ),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                AnimatedSize(
                  duration: const Duration(milliseconds: 200),
                  child: preparing
                      ? Padding(
                          padding: const EdgeInsets.fromLTRB(18, 12, 18, 0),
                          child: Row(children: [
                            SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.6, color: p.muted)),
                            const SizedBox(width: 8),
                            Text('正在处理附件…', style: TextStyle(fontSize: 12.5, color: p.muted)),
                          ]),
                        )
                      : const SizedBox(width: double.infinity),
                ),
                TextField(
                  controller: controller,
                  focusNode: focus,
                  minLines: 1,
                  maxLines: 6,
                  textCapitalization: TextCapitalization.sentences,
                  keyboardType: TextInputType.multiline,
                  style: TextStyle(fontSize: 16, height: 1.45, color: p.text),
                  decoration: InputDecoration(
                    hintText: hint,
                    filled: false,
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    contentPadding: const EdgeInsets.fromLTRB(18, 14, 18, 6),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                  child: Row(children: [
                    _RoundIcon(icon: Icons.add_rounded, onTap: onAttach, color: p.text, bg: Colors.transparent, border: p.line),
                    const SizedBox(width: 6),
                    _CfgChip(chat: chat),
                    const Spacer(),
                    AnimatedScale(
                      scale: canSend ? 1 : 0.86,
                      duration: const Duration(milliseconds: 180),
                      curve: Curves.easeOutBack,
                      child: _RoundIcon(
                        icon: Icons.arrow_upward_rounded,
                        onTap: canSend ? onSend : null,
                        color: canSend ? Colors.white : p.muted,
                        bg: canSend ? brand : p.bubble,
                      ),
                    ),
                  ]),
                ),
              ]),
            ),
          ),
        );
      },
    );
  }
}

class _RoundIcon extends StatelessWidget {
  const _RoundIcon({required this.icon, required this.onTap, required this.color, required this.bg, this.border});
  final IconData icon;
  final VoidCallback? onTap;
  final Color color;
  final Color bg;
  final Color? border;
  @override
  Widget build(BuildContext context) => Pressable(
        haptic: true,
        onTap: onTap,
        scale: 0.9,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          width: 36,
          height: 36,
          decoration: BoxDecoration(color: bg, shape: BoxShape.circle, border: border != null ? Border.all(color: border!) : null),
          child: Icon(icon, size: 21, color: color),
        ),
      );
}

/// 输入框里的小标签：显示当前焚毁设置，点击进入设置
class _CfgChip extends StatelessWidget {
  const _CfgChip({required this.chat});
  final ChatController chat;
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final cfg = chat.cfg;
    return Container(
      height: 30,
      padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: BoxDecoration(color: p.bubble.withValues(alpha: 0.7), borderRadius: BorderRadius.circular(15)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(Icons.local_fire_department_outlined, size: 14, color: p.muted),
        const SizedBox(width: 4),
        Text('保留 ${cfg.keep}${cfg.ttl > 0 ? ' · ${ttlLabel(cfg.ttl)}' : ''}', style: TextStyle(fontSize: 12, color: p.muted)),
      ]),
    );
  }
}
