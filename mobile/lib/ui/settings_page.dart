// 设置：会话设置（全房间同步）+ 本机偏好 + 安全信息
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../chat/chat_controller.dart';
import '../chat/models.dart';
import '../core/native.dart';
import '../core/net.dart';
import '../core/prefs.dart';
import '../core/version.dart';
import 'theme.dart';

class SettingsPage extends StatelessWidget {
  const SettingsPage({super.key, required this.chat, required this.prefs, required this.onLeave});
  final ChatController chat;
  final Prefs prefs;
  final VoidCallback onLeave;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Scaffold(
      appBar: AppBar(title: const Text('设置', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600))),
      body: ListenableBuilder(
        listenable: Listenable.merge([chat, prefs]),
        builder: (context, _) {
          final cfg = chat.cfg;
          final fp = chat.session?.fingerprint ?? '';
          return ListView(padding: const EdgeInsets.fromLTRB(16, 4, 16, 32), children: [
            const _Section('会话', note: '修改后同步给房间里的所有人'),
            _Card(children: [
              _Row(
                title: '保留轮数',
                subtitle: '同一个人连续发的算一轮，更早且已读的消息自动焚毁',
                trailing: _Stepper(value: cfg.keep, onChanged: (v) => chat.setCfg(keep: v)),
              ),
              _Row(
                title: '已读后焚毁',
                subtitle: '消息被读完后倒计时清除',
                below: _Segments<int>(values: ttlOptions, selected: cfg.ttl, label: ttlLabel, onChanged: (v) => chat.setCfg(ttl: v)),
              ),
              _Row(
                title: '图片 / 视频查看时长',
                subtitle: '图片打开后、视频播完后多少秒焚毁',
                below: _Segments<int>(values: mviewOptions, selected: cfg.mview, label: (v) => '${v}s', onChanged: (v) => chat.setCfg(mview: v)),
              ),
            ]),
            const _Section('后台'),
            _BackgroundCard(prefs: prefs),
            const _Section('本机'),
            _Card(children: [
              _Row(
                title: '外观',
                below: _Segments<ThemeMode>(
                  values: const [ThemeMode.system, ThemeMode.light, ThemeMode.dark],
                  selected: prefs.themeMode,
                  label: (m) => switch (m) { ThemeMode.light => '浅色', ThemeMode.dark => '深色', _ => '跟随系统' },
                  onChanged: prefs.setThemeMode,
                ),
              ),
              _Row(
                title: '新消息通知',
                subtitle: '后台时在锁屏、通知栏和桌面角标提示未读数，不显示内容和发送者',
                trailing: Switch(
                  value: prefs.notify,
                  onChanged: (v) {
                    prefs.setNotify(v);
                    if (v) {
                      Native.requestNotifyPermission();
                    } else {
                      Native.clearNotifications();
                    }
                  },
                ),
              ),
              if (prefs.notify && defaultTargetPlatform == TargetPlatform.android)
                _Row(
                  title: '锁屏与桌面角标',
                  subtitle: '可在系统通知管理中开启「锁屏通知」「横幅」及「桌面角标（数字）」',
                  trailing: TextButton(onPressed: Native.openNotificationSettings, child: const Text('打开')),
                ),
              _Row(
                title: '禁止截屏',
                subtitle: '截屏、录屏、最近任务缩略图里都是空白',
                trailing: Switch(
                  value: prefs.protect,
                  onChanged: (v) {
                    prefs.setProtect(v);
                    Native.setSecure(v);
                  },
                ),
              ),
              if (defaultTargetPlatform == TargetPlatform.android)
                _Row(
                  title: '语音默认听筒播放',
                  subtitle: '防外放泄密且阻止系统内录，贴近耳朵自动息屏；播放时也可随时切换外放',
                  trailing: Switch(
                    value: prefs.voiceEarpiece,
                    onChanged: (v) {
                      prefs.setVoiceEarpiece(v);
                      Native.setVoiceEarpiece(v);
                    },
                  ),
                ),
              _Row(
                title: '通话 STUN / TURN（可选）',
                subtitle: prefs.iceServers.isEmpty ? '留空 = 仅局域网直连（不泄露 IP）' : prefs.iceServers,
                trailing: TextButton(
                  onPressed: () => _editIceServers(context, prefs),
                  child: Text(prefs.iceServers.isEmpty ? '配置' : '修改'),
                ),
              ),
              _Row(title: '震动反馈', trailing: Switch(value: prefs.haptics, onChanged: prefs.setHaptics)),
            ]),
            const _Section('安全'),
            _Card(children: [
              _Row(
                title: '口令指纹',
                subtitle: '双方指纹一致，说明口令相同',
                trailing: InkWell(
                  borderRadius: BorderRadius.circular(8),
                  onTap: () {
                    Clipboard.setData(ClipboardData(text: fp));
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已复制指纹')));
                  },
                  child: Padding(
                    padding: const EdgeInsets.all(6),
                    child: Text(
                      RegExp('.{1,4}').allMatches(fp).map((m) => m[0]).join(' '),
                      style: TextStyle(fontFamily: monoFamily, fontSize: 15, fontWeight: FontWeight.w600, color: p.text, letterSpacing: 1),
                    ),
                  ),
                ),
              ),
              _Row(
                title: '服务器',
                subtitle: chat.serverName.isEmpty ? null : chat.serverName,
                trailing: Text(chat.wsUrl != null ? shortServer(chat.wsUrl!) : '', style: TextStyle(fontFamily: monoFamily, fontSize: 13, color: p.muted)),
              ),
              _Row(title: '版本', trailing: Text('v$appVersion', style: TextStyle(fontSize: 14, color: p.muted))),
            ]),
            const SizedBox(height: 24),
            OutlinedButton.icon(
              onPressed: onLeave,
              icon: const Icon(Icons.logout_rounded, size: 19),
              label: const Text('退出会话'),
              style: OutlinedButton.styleFrom(
                foregroundColor: p.bad,
                side: BorderSide(color: p.bad.withValues(alpha: 0.35)),
                minimumSize: const Size.fromHeight(50),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
              ),
            ),
            const SizedBox(height: 12),
            Text('退出后，内存里的所有消息立即清除。本机只保存名称、服务器地址和偏好设置。', textAlign: TextAlign.center, style: TextStyle(fontSize: 12, color: p.muted, height: 1.5)),
          ]);
        },
      ),
    );
  }
}

