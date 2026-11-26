// 时间线上的各类消息：我的气泡 / 对方的回复（类 AI 回答的排版）/ 动作 / 系统提示 / 附件
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:video_player/video_player.dart';

import '../chat/chat_controller.dart';
import '../chat/models.dart';
import '../core/media.dart';
import 'theme.dart';
import 'widgets.dart';

/// 焚毁动画：模糊 + 淡出 + 收起高度
class BurnWrap extends StatelessWidget {
  const BurnWrap({super.key, required this.burning, required this.child});
  final bool burning;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: burning ? 1 : 0),
      duration: const Duration(milliseconds: 600),
      curve: Curves.easeInCubic,
      child: child,
      builder: (_, v, child) {
        if (v == 0) return child!;
        return ClipRect(
          child: Align(
            alignment: Alignment.topCenter,
            heightFactor: (1 - Curves.easeIn.transform((v - 0.35).clamp(0, 1) / 0.65)).clamp(0, 1),
            child: Opacity(
              opacity: (1 - v).clamp(0, 1),
              child: ImageFiltered(imageFilter: ui.ImageFilter.blur(sigmaX: v * 6, sigmaY: v * 6), child: child),
            ),
          ),
        );
      },
    );
  }
}

/// 新消息出现：轻微上浮 + 淡入
class AppearWrap extends StatelessWidget {
  const AppearWrap({super.key, required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: 1),
        duration: const Duration(milliseconds: 280),
        curve: Curves.easeOutCubic,
        child: child,
        builder: (_, v, child) => Opacity(opacity: v, child: Transform.translate(offset: Offset(0, 10 * (1 - v)), child: child)),
      );
}

class EntryView extends StatelessWidget {
  const EntryView({super.key, required this.entry, required this.chat, required this.showHeader, required this.onLongPress, required this.onOpenImage});
  final Entry entry;
  final ChatController chat;
  final bool showHeader;
  final void Function(ChatItem) onLongPress;
  final void Function(ChatItem) onOpenImage;

  @override
  Widget build(BuildContext context) {
    final e = entry;
    final Widget child = switch (e) {
      CompactNote() => const _Compact(),
      SysNote() => _Sys(note: e, chat: chat),
      ChatItem(kind: ItemKind.action) => _ActionRow(it: e, chat: chat, onLongPress: onLongPress),
      ChatItem(kind: ItemKind.media) => _MediaMessage(it: e, chat: chat, showHeader: showHeader, onLongPress: onLongPress, onOpenImage: onOpenImage),
      ChatItem(mine: true) => _MyBubble(it: e, chat: chat, onLongPress: onLongPress),
      ChatItem() => _TheirMessage(it: e, chat: chat, showHeader: showHeader, onLongPress: onLongPress),
    };
    return BurnWrap(burning: e is ChatItem && e.burning, child: AppearWrap(child: child));
  }
}

/* ---------------- 我发出的文字 ---------------- */

class _MyBubble extends StatelessWidget {
  const _MyBubble({required this.it, required this.chat, required this.onLongPress});
  final ChatItem it;
  final ChatController chat;
  final void Function(ChatItem) onLongPress;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final w = MediaQuery.sizeOf(context).width;
    return Padding(
      padding: const EdgeInsets.fromLTRB(56, 10, 16, 2),
      child: Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
        GestureDetector(
          onLongPress: () => onLongPress(it),
          child: Container(
            constraints: BoxConstraints(maxWidth: w * 0.8),
            padding: const EdgeInsets.fromLTRB(16, 11, 16, 11),
            decoration: BoxDecoration(color: p.bubble, borderRadius: BorderRadius.circular(20)),
            child: MessageText(it.text ?? '', style: TextStyle(fontSize: 16, height: 1.5, color: p.text)),
          ),
        ),
        const SizedBox(height: 5),
        Row(mainAxisSize: MainAxisSize.min, children: [
          if (it.ttlStart != null) SizedBox(width: 48, child: CountdownBar(start: it.ttlStart!, seconds: it.ttlSec)),
          if (it.ttlStart != null) const SizedBox(width: 8),
          ReceiptIcon(it: it, chat: chat),
        ]),
      ]),
    );
  }
}

