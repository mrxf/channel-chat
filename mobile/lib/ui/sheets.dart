// 「＋」面板：相册 / 拍照 / 视频 / 拍一拍；以及拍一拍面板
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../chat/chat_controller.dart';
import '../core/prefs.dart';
import 'theme.dart';
import 'widgets.dart';

enum AttachChoice { gallery, camera, video, action }

Future<AttachChoice?> showAttachSheet(BuildContext context) {
  final p = context.pal;
  Widget tile(BuildContext ctx, IconData icon, String label, AttachChoice c, {Color? color}) => Expanded(
        child: Pressable(
          haptic: true,
          onTap: () => Navigator.pop(ctx, c),
          child: Column(children: [
            Container(
              height: 64,
              decoration: BoxDecoration(color: p.bubble, borderRadius: BorderRadius.circular(18)),
              child: Center(child: Icon(icon, size: 26, color: color ?? p.text)),
            ),
            const SizedBox(height: 8),
            Text(label, style: TextStyle(fontSize: 13, color: p.text)),
          ]),
        ),
      );
  return showModalBottomSheet<AttachChoice>(
    context: context,
    builder: (ctx) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            tile(ctx, Icons.photo_library_outlined, '相册', AttachChoice.gallery),
            const SizedBox(width: 12),
            tile(ctx, Icons.photo_camera_outlined, '拍照', AttachChoice.camera),
            const SizedBox(width: 12),
            tile(ctx, Icons.videocam_outlined, '视频', AttachChoice.video),
            const SizedBox(width: 12),
            tile(ctx, Icons.waving_hand_outlined, '拍一拍', AttachChoice.action, color: brand),
          ]),
          const SizedBox(height: 16),
          Row(children: [
            Icon(Icons.shield_outlined, size: 14, color: p.muted),
            const SizedBox(width: 6),
            Expanded(
              child: Text('图片发送前会重新编码并去除位置等元数据；对方收到时是模糊的，点开才解密，看完自动焚毁。',
                  style: TextStyle(fontSize: 12, color: p.muted, height: 1.5)),
            ),
          ]),
        ]),
      ),
    ),
  );
}

Future<void> showActionSheet(BuildContext context, ChatController chat, Prefs prefs) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(ctx).bottom),
      child: _ActionSheet(chat: chat, prefs: prefs),
    ),
  );
}

class _ActionSheet extends StatefulWidget {
  const _ActionSheet({required this.chat, required this.prefs});
  final ChatController chat;
  final Prefs prefs;
  @override
  State<_ActionSheet> createState() => _ActionSheetState();
}

class _ActionSheetState extends State<_ActionSheet> {
  final _prefix = TextEditingController();
  final _suffix = TextEditingController();

  @override
  void initState() {
    super.initState();
    _prefix.addListener(() => setState(() {}));
    _suffix.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _prefix.dispose();
    _suffix.dispose();
    super.dispose();
  }

  ActionDef? get _custom => ActionDef.sanitize({'prefix': _prefix.text, 'suffix': _suffix.text}, maxLen: widget.chat.maxActionLen);

  void _send(ActionDef a) {
    if (widget.chat.sendAction(a)) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final chat = widget.chat;
    final t = chat.actionTarget();
    final custom = widget.prefs.customActions;
    final len = _prefix.text.trim().length + _suffix.text.trim().length;
    final over = len > chat.maxActionLen;
    final preview = _prefix.text.trim().isEmpty
        ? '…'
        : '${chat.name}${ActionDef(_prefix.text.trim(), _suffix.text.trim()).text(t.all ? '大家' : '你')}';
    Widget chip(ActionDef a, {VoidCallback? onDelete}) => Pressable(
          haptic: true,
          onTap: () => _send(a),
          child: Container(
            padding: EdgeInsets.fromLTRB(14, 9, onDelete != null ? 6 : 14, 9),
            decoration: BoxDecoration(color: onDelete != null ? brand.withValues(alpha: 0.08) : p.bubble, borderRadius: BorderRadius.circular(20)),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Text(a.text('对方'), style: TextStyle(fontSize: 14, color: p.text)),
              if (onDelete != null)
                GestureDetector(
                  onTap: onDelete,
                  child: Padding(padding: const EdgeInsets.only(left: 6), child: Icon(Icons.close_rounded, size: 16, color: p.muted)),
                ),
            ]),
          ),
        );
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
          Text('拍一拍 ${t.who}', style: TextStyle(fontFamily: serifFamily, fontSize: 21, fontWeight: FontWeight.w600, color: p.text)),
          const SizedBox(height: 4),
          Text('对方手机会震动一下，电脑窗口会抖一下', style: TextStyle(fontSize: 12.5, color: p.muted)),
          const SizedBox(height: 16),
          if (chat.serverActions.isEmpty && custom.isEmpty)
            Text('服务器没有预制动作，可以在下面自定义', style: TextStyle(fontSize: 13, color: p.muted))
          else
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final a in chat.serverActions) chip(a),
              for (final a in custom)
                chip(a, onDelete: () async {
                  await widget.prefs.setCustomActions(custom.where((c) => c != a).toList());
                  setState(() {});
                }),
            ]),
          const SizedBox(height: 22),
          Text('自定义', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: p.text)),
          const SizedBox(height: 8),
          Row(children: [
            Expanded(child: TextField(controller: _prefix, decoration: const InputDecoration(hintText: '拍了拍', isDense: true))),
            Padding(padding: const EdgeInsets.symmetric(horizontal: 8), child: Text('对方的', style: TextStyle(color: p.muted, fontSize: 14))),
            Expanded(child: TextField(controller: _suffix, decoration: const InputDecoration(hintText: '肩膀（可空）', isDense: true))),
          ]),
          const SizedBox(height: 8),
          Row(children: [
            Expanded(child: Text('${t.who}会看到：$preview', style: TextStyle(fontSize: 12.5, color: p.muted), maxLines: 2, overflow: TextOverflow.ellipsis)),
            Text('$len/${chat.maxActionLen}', style: TextStyle(fontSize: 12, color: over ? p.bad : p.muted)),
          ]),
          const SizedBox(height: 14),
          Row(children: [
            Expanded(
              child: OutlinedButton(
                onPressed: _custom == null
                    ? null
                    : () async {
                        final a = _custom!;
                        if (!custom.contains(a)) await widget.prefs.setCustomActions([...custom, a]);
                        HapticFeedback.lightImpact();
                        setState(() {});
                      },
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size.fromHeight(46),
                  foregroundColor: p.text,
                  side: BorderSide(color: p.line),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                ),
                child: const Text('存为常用'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: FilledButton(
                onPressed: _custom == null ? null : () => _send(_custom!),
                style: FilledButton.styleFrom(backgroundColor: brand, foregroundColor: Colors.white, minimumSize: const Size.fromHeight(46), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
                child: const Text('发送'),
              ),
            ),
          ]),
        ]),
      ),
    );
  }
}
