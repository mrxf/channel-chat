// 系统能力：防截屏（FLAG_SECURE）、退到后台、后台保持在线、网络切换监听、本地通知、震动
import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

class Native {
  static const _ch = MethodChannel('agent/window');
  static const _msgNotifyId = 1;
  static final _notifier = FlutterLocalNotificationsPlugin();
  static final _netChanges = StreamController<void>.broadcast();
  static bool _notifyReady = false;
  static bool _channelBound = false;

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

  static Future<void> initNotifications() async {
    if (_notifyReady) return;
    try {
      await _notifier.initialize(
        settings: const InitializationSettings(
          android: AndroidInitializationSettings('@drawable/ic_stat_agent'),
          iOS: DarwinInitializationSettings(requestAlertPermission: false, requestBadgePermission: false, requestSoundPermission: false),
        ),
      );
      _notifyReady = true;
    } catch (_) {}
  }

  static Future<void> requestNotifyPermission() async {
    await initNotifications();
    try {
      await _notifier.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()?.requestNotificationsPermission();
      await _notifier.resolvePlatformSpecificImplementation<IOSFlutterLocalNotificationsPlugin>()?.requestPermissions(alert: true, sound: true);
    } catch (_) {}
  }

  /// 只给通用提示，不含内容和发送者
  static Future<void> notify(String body) async {
    await initNotifications();
    if (!_notifyReady) return;
    try {
      await _notifier.show(
        id: _msgNotifyId,
        title: 'Agent',
        body: body,
        notificationDetails: const NotificationDetails(
          android: AndroidNotificationDetails(
            'messages',
            '新消息',
            channelDescription: '只提示有新消息，不显示内容',
            importance: Importance.high,
            priority: Priority.high,
            visibility: NotificationVisibility.secret,
            color: Color(0xFFD97757),
          ),
          iOS: DarwinNotificationDetails(),
        ),
      );
    } catch (_) {}
  }

  /// 只清除新消息通知，不能用 cancelAll()（否则会把 KeepAliveService 的前台常驻通知一并清掉）
  static Future<void> clearNotifications() async {
    if (!_notifyReady) return;
    try {
      await _notifier.cancel(id: _msgNotifyId);
    } catch (_) {}
  }
}
