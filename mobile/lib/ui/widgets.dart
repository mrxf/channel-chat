// 通用小组件：品牌星标、头像、状态点、按压回弹、消息正文格式化
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'theme.dart';

/// 四角星品牌标记（与桌面端图标同形）
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.size = 20, this.color = brand});
  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) => CustomPaint(size: Size.square(size), painter: _StarPainter(color));
}

class _StarPainter extends CustomPainter {
  _StarPainter(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size s) {
    // 对应 SVG：M12 1.5l2.6 7.9 7.9 2.6-7.9 2.6L12 22.5l-2.6-7.9L1.5 12l7.9-2.6z（viewBox 24）
    final k = s.width / 24;
    final path = Path()
      ..moveTo(12 * k, 1.5 * k)
      ..lineTo(14.6 * k, 9.4 * k)
      ..lineTo(22.5 * k, 12 * k)
      ..lineTo(14.6 * k, 14.6 * k)
      ..lineTo(12 * k, 22.5 * k)
      ..lineTo(9.4 * k, 14.6 * k)
      ..lineTo(1.5 * k, 12 * k)
      ..lineTo(9.4 * k, 9.4 * k)
      ..close();
    canvas.drawPath(path, Paint()..color = color);
  }

  @override
  bool shouldRepaint(_StarPainter old) => old.color != color;
}

/// 缓慢旋转 + 呼吸的星标，用于加载 / 空状态
class SpinningMark extends StatefulWidget {
  const SpinningMark({super.key, this.size = 22, this.spinning = true});
  final double size;
  final bool spinning;
  @override
  State<SpinningMark> createState() => _SpinningMarkState();
}

class _SpinningMarkState extends State<SpinningMark> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 2400));

  @override
  void initState() {
    super.initState();
    if (widget.spinning) _c.repeat();
  }

  @override
  void didUpdateWidget(SpinningMark old) {
    super.didUpdateWidget(old);
    if (widget.spinning && !_c.isAnimating) _c.repeat();
    if (!widget.spinning && _c.isAnimating) _c.animateTo(1, duration: const Duration(milliseconds: 400), curve: Curves.easeOut);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: _c,
        builder: (_, child) {
          final t = Curves.easeInOutCubic.transform(_c.value);
          final scale = 1 - 0.12 * math.sin(_c.value * math.pi);
          return Transform.rotate(angle: t * math.pi / 2, child: Transform.scale(scale: scale, child: child));
        },
        child: BrandMark(size: widget.size),
      );
}

class Avatar extends StatelessWidget {
  const Avatar({super.key, required this.name, required this.color, this.size = 32});
  final String name;
  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) {
    final ch = name.isEmpty ? '?' : name.characters.first.toUpperCase();
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: color.withValues(alpha: 0.16), shape: BoxShape.circle),
      child: Text(ch, style: TextStyle(color: color, fontWeight: FontWeight.w700, fontSize: size * 0.42, height: 1)),
    );
  }
}

class StatusDot extends StatelessWidget {
  const StatusDot({super.key, required this.color, this.size = 8, this.pulse = false});
  final Color color;
  final double size;
  final bool pulse;

  @override
  Widget build(BuildContext context) {
    final dot = Container(width: size, height: size, decoration: BoxDecoration(color: color, shape: BoxShape.circle));
    if (!pulse) return dot;
    return _Pulse(child: dot);
  }
}

class _Pulse extends StatefulWidget {
  const _Pulse({required this.child});
  final Widget child;
  @override
  State<_Pulse> createState() => _PulseState();
}

class _PulseState extends State<_Pulse> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..repeat(reverse: true);
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(opacity: Tween(begin: 0.35, end: 1.0).animate(_c), child: widget.child);
}

/// 按下时轻微缩小的点击区域
class Pressable extends StatefulWidget {
  const Pressable({super.key, required this.child, this.onTap, this.onLongPress, this.scale = 0.96, this.haptic = false});
  final Widget child;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final double scale;
  final bool haptic;
  @override
  State<Pressable> createState() => _PressableState();
}