Future<void> _editIceServers(BuildContext context, Prefs prefs) async {
  final ctl = TextEditingController(text: prefs.iceServers);
  final saved = await showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('通话 STUN / TURN'),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('留空 = 仅局域网直连（不泄露 IP）。跨网可填写 stun:... 或 turn:host:port|user|pass（每行一条）。', style: TextStyle(fontSize: 12.5)),
        const SizedBox(height: 12),
        TextField(
          controller: ctl,
          maxLines: 3,
          decoration: const InputDecoration(
            hintText: 'turn:example.com:3478|user|pass',
            border: OutlineInputBorder(),
          ),
        ),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(ctx, ctl.text), child: const Text('保存')),
      ],
    ),
  );
  ctl.dispose();
  if (saved != null) await prefs.setIceServers(saved);
}

/// 后台保持在线开关 + 系统后台限制的状态（回到这个页面时重新检测，用户可能刚从系统设置回来）
class _BackgroundCard extends StatefulWidget {
  const _BackgroundCard({required this.prefs});
  final Prefs prefs;
  @override
  State<_BackgroundCard> createState() => _BackgroundCardState();
}

class _BackgroundCardState extends State<_BackgroundCard> with WidgetsBindingObserver {
  bool? _exempt;
  bool? _notifyAllowed;
  String _rom = 'other';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.prefs.addListener(_check);
    _check();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.prefs.removeListener(_check);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _check();
  }

  Future<void> _check() async {
    final results = await (
      Native.batteryExempt(),
      Native.notificationsEnabled(checkKeepAlive: widget.prefs.keepAlive),
      Native.romFamily(),
    ).wait;
    if (!mounted) return;
    setState(() {
      _exempt = results.$1;
      _notifyAllowed = results.$2;
      _rom = results.$3;
    });
  }

  String _romGuide() => switch (_rom) {
        'xiaomi' => '澎湃 / MIUI：请将省电策略设为「无限制」，并在最近任务里下拉锁定 ChatBuddy',
        'huawei' => '鸿蒙 / EMUI：请关闭「自动管理」并开启「允许后台活动」，并在最近任务里锁定 ChatBuddy',
        'honor' => 'MagicOS：请关闭「自动管理」并开启「允许后台活动」，并在最近任务里锁定 ChatBuddy',
        'oppo' => 'ColorOS：请在耗电管理中开启「完全允许后台行为」与「自启动」，并在最近任务下拉锁定 ChatBuddy',
        'vivo' => 'OriginOS：请开启「允许后台高耗电」，并在最近任务里锁定 ChatBuddy',
        'meizu' => 'Flyme：请开启「允许后台运行」，并在最近任务里锁定 ChatBuddy',
        _ => '部分系统还要在应用设置里允许「后台活动」，并在最近任务里锁定 ChatBuddy',
      };

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final prefs = widget.prefs;
    return _Card(children: [
      _Row(
        title: '后台保持在线',
        subtitle: '切到后台、锁屏后连接不断，照常收消息和通知。通知栏会常驻一条提示，耗电会多一些',
        trailing: Switch(
          value: prefs.keepAlive,
          onChanged: (v) {
            prefs.setKeepAlive(v);
            if (v) Native.requestNotifyPermission();
          },
        ),
      ),
      if (prefs.keepAlive && defaultTargetPlatform == TargetPlatform.android) ...[
        if (_notifyAllowed == false)
          _Row(
            title: '系统通知权限',
            subtitle: '未开启：常驻通知被拦截会导致后台保活失效，锁屏与角标也无法提醒',
            trailing: FilledButton.tonal(
              onPressed: Native.openNotificationSettings,
              style: FilledButton.styleFrom(visualDensity: VisualDensity.compact),
              child: const Text('去开启'),
            ),
          ),
        _Row(
          title: '不受电池优化限制',
          subtitle: _exempt == false
              ? '未允许：长时间锁屏后，系统仍可能断开连接'
              : (_rom == 'oppo' ? '已允许原生白名单（ColorOS 还需在下方开启完全允许后台行为）' : '已允许'),
          trailing: _exempt == false
              ? FilledButton.tonal(
                  onPressed: Native.requestBatteryExempt,
                  style: FilledButton.styleFrom(visualDensity: VisualDensity.compact),
                  child: const Text('去允许'),
                )
              : Icon(Icons.check_circle_rounded, color: _exempt == true ? p.good : p.muted, size: 22),
        ),
        _Row(
          title: '系统后台管理',
          subtitle: _romGuide(),
          trailing: TextButton(onPressed: Native.openBackgroundSettings, child: const Text('打开')),
        ),
      ],
    ]);
  }
}

