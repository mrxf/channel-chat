// 侧边抽屉：群聊 + 每个在线成员一条私聊，带未读数
import 'package:flutter/material.dart';

import '../chat/chat_controller.dart';
import '../chat/models.dart';
import '../core/net.dart';
import 'theme.dart';
import 'widgets.dart';

class ConvDrawer extends StatelessWidget {
  const ConvDrawer({super.key, required this.chat, required this.onSettings, required this.onLeave});
  final ChatController chat;
  final VoidCallback onSettings;
  final VoidCallback onLeave;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Drawer(
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.horizontal(right: Radius.circular(24))),
      child: SafeArea(
        child: ListenableBuilder(
          listenable: chat,
          builder: (context, _) {
            final labels = chat.labels();
            final dms = chat.members.values.where((m) => m.online || chat.convItems(dmConv(m.cid)).isNotEmpty).toList()
              ..sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) != 0 ? (b.online ? 1 : 0) - (a.online ? 1 : 0) : a.seq.compareTo(b.seq));
            final others = chat.onlineMembers.length;
            return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(22, 18, 16, 6),
                child: Row(children: [
                  const BrandMark(size: 22),
                  const SizedBox(width: 10),
                  Text('ChatBuddy', style: TextStyle(fontFamily: serifFamily, fontSize: 22, fontWeight: FontWeight.w600, color: p.text)),
                ]),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(22, 0, 16, 14),
                child: Text(
                  chat.serverName.isNotEmpty ? '${chat.serverName} · ${shortServer(chat.wsUrl!)}' : (chat.wsUrl != null ? shortServer(chat.wsUrl!) : ''),
                  style: TextStyle(fontSize: 12.5, color: p.muted),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Expanded(
                child: ListView(padding: const EdgeInsets.symmetric(horizontal: 10), children: [
                  _ConvTile(
                    selected: chat.active == group,
                    leading: Container(
                      width: 38,
                      height: 38,
                      decoration: BoxDecoration(color: brand.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(12)),
                      child: const Icon(Icons.forum_rounded, size: 20, color: brand),
                    ),
                    title: '群聊',
                    subtitle: others > 0 ? '你和 $others 人在线' : '等待其他人加入',
                    unread: chat.unreadIn(group),
                    onTap: () => _go(context, group),
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(14, 20, 14, 8),
                    child: Text('私聊', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: p.muted)),
                  ),
                  if (dms.isEmpty)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(14, 4, 14, 8),
                      child: Text('其他人上线后会出现在这里，私聊内容只发给对方。', style: TextStyle(fontSize: 13, color: p.muted, height: 1.5)),
                    ),
                  for (final m in dms)
                    _ConvTile(
                      selected: chat.active == dmConv(m.cid),
                      leading: Stack(clipBehavior: Clip.none, children: [
                        Avatar(name: labels[m.cid]?.text ?? m.name, color: memberColors[labels[m.cid]?.colorIndex ?? 0], size: 38),
                        Positioned(
                          right: -1,
                          bottom: -1,
                          child: Container(
                            width: 12,
                            height: 12,
                            decoration: BoxDecoration(color: m.online ? p.good : p.muted, shape: BoxShape.circle, border: Border.all(color: p.side, width: 2)),
                          ),
                        ),
                      ]),
                      title: labels[m.cid]?.text ?? m.name,
                      subtitle: m.online ? (m.hasCap('dm') ? '在线' : '在线 · 客户端较旧，不支持私聊') : '离线',
                      unread: chat.unreadIn(dmConv(m.cid)),
                      onTap: () => _go(context, dmConv(m.cid)),
                    ),
                ]),
              ),
              Divider(color: p.line, height: 1),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
                child: Row(children: [
                  Avatar(name: chat.name, color: p.text, size: 36),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(chat.name, style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: p.text), overflow: TextOverflow.ellipsis),
                      const SizedBox(height: 2),
                      Row(children: [
                        StatusDot(color: chat.conn == ConnState.online ? p.good : const Color(0xFFE0A030), size: 7, pulse: chat.conn != ConnState.online),
                        const SizedBox(width: 6),
                        Text(chat.conn == ConnState.online ? '已连接 · ${chat.online} 人在线' : '正在重新连接…', style: TextStyle(fontSize: 12, color: p.muted)),
                      ]),
                    ]),
                  ),
                  IconButton(tooltip: '设置', onPressed: onSettings, icon: Icon(Icons.tune_rounded, color: p.muted)),
                  IconButton(tooltip: '退出会话', onPressed: onLeave, icon: Icon(Icons.logout_rounded, color: p.muted)),
                ]),
              ),
            ]);
          },
        ),
      ),
    );
  }

  void _go(BuildContext context, String conv) {
    chat.switchConv(conv);
    Navigator.of(context).pop();
  }
}

class _ConvTile extends StatelessWidget {
  const _ConvTile({required this.selected, required this.leading, required this.title, required this.subtitle, required this.unread, required this.onTap});
  final bool selected;
  final Widget leading;
  final String title;
  final String subtitle;
  final int unread;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Material(
        color: selected ? p.hover : Colors.transparent,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
            child: Row(children: [
              leading,
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(title, style: TextStyle(fontSize: 15, fontWeight: selected ? FontWeight.w600 : FontWeight.w500, color: p.text), overflow: TextOverflow.ellipsis),
                  const SizedBox(height: 2),
                  Text(subtitle, style: TextStyle(fontSize: 12.5, color: p.muted), overflow: TextOverflow.ellipsis),
                ]),
              ),
              AnimatedScale(
                scale: unread > 0 ? 1 : 0,
                duration: const Duration(milliseconds: 200),
                curve: Curves.easeOutBack,
                child: Container(
                  constraints: const BoxConstraints(minWidth: 20),
                  height: 20,
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(color: brand, borderRadius: BorderRadius.circular(10)),
                  child: Text(unread > 99 ? '99+' : '$unread', style: const TextStyle(color: Colors.white, fontSize: 11.5, fontWeight: FontWeight.w700)),
                ),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}