/// 已读状态：虚线圈 = 未送达，单勾 = 已发送，绿色双勾 = 已读（群聊显示 n/总数）
class ReceiptIcon extends StatelessWidget {
  const ReceiptIcon({super.key, required this.it, required this.chat});
  final ChatItem it;
  final ChatController chat;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final n = it.readBy.length, total = it.total;
    final done = chat.receiptDone(it);
    final names = it.readBy.map((c) => chat.members[c]).whereType<Member>().map((m) => chat.labelOf(m).text).toList();
    IconData icon;
    Color color;
    String count = '', tip;
    if (total == 0 && n == 0) {
      icon = Icons.radio_button_unchecked_rounded;
      color = p.muted.withValues(alpha: 0.6);
      tip = '未送达 · 发送时无人在线';
    } else if (done) {
      icon = Icons.done_all_rounded;
      color = p.good;
      if (total > 1 && n < total) count = '$n/$total';
      tip = total > 1 ? '已读：${names.join('、')}' : '对方已读';
    } else if (n > 0) {
      icon = Icons.done_all_rounded;
      color = p.muted;
      count = '${n.clamp(0, total)}/$total';
      tip = '已读 $count：${names.join('、')}';
    } else {
      icon = Icons.done_rounded;
      color = p.muted;
      if (total > 1) count = '0/$total';
      tip = (it.need?.isEmpty ?? false) ? '已发送 · 对方已离线（未读）' : '已发送 · 未读';
    }
    return Tooltip(
      message: tip,
      triggerMode: TooltipTriggerMode.tap,
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 250),
        transitionBuilder: (c, a) => ScaleTransition(scale: a, child: FadeTransition(opacity: a, child: c)),
        child: Row(
          key: ValueKey('$icon$count${color.toARGB32()}'),
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 15, color: color),
            if (count.isNotEmpty) ...[const SizedBox(width: 3), Text(count, style: TextStyle(fontSize: 11, color: color, fontWeight: FontWeight.w600))],
          ],
        ),
      ),
    );
  }
}

/* ---------------- 对方的消息 ---------------- */

class _SenderHeader extends StatelessWidget {
  const _SenderHeader({required this.it, required this.chat});
  final ChatItem it;
  final ChatController chat;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final m = chat.members[it.cid];
    final l = m != null ? chat.labelOf(m) : const Label('peer', 0);
    final color = memberColors[l.colorIndex];
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(children: [
        const BrandMark(size: 16),
        const SizedBox(width: 8),
        Container(width: 7, height: 7, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
        const SizedBox(width: 6),
        Flexible(child: Text(l.text, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: p.text.withValues(alpha: 0.85)))),
        if (m != null && !m.online) ...[const SizedBox(width: 6), Text('离线', style: TextStyle(fontSize: 11.5, color: p.muted))],
      ]),
    );
  }
}

class _TheirMessage extends StatelessWidget {
  const _TheirMessage({required this.it, required this.chat, required this.showHeader, required this.onLongPress});
  final ChatItem it;
  final ChatController chat;
  final bool showHeader;
  final void Function(ChatItem) onLongPress;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onLongPress: () => onLongPress(it),
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, showHeader ? 18 : 8, 24, 2),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (showHeader) _SenderHeader(it: it, chat: chat),
          Stack(clipBehavior: Clip.none, children: [
            MessageText(
              it.text ?? '',
              style: TextStyle(
                fontFamily: p.proseSerif ? serifFamily : null,
                fontSize: p.proseSerif ? 16.5 : 16,
                height: 1.62,
                color: p.text,
              ),
            ),
            // 未读：左侧一道细的强调色
            Positioned(
              left: -10,
              top: 4,
              bottom: 4,
              child: AnimatedOpacity(
                opacity: it.read ? 0 : 1,
                duration: const Duration(milliseconds: 400),
                child: Container(width: 2.5, decoration: BoxDecoration(color: brand.withValues(alpha: 0.75), borderRadius: BorderRadius.circular(2))),
              ),
            ),
          ]),
          if (it.ttlStart != null) Padding(padding: const EdgeInsets.only(top: 8), child: SizedBox(width: 64, child: CountdownBar(start: it.ttlStart!, seconds: it.ttlSec))),
        ]),
      ),
    );
  }
}

