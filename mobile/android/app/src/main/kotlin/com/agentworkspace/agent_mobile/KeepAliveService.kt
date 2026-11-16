package com.agentworkspace.agent_mobile

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * 后台保持在线。
 *
 * 没有前台服务时，App 退到后台或锁屏后几秒到十几秒，系统就会冻结进程（Android 11+ 的 cached app freezer，
 * 国产 ROM 更激进），锁屏久了 Doze 还会断网。进程冻住就回不了服务器的心跳，服务器 20~40 秒后断开连接，
 * 别人那边看到你离线，消息也发不过来。
 *
 * 前台服务让进程保持「前台服务」优先级：不被冻结、Doze 下也能联网；
 * 再持有 CPU 唤醒锁和 Wi-Fi 锁，保证锁屏后心跳、重连定时器照常运行，Wi-Fi 不进省电模式。
 * 只在进入会话后运行，退出会话或从最近任务划掉 App 时停止。
 */
class KeepAliveService : Service() {
    companion object {
        private const val CHANNEL = "connection"
        private const val NOTIFICATION_ID = 0x4147
        private const val EXTRA_TEXT = "text"
        @Volatile private var running: KeepAliveService? = null
        @Volatile private var pendingStart = false
        @Volatile private var wantStop = false
        @Volatile private var latestText = "后台保持在线"

        /** 启动或更新常驻通知的文字 */
        fun start(ctx: Context, text: String) {
            wantStop = false
            latestText = text
            running?.let { it.show(text); return }
            if (pendingStart) return
            pendingStart = true
            val intent = Intent(ctx, KeepAliveService::class.java).putExtra(EXTRA_TEXT, text)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent) else ctx.startService(intent)
            } catch (e: Throwable) {
                pendingStart = false
                throw e
            }
        }

        fun stop(ctx: Context) {
            wantStop = true
            if (running != null) {
                running = null
                ctx.stopService(Intent(ctx, KeepAliveService::class.java))
            } else if (!pendingStart) {
                ctx.stopService(Intent(ctx, KeepAliveService::class.java))
            }
            // pendingStart == true 且 running == null 时：startForegroundService 已发出但 onStartCommand 尚未执行，
            // 不能提前 stopService（否则 Android 8+ 会抛 ForegroundServiceDidNotStartInTimeException），交由 onStartCommand 立即收尾
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        pendingStart = false
        intent?.getStringExtra(EXTRA_TEXT)?.let { if (!wantStop) latestText = it }
        val notification = build(latestText)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        if (wantStop) {
            running = null
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
            else @Suppress("DEPRECATION") stopForeground(true)
            stopSelf()
            return START_NOT_STICKY
        }
        running = this
        acquireLocks()
        // 进程被杀后不自动重启：会话密钥只在内存里，单独重启服务没有意义
        return START_NOT_STICKY
    }

    // 从最近任务里划掉 App = 用户想退出，界面和连接都已经没了，服务跟着停
    override fun onTaskRemoved(rootIntent: Intent?) {
        stopSelf()
    }

    override fun onDestroy() {
        running = null
        wakeLock?.takeIf { it.isHeld }?.release()
        wifiLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
        wifiLock = null
        super.onDestroy()
    }

    fun show(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, build(text))
    }

    @SuppressLint("WakelockTimeout")
    private fun acquireLocks() {
        if (wakeLock == null) {
            wakeLock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "agent:keepalive")
                .apply { setReferenceCounted(false); acquire() }
        }
        if (wifiLock == null) {
            @Suppress("DEPRECATION")
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
            wifiLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
                .createWifiLock(mode, "agent:keepalive")
                .apply { setReferenceCounted(false); acquire() }
        }
    }

    private fun build(text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "后台保持在线", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "会话进行中常驻，保证切到后台、锁屏后也能收到消息"
                    setShowBadge(false)
                    lockscreenVisibility = Notification.VISIBILITY_SECRET
                }
            )
        }
        val open = packageManager.getLaunchIntentForPackage(packageName)!!
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        val pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL) else {
            @Suppress("DEPRECATION")
            Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
        }
        b.setSmallIcon(R.drawable.ic_stat_agent)
            .setContentTitle("Agent")
            .setContentText(text)
            .setColor(0xFFD97757.toInt())
            .setOngoing(true)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setContentIntent(pi)
            .setVisibility(Notification.VISIBILITY_SECRET)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        return b.build()
    }
}
