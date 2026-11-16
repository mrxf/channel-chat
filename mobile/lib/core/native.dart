// 系统能力：防截屏（FLAG_SECURE）、退到后台、本地通知、震动
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

class Native {
  static const _ch = MethodChannel('agent/window');
  static final _notifier = FlutterLocalNotificationsPlugin();
  static bool _notifyReady = false;

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
        id: 1,
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

  static Future<void> clearNotifications() async {
    if (!_notifyReady) return;
    try {
      await _notifier.cancelAll();
    } catch (_) {}
  }
}