/* ---------------- 动作（拍一拍） ---------------- */

class _ActionRow extends StatelessWidget {
  const _ActionRow({required this.it, required this.chat, required this.onLongPress});
  final ChatItem it;
  final ChatController chat;
  final void Function(ChatItem) onLongPress;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final a = it.action;
    if (a == null) return const SizedBox.shrink();
    final spans = <InlineSpan>[];
    if (it.mine) {
      spans.add(TextSpan(text: '你', style: TextStyle(fontWeight: FontWeight.w600, color: p.text)));
      spans.add(TextSpan(text: a.text(it.target ?? '对方')));
    } else {
      final m = chat.members[it.cid];
      final l = m != null ? chat.labelOf(m) : const Label('peer', 0);
      spans.add(TextSpan(text: l.text, style: TextStyle(fontWeight: FontWeight.w600, color: memberColors[l.colorIndex])));
      spans.add(TextSpan(text: a.text(it.all ? '大家' : '你')));
    }
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 10),
      child: Center(
        child: GestureDetector(
          onLongPress: () => onLongPress(it),
          child: Container(
            padding: const EdgeInsets.fromLTRB(12, 7, 14, 7),
            decoration: BoxDecoration(color: brand.withValues(alpha: 0.08), borderRadius: BorderRadius.circular(20), border: Border.all(color: brand.withValues(alpha: 0.18))),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              const Icon(Icons.waving_hand_rounded, size: 15, color: brand),
              const SizedBox(width: 7),
              Flexible(child: Text.rich(TextSpan(children: spans), style: TextStyle(fontSize: 13.5, color: p.text.withValues(alpha: 0.8)))),
            ]),
          ),
        ),
      ),
    );
  }
}

/* ---------------- 系统提示 ---------------- */

class _Sys extends StatelessWidget {
  const _Sys({required this.note, required this.chat});
  final SysNote note;
  final ChatController chat;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final parts = note.text.split('{who}');
    final m = note.cid != null ? chat.members[note.cid] : null;
    final l = m != null ? chat.labelOf(m) : null;
    final spans = <InlineSpan>[];
    for (var i = 0; i < parts.length; i++) {
      if (i > 0 && l != null) {
        spans.add(TextSpan(text: l.text, style: TextStyle(color: memberColors[l.colorIndex], fontWeight: FontWeight.w600)));
      }
      spans.add(TextSpan(text: parts[i]));
    }
    return AnimatedOpacity(
      opacity: note.fading ? 0 : 1,
      duration: const Duration(milliseconds: 450),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 8),
        child: Text.rich(TextSpan(children: spans), textAlign: TextAlign.center, style: TextStyle(fontSize: 12.5, color: p.muted, height: 1.4)),
      ),
    );
  }
}

class _Compact extends StatelessWidget {
  const _Compact();
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Padding(
      padding: const EdgeInsets.fromLTRB(32, 14, 32, 6),
      child: Row(children: [
        Expanded(child: Divider(color: p.line)),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Row(children: [
            Icon(Icons.local_fire_department_outlined, size: 14, color: p.muted),
            const SizedBox(width: 4),
            Text('更早的消息已焚毁', style: TextStyle(fontSize: 12, color: p.muted)),
          ]),
        ),
        Expanded(child: Divider(color: p.line)),
      ]),
    );
  }
}

/* ---------------- 附件 ---------------- */

