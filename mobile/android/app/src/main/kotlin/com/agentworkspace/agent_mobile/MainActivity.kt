package com.agentworkspace.agent_mobile

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private var channel: MethodChannel? = null
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
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
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        unwatchNetwork()
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
     * 国产系统除了原生 Doze 白名单外，还有各自的省电 / 后台冻结管理：
     * 优先直达对应厂商的后台配置页（小米「省电策略」、华为/荣耀「应用启动管理」、vivo「后台高耗电」、魅族权限页），
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
        KeepAliveService.stop(applicationContext)
        super.onDestroy()
    }
}
