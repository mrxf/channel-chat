// 系统能力：防截屏（FLAG_SECURE）、退到后台、后台保持在线、网络切换监听、本地通知、震动
import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

class Native {
  static const _ch = MethodChannel('agent/window');
  static const _msgNotifyId = 1;
  static const msgChannelId = 'messages_v2';
  static const _legacyMsgChannelId = 'messages';
  static final _notifier = FlutterLocalNotificationsPlugin();
  static final _netChanges = StreamController<void>.broadcast();
  static bool _notifyReady = false;
  static bool _channelBound = false;
  @visibleForTesting
  static void Function(String body, int count, bool silent)? debugOnNotify;
  @visibleForTesting
  static VoidCallback? debugOnClear;

  /// Android 默认网络发生切换或断网恢复时触发
  static Stream<void> get networkChanges {
    _bindChannel();
    return _netChanges.stream;
  }

  static void _bindChannel() {
    if (_channelBound || !Platform.isAndroid) return;
    _channelBound = true;
    _ch.setMethodCallHandler((call) async {
      if (call.method == 'networkChanged') _netChanges.add(null);
    });
  }

  static Future<void> setSecure(bool on) async {
    if (!Platform.isAndroid) return;
    try {
      await _ch.invokeMethod('setSecure', on);
    } catch (_) {}
  }

  /// Android 返回键：退到后台而不是退出会话（连接保持）
  static Future<bool> moveToBack() async {
    if (!Platform.isAndroid) return false;
    try {
      return await _ch.invokeMethod<bool>('moveToBack') ?? false;
    } catch (_) {
      return false;
    }
  }

  /// 后台保持在线（Android 前台服务）：text 是常驻通知的文字，null 停止。返回 false 表示系统没允许启动
  static Future<bool> keepAlive(String? text) async {
    if (!Platform.isAndroid) return true;
    try {
      return await _ch.invokeMethod<bool>('keepAlive', text) ?? false;
    } catch (_) {
      return false;
    }
  }

  /// 是否已经允许「不受电池优化限制」（iOS 和旧版 Android 视为已允许）
  static Future<bool> batteryExempt() async {
    if (!Platform.isAndroid) return true;
    try {
      return await _ch.invokeMethod<bool>('batteryExempt') ?? true;
    } catch (_) {
      return true;
    }
  }

  /// 弹出系统的「允许在后台运行」确认框
  static Future<void> requestBatteryExempt() async {
    if (!Platform.isAndroid) return;
    try {
      await _ch.invokeMethod('requestBatteryExempt');
    } catch (_) {}
  }

  /// 手机厂商分类（xiaomi / huawei / honor / oppo / vivo / meizu / samsung / other）
  static Future<String> romFamily() async {
    if (!Platform.isAndroid) return 'other';
    try {
      return await _ch.invokeMethod<String>('romFamily') ?? 'other';
    } catch (_) {
      return 'other';
    }
  }

  /// 优先直达厂商专属后台省电 / 启动管理页，失败则回退到系统应用详情页
  static Future<void> openBackgroundSettings() async {
    if (!Platform.isAndroid) return;
    try {
      await _ch.invokeMethod('openBackgroundSettings');
    } catch (_) {
      await openAppSettings();
    }
  }

  /// 应用详情页
  static Future<void> openAppSettings() async {
    if (!Platform.isAndroid) return;
    try {
      await _ch.invokeMethod('openAppSettings');
    } catch (_) {}
  }

  /// 系统通知总开关及对应渠道是否处于开启状态
  static Future<bool> notificationsEnabled({bool checkKeepAlive = false}) async {
    if (!Platform.isAndroid) return true;
    try {
      return await _ch.invokeMethod<bool>('notificationsEnabled', checkKeepAlive) ?? true;
    } catch (_) {
      return true;
    }
  }

  /// 打开系统「应用通知管理」页（可配置锁屏通知、横幅、桌面数字角标）
  static Future<void> openNotificationSettings() async {
    if (!Platform.isAndroid) return;
    try {
      await _ch.invokeMethod('openNotificationSettings');
    } catch (_) {
      await openAppSettings();
    }
  }

  /// 同步桌面图标未读角标数（0 表示清除）
  static Future<void> setBadge(int count) async {
    if (!Platform.isAndroid) return;
    try {
      await _ch.invokeMethod('setBadge', count);
    } catch (_) {}
  }

  static Future<void> initNotifications() async {
    if (_notifyReady || (!Platform.isAndroid && !Platform.isIOS)) return;
    try {
      await _notifier.initialize(
        settings: const InitializationSettings(
          android: AndroidInitializationSettings('@drawable/ic_stat_agent'),
          iOS: DarwinInitializationSettings(requestAlertPermission: false, requestBadgePermission: false, requestSoundPermission: false),
        ),
      );
      await _notifier.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()?.deleteNotificationChannel(channelId: _legacyMsgChannelId);
      _notifyReady = true;
    } catch (_) {}
  }

  static Future<void> requestNotifyPermission() async {
    await initNotifications();
    try {
      await _notifier.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()?.requestNotificationsPermission();
      await _notifier.resolvePlatformSpecificImplementation<IOSFlutterLocalNotificationsPlugin>()?.requestPermissions(alert: true, badge: true, sound: true);
    } catch (_) {}
  }