class _MediaMessage extends StatelessWidget {
  const _MediaMessage({required this.it, required this.chat, required this.showHeader, required this.onLongPress, required this.onOpenImage});
  final ChatItem it;
  final ChatController chat;
  final bool showHeader;
  final void Function(ChatItem) onLongPress;
  final void Function(ChatItem) onOpenImage;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    if (it.isAudio) {
      final card = _VoiceCard(it: it, chat: chat);
      if (it.mine) {
        return Padding(
          padding: const EdgeInsets.fromLTRB(64, 10, 16, 2),
          child: Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            GestureDetector(onLongPress: () => onLongPress(it), child: card),
          ]),
        );
      }
      return Padding(
        padding: EdgeInsets.fromLTRB(20, showHeader ? 18 : 8, 56, 2),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (showHeader) _SenderHeader(it: it, chat: chat),
          GestureDetector(onLongPress: () => onLongPress(it), child: card),
        ]),
      );
    }
    final card = MediaCard(it: it, chat: chat, onOpenImage: onOpenImage);
    if (it.mine) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(72, 10, 16, 2),
        child: Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
          GestureDetector(onLongPress: () => onLongPress(it), child: card),
          const SizedBox(height: 5),
          Text('${it.isVideo ? '视频' : '图片'} · ${fmtSize(it.size)}${it.isVideo && it.dur > 0 ? ' · ${fmtDur(it.dur)}' : ''}', style: TextStyle(fontSize: 11.5, color: p.muted)),
        ]),
      );
    }
    return Padding(
      padding: EdgeInsets.fromLTRB(20, showHeader ? 18 : 8, 72, 2),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (showHeader) _SenderHeader(it: it, chat: chat),
        GestureDetector(onLongPress: () => onLongPress(it), child: card),
      ]),
    );
  }
}

class _VoiceCard extends StatelessWidget {
  const _VoiceCard({required this.it, required this.chat});
  final ChatItem it;
  final ChatController chat;

  static const _fallbackPeaks = [24, 42, 68, 52, 80, 62, 36, 74, 88, 50, 44, 70, 58, 32, 64, 76, 48, 38, 60, 40];

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final playing = it.status == MediaStatus.viewing;
    final busy = it.status == MediaStatus.opening || it.status == MediaStatus.receiving;
    final canTap = !it.mine && (it.status == MediaStatus.ready || playing);
    final peaks = (it.peaks != null && it.peaks!.isNotEmpty) ? it.peaks! : _fallbackPeaks;
    final lit = playing ? (it.audioProgress * peaks.length).ceil() : 0;
    final durLabel = playing && it.audioRemain != null ? fmtDur(it.audioRemain!) : fmtDur(it.dur);
    final many = it.mine && it.total > 1;
    final earpiece = chat.prefs.voiceEarpiece;

    final (statusText, statusColor) = switch (it.status) {
      MediaStatus.receiving => ('接收中 ${it.pct}%', p.muted),
      MediaStatus.sending => ('加密发送 ${it.pct}%', p.muted),
      MediaStatus.ready => ('单次播完即焚 · 防内录', p.muted),
      MediaStatus.opening => ('解密中…', p.muted),
      MediaStatus.viewing => ('播放中 · 再次点击即焚', brand),
      MediaStatus.sent => ('已发送语音', p.muted),
      MediaStatus.delivered => (many ? '已送达 ${it.recvBy.length}/${it.total} · 等待收听' : '已送达 · 等待收听', p.muted),
      MediaStatus.partview => ('已收听 ${it.viewBy.length}/${it.total}', p.muted),
      MediaStatus.viewed => (many ? '全部已收听' : '对方已收听', p.good),
      MediaStatus.undelivered => ('对方未接收 · 需升级客户端', p.bad),
      MediaStatus.failed => ('传输失败', p.bad),
    };

    final maxW = (MediaQuery.sizeOf(context).width * 0.72).clamp(220.0, 300.0);