class _PressableState extends State<Pressable> {
  bool _down = false;
  void _set(bool v) => setState(() => _down = v);

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onTap != null || widget.onLongPress != null;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapDown: enabled ? (_) => _set(true) : null,
      onTapUp: enabled ? (_) => _set(false) : null,
      onTapCancel: enabled ? () => _set(false) : null,
      onTap: widget.onTap == null
          ? null
          : () {
              if (widget.haptic) HapticFeedback.selectionClick();
              widget.onTap!();
            },
      onLongPress: widget.onLongPress,
      child: AnimatedScale(
        scale: _down ? widget.scale : 1,
        duration: const Duration(milliseconds: 120),
        curve: Curves.easeOut,
        child: widget.child,
      ),
    );
  }
}

/// 消息正文：支持 ```代码块``` 和 `行内代码`（与桌面端 format 一致）
class MessageText extends StatelessWidget {
  const MessageText(this.text, {super.key, required this.style});
  final String text;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final parts = text.split('```');
    final children = <Widget>[];
    for (var i = 0; i < parts.length; i++) {
      final part = parts[i];
      if (i.isOdd && i < parts.length - 1) {
        final code = part.replaceFirst(RegExp(r'^\w*\n'), '').replaceFirst(RegExp(r'\n$'), '');
        children.add(Container(
          width: double.infinity,
          margin: const EdgeInsets.symmetric(vertical: 6),
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          decoration: BoxDecoration(color: p.preBg, borderRadius: BorderRadius.circular(12)),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Text(code, style: TextStyle(fontFamily: monoFamily, fontSize: 13, height: 1.5, color: p.preText)),
          ),
        ));
      } else {
        final t = i.isOdd ? '```$part' : part;
        final trimmed = children.isEmpty ? t.replaceFirst(RegExp(r'\n+$'), '') : t.replaceAll(RegExp(r'^\n+|\n+$'), '');
        if (trimmed.isEmpty) continue;
        children.add(Text.rich(_inline(trimmed, p), style: style));
      }
    }
    if (children.length == 1) return children.first;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: children);
  }

  TextSpan _inline(String s, Palette p) {
    final spans = <InlineSpan>[];
    final re = RegExp(r'`([^`\n]+)`');
    var last = 0;
    for (final m in re.allMatches(s)) {
      if (m.start > last) spans.add(TextSpan(text: s.substring(last, m.start)));
      spans.add(TextSpan(
        text: ' ${m[1]} ',
        style: TextStyle(fontFamily: monoFamily, fontSize: (style.fontSize ?? 15) * 0.88, backgroundColor: p.codeBg, color: p.text),
      ));
      last = m.end;
    }
    if (last < s.length) spans.add(TextSpan(text: s.substring(last)));
    return TextSpan(children: spans);
  }
}

/// 进度从满到空的细线（倒计时焚毁）
class CountdownBar extends StatefulWidget {
  const CountdownBar({super.key, required this.start, required this.seconds, this.color, this.height = 2});
  final DateTime start;
  final int seconds;
  final Color? color;
  final double height;
  @override
  State<CountdownBar> createState() => _CountdownBarState();
}

class _CountdownBarState extends State<CountdownBar> with SingleTickerProviderStateMixin {
  late AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: Duration(seconds: widget.seconds));
    _sync();
  }

  void _sync() {
    final elapsed = DateTime.now().difference(widget.start).inMilliseconds / (widget.seconds * 1000);
    _c.value = elapsed.clamp(0, 1);
    _c.forward();
  }

  @override
  void didUpdateWidget(CountdownBar old) {
    super.didUpdateWidget(old);
    if (old.start != widget.start || old.seconds != widget.seconds) {
      _c.duration = Duration(seconds: widget.seconds);
      _sync();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.color ?? brand;
    return ClipRRect(
      borderRadius: BorderRadius.circular(widget.height),
      child: SizedBox(
        height: widget.height,
        child: AnimatedBuilder(
          animation: _c,
          builder: (_, _) => FractionallySizedBox(
            alignment: Alignment.centerLeft,
            widthFactor: 1 - _c.value,
            child: ColoredBox(color: color.withValues(alpha: 0.7)),
          ),
        ),
      ),
    );
  }
}