  /// 只给通用提示与未读条数，不含聊天内容和发送者；允许在锁屏展示并同步应用图标数字角标
  static Future<void> notify(String body, {required int count, bool silent = false}) async {
    final n = count < 1 ? 1 : count;
    debugOnNotify?.call(body, n, silent);
    await initNotifications();
    if (!_notifyReady) return;
    try {
      await _notifier.show(
        id: _msgNotifyId,
        title: 'ChatBuddy',
        body: body,
        notificationDetails: NotificationDetails(
          android: AndroidNotificationDetails(
            msgChannelId,
            '新消息',
            channelDescription: '后台收到新消息时在锁屏、横幅和桌面角标提醒（不显示内容和发送者）',
            importance: Importance.high,
            priority: Priority.high,
            category: AndroidNotificationCategory.message,
            visibility: NotificationVisibility.public,
            channelShowBadge: true,
            number: n,
            onlyAlertOnce: silent,
            color: const Color(0xFFD97757),
          ),
          iOS: DarwinNotificationDetails(
            badgeNumber: n,
            presentSound: !silent,
          ),
        ),
      );
      await setBadge(n);
    } catch (_) {}
  }

  /// 只清除新消息通知并归零角标，不能用 cancelAll()（否则会把 KeepAliveService 的前台常驻通知一并清掉）
  static Future<void> clearNotifications() async {
    debugOnClear?.call();
    await setBadge(0);
    if (!_notifyReady) return;
    try {
      await _notifier.cancel(id: _msgNotifyId);
    } catch (_) {}
  }

  /* ---------------- 纯内存语音录音 / 防内录听筒播放（Android 原生） ---------------- */

  static const _voiceCh = MethodChannel('agent/voice');
  static bool _voiceBound = false;
  static final _recTicks = StreamController<({double sec, double level})>.broadcast();
  static final _recAutoStops = StreamController<void>.broadcast();
  static final _playProgress = StreamController<({String id, double frac, int remain})>.broadcast();
  static final _playEnded = StreamController<String>.broadcast();

  static void _bindVoice() {
    if (_voiceBound || !Platform.isAndroid) return;
    _voiceBound = true;
    _voiceCh.setMethodCallHandler((call) async {
      switch (call.method) {
        case 'recordTick':
          final m = call.arguments as Map?;
          if (m != null) {
            _recTicks.add((sec: (m['sec'] as num?)?.toDouble() ?? 0, level: (m['level'] as num?)?.toDouble() ?? 0));
          }
        case 'recordAutoStop':
          _recAutoStops.add(null);
        case 'playProgress':
          final m = call.arguments as Map?;
          if (m != null && m['id'] is String) {
            _playProgress.add((
              id: m['id'] as String,
              frac: (m['frac'] as num?)?.toDouble() ?? 0,
              remain: (m['remain'] as num?)?.toInt() ?? 0,
            ));
          }
        case 'playEnded':
          final m = call.arguments as Map?;
          if (m != null && m['id'] is String) _playEnded.add(m['id'] as String);
      }
    });
  }

  static Stream<({double sec, double level})> get voiceRecordTicks {
    _bindVoice();
    return _recTicks.stream;
  }

  static Stream<void> get voiceRecordAutoStops {
    _bindVoice();
    return _recAutoStops.stream;
  }

  static Stream<({String id, double frac, int remain})> get voicePlayProgress {
    _bindVoice();
    return _playProgress.stream;
  }

  static Stream<String> get voicePlayEnded {
    _bindVoice();
    return _playEnded.stream;
  }

  static Future<bool> requestMicPermission() async {
    if (!Platform.isAndroid) return false;
    _bindVoice();
    try {
      return await _voiceCh.invokeMethod<bool>('requestMicPermission') ?? false;
    } catch (_) {
      return false;
    }
  }

  static Future<bool> startVoiceRecord() async {
    if (!Platform.isAndroid) return false;
    _bindVoice();
    try {
      return await _voiceCh.invokeMethod<bool>('startRecord') ?? false;
    } catch (_) {
      return false;
    }
  }

  static Future<({bool tooShort, Uint8List? wav, int dur, List<int> peaks})> stopVoiceRecord() async {
    if (!Platform.isAndroid) return (tooShort: true, wav: null, dur: 0, peaks: const <int>[]);
    try {
      final res = await _voiceCh.invokeMapMethod<String, dynamic>('stopRecord');
      if (res == null || res['tooShort'] == true || res['wav'] is! Uint8List) {
        return (tooShort: true, wav: null, dur: 0, peaks: const <int>[]);
      }
      final peaks = (res['peaks'] as List?)?.map((e) => (e as num).toInt()).toList() ?? const <int>[];
      return (tooShort: false, wav: res['wav'] as Uint8List, dur: (res['dur'] as num?)?.toInt() ?? 1, peaks: peaks);
    } catch (_) {
      return (tooShort: true, wav: null, dur: 0, peaks: const <int>[]);
    }
  }

  static Future<void> cancelVoiceRecord() async {
    if (!Platform.isAndroid) return;
    try {
      await _voiceCh.invokeMethod('cancelRecord');
    } catch (_) {}
  }

  static Future<bool> playVoice(String id, Uint8List bytes, {required bool earpiece}) async {
    if (!Platform.isAndroid) return false;
    _bindVoice();
    try {
      return await _voiceCh.invokeMethod<bool>('playVoice', {'id': id, 'bytes': bytes, 'earpiece': earpiece}) ?? false;
    } catch (_) {
      return false;
    }
  }

  static Future<void> setVoiceEarpiece(bool earpiece) async {
    if (!Platform.isAndroid) return;
    try {
      await _voiceCh.invokeMethod('setEarpiece', earpiece);
    } catch (_) {}
  }

  static Future<void> stopVoicePlay([String? id]) async {
    if (!Platform.isAndroid) return;
    try {
      await _voiceCh.invokeMethod('stopPlay', id);
    } catch (_) {}
  }
}