    return Container(
      width: maxW,
      decoration: BoxDecoration(
        color: it.mine ? p.bubble : p.panel,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: playing ? brand.withValues(alpha: 0.65) : p.line.withValues(alpha: 0.7)),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 11, 12, 8),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Row(children: [
              Pressable(
                haptic: true,
                onTap: canTap ? () => chat.viewMedia(it) : null,
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 180),
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: it.mine
                        ? p.text.withValues(alpha: 0.1)
                        : playing
                            ? p.bad
                            : (canTap ? p.text : p.muted.withValues(alpha: 0.25)),
                    shape: BoxShape.circle,
                  ),
                  alignment: Alignment.center,
                  child: busy
                      ? SizedBox(width: 15, height: 15, child: CircularProgressIndicator(strokeWidth: 1.8, color: p.bg))
                      : Icon(
                          it.mine
                              ? Icons.mic_none_rounded
                              : playing
                                  ? Icons.stop_rounded
                                  : Icons.play_arrow_rounded,
                          size: 20,
                          color: it.mine ? p.text : (playing ? Colors.white : p.bg),
                        ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: SizedBox(
                  height: 26,
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      for (var i = 0; i < peaks.length; i++)
                        Expanded(
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 1),
                            child: FractionallySizedBox(
                              heightFactor: (peaks[i].clamp(18, 100)) / 100.0,
                              child: DecoratedBox(
                                decoration: BoxDecoration(
                                  color: i < lit ? brand : p.muted.withValues(alpha: 0.35),
                                  borderRadius: BorderRadius.circular(2),
                                ),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                durLabel,
                style: TextStyle(fontFamily: monoFamily, fontSize: 12.5, fontWeight: FontWeight.w600, color: p.text, fontFeatures: const [FontFeature.tabularFigures()]),
              ),
            ]),
            const SizedBox(height: 6),
            Row(children: [
              Expanded(
                child: Text(statusText, style: TextStyle(fontSize: 11.5, color: statusColor, fontWeight: playing || it.status == MediaStatus.viewed ? FontWeight.w500 : FontWeight.w400), overflow: TextOverflow.ellipsis),
              ),
              if (!it.mine && (it.status == MediaStatus.ready || playing))
                GestureDetector(
                  onTap: () {
                    HapticFeedback.selectionClick();
                    chat.toggleVoiceEarpiece();
                  },
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                    decoration: BoxDecoration(
                      color: p.bubble.withValues(alpha: 0.9),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: p.line),
                    ),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Icon(earpiece ? Icons.hearing_rounded : Icons.volume_up_rounded, size: 12, color: p.muted),
                      const SizedBox(width: 3),
                      Text(earpiece ? '听筒' : '外放', style: TextStyle(fontSize: 11, color: p.muted)),
                    ]),
                  ),
                )
              else
                Text(fmtSize(it.size), style: TextStyle(fontSize: 11, color: p.muted)),
            ]),
          ]),
        ),
        SizedBox(
          height: 2.5,
          child: LinearProgressIndicator(
            value: playing ? it.audioProgress : 0,
            backgroundColor: Colors.transparent,
            color: brand,
          ),
        ),
      ]),
    );
  }
}

class MediaCard extends StatelessWidget {
  const MediaCard({super.key, required this.it, required this.chat, required this.onOpenImage});
  final ChatItem it;
  final ChatController chat;
  final void Function(ChatItem) onOpenImage;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final maxW = MediaQuery.sizeOf(context).width * 0.66;
    final ratio = (it.w / it.h).clamp(0.6, 1.9);
    final width = maxW.clamp(160.0, 300.0);
    final height = (width / ratio).clamp(120.0, 340.0);
    final revealed = it.plain != null || (it.video?.value.isInitialized ?? false);

