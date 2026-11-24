package com.agentworkspace.agent_mobile

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.WindowManager
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    companion object {
        private const val MSG_CHANNEL = "messages_v2"
        private const val LEGACY_MSG_CHANNEL = "messages"
        private const val REQ_RECORD_AUDIO = 4091
    }

    private var channel: MethodChannel? = null
    private var voiceChannel: MethodChannel? = null
    private var voiceEngine: VoiceEngine? = null
    private var pendingMicResult: MethodChannel.Result? = null
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        ensureNotificationChannels()
        val ch = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "agent/window")
        channel = ch
        ch.setMethodCallHandler { call, result ->
            when (call.method) {
                // FLAG_SECURE：截屏、录屏、最近任务缩略图里都是空白
                "setSecure" -> {
                    if (call.arguments == true) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    result.success(null)
                }
                // 返回键：退到后台，连接保持
                "moveToBack" -> result.success(moveTaskToBack(true))
                // 后台保持在线：参数是常驻通知的文字，null 表示停止
                "keepAlive" -> {
                    val text = call.arguments as? String
                    try {
                        if (text != null) KeepAliveService.start(applicationContext, text) else KeepAliveService.stop(applicationContext)
                        result.success(true)
                    } catch (_: Exception) {
                        // Android 12+ 不允许从后台启动前台服务；回到前台时会再同步一次
                        result.success(false)
                    }
                }
                "batteryExempt" -> result.success(batteryExempt())
                "requestBatteryExempt" -> result.success(requestBatteryExempt())
                "notificationsEnabled" -> result.success(notificationsEnabled(call.arguments == true))
                "openNotificationSettings" -> {
                    openNotificationSettings()
                    result.success(true)
                }
                "setBadge" -> {
                    val count = (call.arguments as? Number)?.toInt() ?: 0
                    setBadge(count)
                    result.success(null)
                }
                "romFamily" -> result.success(romFamily())
                "openBackgroundSettings" -> {
                    openBackgroundSettings()
                    result.success(true)
                }
                "openAppSettings" -> {
                    openAppDetails()
                    result.success(true)
                }
                else -> result.notImplemented()
            }
        }
        watchNetwork()

        val vch = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "agent/voice")
        voiceChannel = vch
        val engine = VoiceEngine(applicationContext) { voiceChannel }
        voiceEngine = engine
        vch.setMethodCallHandler { call, result ->
            when (call.method) {
                "requestMicPermission" -> requestMicPermission(result)
                "startRecord" -> result.success(engine.startRecord())
                "stopRecord" -> result.success(engine.stopRecord())
                "cancelRecord" -> {
                    engine.cancelRecord()
                    result.success(null)
                }
                "playVoice" -> {
                    val id = call.argument<String>("id") ?: ""
                    val bytes = call.argument<ByteArray>("bytes") ?: ByteArray(0)
                    val earpiece = call.argument<Boolean>("earpiece") ?: true
                    result.success(engine.playVoice(id, bytes, earpiece))
                }
                "setEarpiece" -> {
                    engine.setEarpiece(call.arguments == true)
                    result.success(null)
                }
                "stopPlay" -> {
                    engine.stopPlay(call.arguments as? String)
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun requestMicPermission(result: MethodChannel.Result) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            result.success(true)
            return
        }
        pendingMicResult?.success(false)
        pendingMicResult = result
        ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), REQ_RECORD_AUDIO)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (requestCode == REQ_RECORD_AUDIO) {
            val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            pendingMicResult?.success(granted)
            pendingMicResult = null
            return
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        unwatchNetwork()
        voiceEngine?.release()
        voiceEngine = null
        voiceChannel?.setMethodCallHandler(null)
        voiceChannel = null
        channel?.setMethodCallHandler(null)
        channel = null
        super.cleanUpFlutterEngine(flutterEngine)
    }

    /** 监听默认网络切换（锁屏走出门 Wi-Fi 切 5G、恢复信号等），通知 Dart 层立即探活或重连 */
    private fun watchNetwork() {
        unwatchNetwork()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        var last: Network? = cm.activeNetwork
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (network == last) return
                last = network
                runOnUiThread { channel?.invokeMethod("networkChanged", null) }
            }

            override fun onLost(network: Network) {
                if (network == last) last = null
            }
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            netCallback = cb
        } catch (_: Exception) {
        }
    }

    private fun unwatchNetwork() {
        val cb = netCallback ?: return
        netCallback = null
        try {
            getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb)
        } catch (_: Exception) {
        }
    }

    private fun batteryExempt(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)

    /** 系统弹窗「允许应用始终在后台运行？」；个别 ROM 没有这个弹窗，退回到电池优化列表 */
    @SuppressLint("BatteryLife")
    private fun requestBatteryExempt(): Boolean {
        if (batteryExempt()) return true
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
        val list = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        for (intent in listOf(direct, list)) {
            try {
                startActivity(intent)
                return false
            } catch (_: Exception) {
            }
        }
        openAppDetails()
        return false
    }

    private fun romFamily(): String {
        val m = "${Build.MANUFACTURER} ${Build.BRAND}".lowercase()
        return when {
            "xiaomi" in m || "redmi" in m || "poco" in m -> "xiaomi"
            "huawei" in m -> "huawei"
            "honor" in m || "hihonor" in m -> "honor"
            "oppo" in m || "realme" in m || "oneplus" in m -> "oppo"
            "vivo" in m || "iqoo" in m -> "vivo"
            "meizu" in m -> "meizu"
            "samsung" in m -> "samsung"
            else -> "other"
        }
    }

    /**
     * 启动时即注册通知渠道并清理旧渠道：
     *   1. 删除旧版固化了 VISIBILITY_SECRET 的 messages 渠道，确保覆盖安装后锁屏通知与桌面角标立即生效；
     *   2. 预建新渠道，用户还未收到第一条后台消息前也能在系统「通知管理」里直接看到并配置它。
     */
    private fun ensureNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        nm.deleteNotificationChannel(LEGACY_MSG_CHANNEL)
        if (nm.getNotificationChannel(MSG_CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(MSG_CHANNEL, "新消息", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "后台收到新消息时在锁屏、横幅和桌面角标提醒（不显示内容和发送者）"
                    setShowBadge(true)
                    enableVibration(true)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                }
            )
        }
        KeepAliveService.ensureChannel(nm)
    }

    private fun notificationsEnabled(checkKeepAlive: Boolean): Boolean {
        val nm = getSystemService(NotificationManager::class.java) ?: return true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && !nm.areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val msgCh = nm.getNotificationChannel(MSG_CHANNEL)
            if (msgCh != null && msgCh.importance == NotificationManager.IMPORTANCE_NONE) return false
            if (checkKeepAlive) {
                val connCh = nm.getNotificationChannel(KeepAliveService.CHANNEL)
                if (connCh != null && connCh.importance == NotificationManager.IMPORTANCE_NONE) return false
            }
        }
        return true
    }

    private fun openNotificationSettings() {
        val candidates = buildList {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                add(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
            }
            add(
                Intent("android.settings.APP_NOTIFICATION_SETTINGS")
                    .putExtra("app_package", packageName)
                    .putExtra("app_uid", applicationInfo.uid)
            )
        }
        for (intent in candidates) {
            try {
                startActivity(intent)
                return
            } catch (_: Exception) {
            }
        }
        openAppDetails()
    }

    /**
     * 同步桌面图标未读数字角标：
     *   - 原生 Android 8+ / 三星 OneUI / 小米澎湃等直接读取 Notification.number（由通知渠道驱动）
     *   - OPPO ColorOS / 华为 / 荣耀等额外尝试其桌面 Provider 接口（系统限制或未开放时静默忽略）
     */
    private fun setBadge(count: Int) {
        val n = count.coerceAtLeast(0)
        when (romFamily()) {
            "oppo" -> {
                try {
                    val extras = Bundle().apply { putInt("app_badge_count", n) }
                    contentResolver.call(Uri.parse("content://com.android.badge/badge"), "setAppBadgeCount", null, extras)
                } catch (_: Throwable) {
                }
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                    try {
                        val intent = Intent("com.oppo.unsettledevent")
                            .putExtra("pakeageName", packageName)
                            .putExtra("number", n)
                            .putExtra("upgradeNumber", n)
                        sendBroadcast(intent)
                    } catch (_: Throwable) {
                    }
                }
            }
            "huawei", "honor" -> {
                try {
                    val extras = Bundle().apply {
                        putString("package", packageName)
                        putString("class", MainActivity::class.java.name)
                        putInt("badgenumber", n)
                    }
                    contentResolver.call(Uri.parse("content://com.huawei.android.launcher.settings/badge/"), "change_badge", null, extras)
                } catch (_: Throwable) {
                }
            }
        }
    }

    /**
     * 国产系统除了原生 Doze 白名单外，还有各自的省电 / 后台冻结管理：
     * 优先直达对应厂商的后台配置页（小米「省电策略」、华为/荣耀「应用启动管理」、OPPO「耗电管理/自启动」、vivo「后台高耗电」、魅族权限页），
     * 目标页面不存在或未导出时回退到应用详情页（ColorOS 等系统的「耗电管理」就在应用详情页内）。
     */
    private fun openBackgroundSettings() {
        val label = applicationInfo.loadLabel(packageManager).toString()
        val candidates = when (romFamily()) {
            "xiaomi" -> listOf(
                Intent().apply {
                    component = ComponentName("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity")
                    putExtra("package_name", packageName)
                    putExtra("package_label", label)
                },
            )
            "huawei" -> listOf(
                Intent().setComponent(ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity")),
                Intent().setComponent(ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity")),
            )
            "honor" -> listOf(
                Intent().setComponent(ComponentName("com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity")),
                Intent().setComponent(ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity")),
            )
            "oppo" -> listOf(
                Intent().setComponent(ComponentName("com.oplus.battery", "com.oplus.powermanager.fuelgaue.PowerConsumptionActivity")),
                Intent().setComponent(ComponentName("com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerConsumptionActivity")),
                Intent().setComponent(ComponentName("com.oplus.safecenter", "com.oplus.safecenter.permission.startup.StartupAppListActivity")),
                Intent().setComponent(ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity")),
            )
            "vivo" -> listOf(
                Intent().setComponent(ComponentName("com.vivo.abe", "com.vivo.applicationbehaviorengine.ui.ExcessivePowerManagerActivity")),
                Intent().setComponent(ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity")),
            )
            "meizu" -> listOf(
                Intent("com.meizu.safe.security.SHOW_APPSEC").addCategory(Intent.CATEGORY_DEFAULT).putExtra("packageName", packageName),
            )
            else -> emptyList()
        }
        for (intent in candidates) {
            try {
                startActivity(intent)
                return
            } catch (_: Exception) {
            }
        }
        openAppDetails()
    }

    private fun openAppDetails() {
        try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        } catch (_: Exception) {
            startActivity(Intent(Settings.ACTION_SETTINGS))
        }
    }

    // Activity 销毁意味着它持有的 FlutterEngine 和内存会话都会一起销毁，常驻通知必须同步撤掉，避免出现“假在线”僵尸通知
    override fun onDestroy() {
        unwatchNetwork()
        voiceEngine?.release()
        voiceEngine = null
        KeepAliveService.stop(applicationContext)
        super.onDestroy()
    }
}
