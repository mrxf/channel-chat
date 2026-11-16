package com.agentworkspace.agent_mobile

import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "agent/window").setMethodCallHandler { call, result ->
            when (call.method) {
                // FLAG_SECURE：截屏、录屏、最近任务缩略图里都是空白
                "setSecure" -> {
                    if (call.arguments == true) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    result.success(null)
                }
                // 返回键：退到后台，连接保持
                "moveToBack" -> result.success(moveTaskToBack(true))
                else -> result.notImplemented()
            }
        }
    }
}