    Widget content;
    if (it.plain != null) {
      content = GestureDetector(
        onTap: () => onOpenImage(it),
        child: Image.memory(it.plain!, fit: BoxFit.cover, gaplessPlayback: true, width: width, height: height),
      );
    } else if (it.video != null && it.video!.value.isInitialized) {
      content = _InlineVideo(controller: it.video!);
    } else {
      content = Stack(fit: StackFit.expand, children: [
        if (it.thumb != null)
          ImageFiltered(
            imageFilter: ui.ImageFilter.blur(sigmaX: 14, sigmaY: 14, tileMode: TileMode.decal),
            child: Image.memory(it.thumb!, fit: BoxFit.cover, gaplessPlayback: true),
          )
        else
          DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [p.bubble, p.hover, p.line]),
            ),
          ),
        ColoredBox(color: Colors.black.withValues(alpha: 0.18)),
        Center(child: _overlay(context)),
      ]);
    }

    return AnimatedContainer(
      duration: const Duration(milliseconds: 300),
      width: width,
      height: height,
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(18), color: p.bubble, border: Border.all(color: p.line.withValues(alpha: 0.6))),
      clipBehavior: Clip.antiAlias,
      child: Stack(fit: StackFit.expand, children: [
        AnimatedSwitcher(duration: const Duration(milliseconds: 350), child: KeyedSubtree(key: ValueKey(revealed), child: content)),
        if (it.cdStart != null)
          Positioned(left: 10, right: 10, bottom: 8, child: CountdownBar(start: it.cdStart!, seconds: it.cdSec, color: Colors.white, height: 3)),
      ]),
    );
  }

  Widget _overlay(BuildContext context) {
    final n = chat.cfg.mview;
    final many = it.mine && it.total > 1;
    Widget pill(String text, {bool spin = false, Color? color, IconData? icon}) => Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.48), borderRadius: BorderRadius.circular(20)),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            if (spin) const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.6, color: Colors.white)),
            if (icon != null) Icon(icon, size: 14, color: color ?? Colors.white),
            if (spin || icon != null) const SizedBox(width: 7),
            Flexible(child: Text(text, style: TextStyle(color: color ?? Colors.white, fontSize: 12.5, fontWeight: FontWeight.w500))),
          ]),
        );
    return switch (it.status) {
      MediaStatus.receiving => pill('接收中 ${it.pct}%', spin: true),
      MediaStatus.sending => pill('加密发送 ${it.pct}%', spin: true),
      MediaStatus.ready => Pressable(
          haptic: true,
          onTap: () => chat.viewMedia(it),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.94), borderRadius: BorderRadius.circular(24), boxShadow: const [BoxShadow(color: Color(0x33000000), blurRadius: 12, offset: Offset(0, 3))]),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(it.isVideo ? Icons.play_arrow_rounded : Icons.visibility_outlined, size: 18, color: const Color(0xFF2B2A27)),
              const SizedBox(width: 6),
              Text(it.isVideo ? '播放 · 结束后 ${n}s 焚毁' : '查看 · ${n}s', style: const TextStyle(color: Color(0xFF2B2A27), fontSize: 13.5, fontWeight: FontWeight.w600)),
            ]),
          ),
        ),
      MediaStatus.opening => pill('解密中…', spin: true),
      MediaStatus.viewing => const SizedBox.shrink(),
      MediaStatus.sent => pill('已发送', icon: Icons.done_rounded),
      MediaStatus.delivered => pill(many ? '已送达 ${it.recvBy.length}/${it.total} · 等待查看' : '已送达 · 等待对方查看', icon: Icons.done_rounded),
      MediaStatus.partview => pill('已查看 ${it.viewBy.length}/${it.total}', icon: Icons.done_all_rounded),
      MediaStatus.viewed => pill(many ? '所有人都已查看' : '对方已查看', icon: Icons.done_all_rounded, color: const Color(0xFF8BE0A4)),
      MediaStatus.undelivered => pill('对方未接收 · 可能需要更新客户端', icon: Icons.info_outline_rounded, color: const Color(0xFFFFB4A8)),
      MediaStatus.failed => pill('传输失败', icon: Icons.error_outline_rounded, color: const Color(0xFFFFB4A8)),
    };
  }
}