class _Section extends StatelessWidget {
  const _Section(this.title, {this.note});
  final String title;
  final String? note;
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Padding(
      padding: const EdgeInsets.fromLTRB(6, 22, 6, 10),
      child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        Text(title, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: p.muted, letterSpacing: 0.3)),
        if (note != null) ...[const SizedBox(width: 8), Expanded(child: Text(note!, style: TextStyle(fontSize: 11.5, color: p.muted.withValues(alpha: 0.8))))],
      ]),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Container(
      decoration: BoxDecoration(color: p.panel, borderRadius: BorderRadius.circular(18), border: Border.all(color: p.line.withValues(alpha: 0.7))),
      child: Column(children: [
        for (var i = 0; i < children.length; i++) ...[
          if (i > 0) Divider(indent: 16, endIndent: 16, color: p.line.withValues(alpha: 0.7)),
          children[i],
        ],
      ]),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.title, this.subtitle, this.trailing, this.below});
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final Widget? below;
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: TextStyle(fontSize: 15, color: p.text, fontWeight: FontWeight.w500)),
              if (subtitle != null) ...[const SizedBox(height: 3), Text(subtitle!, style: TextStyle(fontSize: 12.5, color: p.muted, height: 1.4))],
            ]),
          ),
          if (trailing != null) ...[const SizedBox(width: 12), trailing!],
        ]),
        if (below != null) ...[const SizedBox(height: 12), below!],
      ]),
    );
  }
}

class _Stepper extends StatelessWidget {
  const _Stepper({required this.value, required this.onChanged});
  final int value;
  final ValueChanged<int> onChanged;
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    Widget btn(IconData icon, int delta) => IconButton(
          visualDensity: VisualDensity.compact,
          onPressed: (value + delta).clamp(1, 50) == value
              ? null
              : () {
                  HapticFeedback.selectionClick();
                  onChanged(value + delta);
                },
          icon: Icon(icon, size: 18),
        );
    return Container(
      decoration: BoxDecoration(color: p.bubble, borderRadius: BorderRadius.circular(12)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        btn(Icons.remove_rounded, -1),
        SizedBox(width: 28, child: Text('$value', textAlign: TextAlign.center, style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: p.text))),
        btn(Icons.add_rounded, 1),
      ]),
    );
  }
}

class _Segments<T> extends StatelessWidget {
  const _Segments({required this.values, required this.selected, required this.label, required this.onChanged});
  final List<T> values;
  final T selected;
  final String Function(T) label;
  final ValueChanged<T> onChanged;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(color: p.bubble, borderRadius: BorderRadius.circular(12)),
      child: Row(children: [
        for (final v in values)
          Expanded(
            child: GestureDetector(
              onTap: () {
                if (v == selected) return;
                HapticFeedback.selectionClick();
                onChanged(v);
              },
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                curve: Curves.easeOut,
                padding: const EdgeInsets.symmetric(vertical: 8),
                decoration: BoxDecoration(
                  color: v == selected ? p.panel : Colors.transparent,
                  borderRadius: BorderRadius.circular(9),
                  boxShadow: v == selected ? const [BoxShadow(color: Color(0x14000000), blurRadius: 6, offset: Offset(0, 1))] : null,
                ),
                alignment: Alignment.center,
                child: Text(label(v), style: TextStyle(fontSize: 13, fontWeight: v == selected ? FontWeight.w600 : FontWeight.w500, color: v == selected ? p.text : p.muted)),
              ),
            ),
          ),
      ]),
    );
  }
}