class _InlineVideo extends StatefulWidget {
  const _InlineVideo({required this.controller});
  final VideoPlayerController controller;
  @override
  State<_InlineVideo> createState() => _InlineVideoState();
}

class _InlineVideoState extends State<_InlineVideo> {
  VideoPlayerController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.addListener(_tick);
  }

  @override
  void didUpdateWidget(_InlineVideo old) {
    super.didUpdateWidget(old);
    if (old.controller != c) {
      old.controller.removeListener(_tick);
      c.addListener(_tick);
    }
  }

  @override
  void dispose() {
    c.removeListener(_tick);
    super.dispose();
  }

  void _tick() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final v = c.value;
    final total = v.duration.inMilliseconds;
    final frac = total > 0 ? (v.position.inMilliseconds / total).clamp(0.0, 1.0) : 0.0;
    return GestureDetector(
      onTap: () {
        HapticFeedback.selectionClick();
        v.isPlaying ? c.pause() : c.play();
      },
      child: Stack(fit: StackFit.expand, children: [
        ColoredBox(color: Colors.black, child: FittedBox(fit: BoxFit.cover, clipBehavior: Clip.hardEdge, child: SizedBox(width: v.size.width, height: v.size.height, child: VideoPlayer(c)))),
        AnimatedOpacity(
          opacity: v.isPlaying ? 0 : 1,
          duration: const Duration(milliseconds: 200),
          child: Center(
            child: Container(
              width: 52,
              height: 52,
              decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.45), shape: BoxShape.circle),
              child: const Icon(Icons.play_arrow_rounded, color: Colors.white, size: 32),
            ),
          ),
        ),
        Positioned(
          left: 12,
          right: 12,
          bottom: 18,
          child: Row(children: [
            Text(fmtDur(v.position.inMilliseconds / 1000), style: const TextStyle(color: Colors.white, fontSize: 11, fontFeatures: [FontFeature.tabularFigures()])),
            const SizedBox(width: 8),
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(2),
                child: LinearProgressIndicator(value: frac, minHeight: 3, backgroundColor: Colors.white24, color: Colors.white),
              ),
            ),
            const SizedBox(width: 8),
            Text(fmtDur(total / 1000), style: const TextStyle(color: Colors.white70, fontSize: 11, fontFeatures: [FontFeature.tabularFigures()])),
          ]),
        ),
      ]),
    );
  }
}

/// 全屏查看图片（随消息焚毁自动关闭）
class ImageViewerPage extends StatelessWidget {
  const ImageViewerPage({super.key, required this.it, required this.chat});
  final ChatItem it;
  final ChatController chat;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: chat,
      builder: (context, _) {
        final bytes = it.plain;
        if (bytes == null) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (context.mounted && ModalRoute.of(context)?.isCurrent == true) Navigator.of(context).pop();
          });
        }
        return Scaffold(
          backgroundColor: Colors.black,
          body: Stack(fit: StackFit.expand, children: [
            Positioned.fill(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => Navigator.of(context).pop(),
                child: bytes == null
                    ? const SizedBox.shrink()
                    : InteractiveViewer(
                        minScale: 1,
                        maxScale: 5,
                        child: SizedBox.expand(
                          child: Image.memory(bytes, fit: BoxFit.contain, gaplessPlayback: true),
                        ),
                      ),
              ),
            ),
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: SafeArea(
                bottom: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(8, 4, 16, 0),
                  child: Row(children: [
                    IconButton(onPressed: () => Navigator.of(context).pop(), icon: const Icon(Icons.close_rounded, color: Colors.white)),
                    const SizedBox(width: 8),
                    if (it.cdStart != null) Expanded(child: CountdownBar(start: it.cdStart!, seconds: it.cdSec, color: Colors.white, height: 3)),
                  ]),
                ),
              ),
            ),
          ]),
        );
      },
    );
  }
}
