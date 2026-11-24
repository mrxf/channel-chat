package com.agentworkspace.agent_mobile

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Arrays
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * 纯内存语音引擎（零磁盘 I/O）：
 *   1. 录音：AudioRecord 采集 16kHz 16-bit mono PCM 到内存缓冲，停止时封装 WAV 头并计算波形 peaks，随后清零中间缓冲；
 *   2. 播放：AudioTrack 直接播内存 PCM，强制设置 ALLOW_CAPTURE_BY_NONE（Android 10+ 防内录）；
 *   3. 听筒模式 + 距离传感器贴耳息屏（PROXIMITY_SCREEN_OFF_WAKE_LOCK），支持听筒/扬声器即时切换；
 *   4. 播完或中断瞬间清零 PCM 内存并恢复系统音频路由。
 */
class VoiceEngine(
    private val context: Context,
    private val channelProvider: () -> MethodChannel?,
) {
    companion object {
        const val SAMPLE_RATE = 16000
        const val MAX_SEC = 60
        private const val MAX_PCM_BYTES = SAMPLE_RATE * 2 * MAX_SEC
        private const val PEAK_COUNT = 28
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager

    // 录音状态
    private val recActive = AtomicBoolean(false)
    private var recThread: Thread? = null
    private var recBuffer: ByteArrayOutputStream? = null
    private var recStartMs: Long = 0L

    // 播放状态
    private val playLock = Any()
    private val playActive = AtomicBoolean(false)
    private var playThread: Thread? = null
    private var playTrack: AudioTrack? = null
    private var playingId: String? = null
    private var proximityLock: PowerManager.WakeLock? = null
    @Volatile
    private var currentEarpiece: Boolean = true

    @SuppressLint("MissingPermission")
    fun startRecord(): Boolean {
        if (recActive.get()) return true
        // 开始录音前先停掉正在播放的语音，避免外放回录
        stopPlay(null)

        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuf <= 0) return false
        val bufSize = max(minBuf * 2, 4096)

        val recorder = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufSize,
            )
        } catch (_: Exception) {
            null
        } ?: try {
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufSize,
            )
        } catch (_: Exception) {
            return false
        }

        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            return false
        }

        val out = ByteArrayOutputStream(64 * 1024)
        recBuffer = out
        recStartMs = System.currentTimeMillis()
        recActive.set(true)

        val thread = Thread({
            val chunk = ByteArray(3200) // ~100ms
            var lastTick = 0L
            try {
                recorder.startRecording()
                while (recActive.get()) {
                    val read = recorder.read(chunk, 0, chunk.size)
                    if (read > 0) {
                        synchronized(out) {
                            val remain = MAX_PCM_BYTES - out.size()
                            if (remain > 0) {
                                out.write(chunk, 0, min(read, remain))
                            }
                        }
                        val now = System.currentTimeMillis()
                        if (now - lastTick >= 90) {
                            lastTick = now
                            val level = rmsLevel(chunk, read)
                            val sec = (now - recStartMs) / 1000.0
                            post("recordTick", mapOf("sec" to sec, "level" to level))
                        }
                        if (synchronized(out) { out.size() >= MAX_PCM_BYTES }) {
                            recActive.set(false)
                            post("recordAutoStop", null)
                            break
                        }
                    } else if (read < 0) {
                        break
                    }
                }
            } catch (_: Exception) {
            } finally {
                Arrays.fill(chunk, 0)
                try {
                    if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop()
                } catch (_: Exception) {
                }
                try {
                    recorder.release()
                } catch (_: Exception) {
                }
            }
        }, "voice-rec")

        recThread = thread
        thread.start()
        return true
    }

    fun stopRecord(): Map<String, Any?> {
        recActive.set(false)
        try {
            recThread?.join(1500)
        } catch (_: InterruptedException) {
        }
        recThread = null

        val out = recBuffer
        recBuffer = null
        if (out == null) return mapOf("tooShort" to true)

        val pcm = synchronized(out) {
            val arr = out.toByteArray()
            out.reset()
            arr
        }

        val minBytes = (SAMPLE_RATE * 2 * 0.4).toInt()
        if (pcm.size < minBytes) {
            Arrays.fill(pcm, 0)
            return mapOf("tooShort" to true)
        }

        val dur = max(1, min(MAX_SEC, (pcm.size / (SAMPLE_RATE * 2.0)).roundToInt()))
        val peaks = computePeaks(pcm)
        val wav = wrapWav(pcm, SAMPLE_RATE)
        Arrays.fill(pcm, 0)
        return mapOf(
            "wav" to wav,
            "dur" to dur,
            "peaks" to peaks,
        )
    }

    fun cancelRecord() {
        recActive.set(false)
        try {
            recThread?.join(1000)
        } catch (_: InterruptedException) {
        }
        recThread = null
        val out = recBuffer
        recBuffer = null
        if (out != null) {
            synchronized(out) {
                val arr = out.toByteArray()
                Arrays.fill(arr, 0)
                out.reset()
            }
        }
    }

    fun playVoice(id: String, wavBytes: ByteArray, earpiece: Boolean): Boolean {
        stopPlay(null)
        val parsed = parseWav(wavBytes)
        Arrays.fill(wavBytes, 0)
        if (parsed == null || parsed.pcm.isEmpty()) return false

        currentEarpiece = earpiece
        val sampleRate = parsed.sampleRate
        val channelMask = if (parsed.channels == 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO
        val bytesPerSec = sampleRate * parsed.channels * (parsed.bitsPerSample / 8)
        if (bytesPerSec <= 0) {
            Arrays.fill(parsed.pcm, 0)
            return false
        }

        val minBuf = AudioTrack.getMinBufferSize(sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT)
        if (minBuf <= 0) {
            Arrays.fill(parsed.pcm, 0)
            return false
        }

        val useEarpiece = earpiece && !isHeadsetConnected()
        applyAudioRoute(useEarpiece)

        val attrsBuilder = AudioAttributes.Builder()
            .setUsage(if (useEarpiece) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Android 10+ 强制禁止系统录屏 / 第三方应用内录此音频流
            attrsBuilder.setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_NONE)
        }

        val track = try {
            AudioTrack.Builder()
                .setAudioAttributes(attrsBuilder.build())
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sampleRate)
                        .setChannelMask(channelMask)
                        .build()
                )
                .setBufferSizeInBytes(max(minBuf * 2, 4096))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
        } catch (_: Exception) {
            restoreAudioRoute()
            Arrays.fill(parsed.pcm, 0)
            return false
        }

        synchronized(playLock) {
            playTrack = track
            playingId = id
            playActive.set(true)
        }

        val pcm = parsed.pcm
        val totalBytes = pcm.size
        val durationSec = totalBytes.toDouble() / bytesPerSec

        val thread = Thread({
            var completedNaturally = false
            try {
                track.play()
                val step = max(1600, bytesPerSec / 12) // ~80ms 一帧
                var offset = 0
                while (playActive.get() && offset < totalBytes) {
                    val toWrite = min(step, totalBytes - offset)
                    val written = track.write(pcm, offset, toWrite)
                    if (written <= 0) break
                    offset += written
                    val frac = min(1.0, offset.toDouble() / totalBytes)
                    val remain = max(0, ceil(durationSec * (1.0 - frac)).toInt())
                    post("playProgress", mapOf("id" to id, "frac" to frac, "remain" to remain))
                }
                if (playActive.get() && offset >= totalBytes) {
                    // 等最后一点缓冲播完（最多 250ms）
                    val waitEnd = System.currentTimeMillis() + 250
                    while (playActive.get() && System.currentTimeMillis() < waitEnd) {
                        try {
                            Thread.sleep(25)
                        } catch (_: InterruptedException) {
                            break
                        }
                    }
                    completedNaturally = playActive.get()
                }
            } catch (_: Exception) {
            } finally {
                // 无论播完还是中断，立即清零 PCM 内存并释放音频硬件与距离锁
                Arrays.fill(pcm, 0)
                synchronized(playLock) {
                    if (playingId == id) {
                        playActive.set(false)
                        playingId = null
                    }
                    if (playTrack === track) playTrack = null
                }
                try {
                    track.pause()
                    track.flush()
                    track.stop()
                } catch (_: Exception) {
                }
                try {
                    track.release()
                } catch (_: Exception) {
                }
                restoreAudioRoute()
                if (completedNaturally) {
                    post("playEnded", mapOf("id" to id))
                }
            }
        }, "voice-play")

        synchronized(playLock) {
            playThread = thread
        }
        thread.start()
        return true
    }

    fun setEarpiece(earpiece: Boolean) {
        currentEarpiece = earpiece
        if (!playActive.get()) return
        val useEarpiece = earpiece && !isHeadsetConnected()
        applyAudioRoute(useEarpiece)
    }

    fun stopPlay(id: String?) {
        val threadToJoin: Thread?
        synchronized(playLock) {
            if (id != null && playingId != id) return
            playActive.set(false)
            playingId = null
            try {
                playTrack?.pause()
                playTrack?.flush()
                playTrack?.stop()
            } catch (_: Exception) {
            }
            threadToJoin = playThread
            playThread = null
        }
        if (threadToJoin != null && threadToJoin !== Thread.currentThread()) {
            try {
                threadToJoin.join(500)
            } catch (_: InterruptedException) {
            }
        }
        restoreAudioRoute()
    }

    fun release() {
        cancelRecord()
        stopPlay(null)
    }

    /* ---------------- 听筒路由 & 距离传感器息屏 ---------------- */

    private fun isHeadsetConnected(): Boolean {
        val devices = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        for (d in devices) {
            when (d.type) {
                AudioDeviceInfo.TYPE_WIRED_HEADSET,
                AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
                AudioDeviceInfo.TYPE_USB_HEADSET,
                AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
                AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
                AudioDeviceInfo.TYPE_BLE_HEADSET -> return true
            }
        }
        return false
    }

    @Suppress("DEPRECATION")
    private fun applyAudioRoute(useEarpiece: Boolean) {
        try {
            if (useEarpiece) {
                audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    val dev = audioManager.availableCommunicationDevices.firstOrNull {
                        it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                    }
                    if (dev != null) audioManager.setCommunicationDevice(dev)
                } else {
                    audioManager.isSpeakerphoneOn = false
                }
                acquireProximityLock()
            } else {
                releaseProximityLock()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    audioManager.clearCommunicationDevice()
                } else {
                    audioManager.isSpeakerphoneOn = true
                }
                audioManager.mode = AudioManager.MODE_NORMAL
            }
        } catch (_: Exception) {
        }
    }

    @Suppress("DEPRECATION")
    private fun restoreAudioRoute() {
        releaseProximityLock()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                audioManager.clearCommunicationDevice()
            } else {
                audioManager.isSpeakerphoneOn = false
            }
            audioManager.mode = AudioManager.MODE_NORMAL
        } catch (_: Exception) {
        }
    }

    @SuppressLint("WakelockTimeout")
    private fun acquireProximityLock() {
        try {
            if (proximityLock == null && powerManager.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
                proximityLock = powerManager.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "chatbuddy:voice_proximity")
            }
            val lock = proximityLock
            if (lock != null && !lock.isHeld) {
                lock.acquire(MAX_SEC * 1000L + 15_000L)
            }
        } catch (_: Exception) {
        }
    }

    private fun releaseProximityLock() {
        try {
            val lock = proximityLock
            if (lock != null && lock.isHeld) {
                lock.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY)
            }
        } catch (_: Exception) {
            try {
                proximityLock?.release()
            } catch (_: Exception) {
            }
        }
    }

    /* ---------------- WAV 编解码与波形提取 ---------------- */

    private class ParsedWav(val sampleRate: Int, val channels: Int, val bitsPerSample: Int, val pcm: ByteArray)

    private fun parseWav(bytes: ByteArray): ParsedWav? {
        if (bytes.size < 44) return null
        val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        if (bytes[0] != 'R'.code.toByte() || bytes[1] != 'I'.code.toByte() || bytes[2] != 'F'.code.toByte() || bytes[3] != 'F'.code.toByte()) return null
        if (bytes[8] != 'W'.code.toByte() || bytes[9] != 'A'.code.toByte() || bytes[10] != 'V'.code.toByte() || bytes[11] != 'E'.code.toByte()) return null

        var pos = 12
        var channels = 1
        var sampleRate = SAMPLE_RATE
        var bits = 16
        while (pos + 8 <= bytes.size) {
            val id = String(bytes, pos, 4, Charsets.US_ASCII)
            val size = bb.getInt(pos + 4)
            pos += 8
            if (size < 0 || pos + size > bytes.size) {
                if (id == "data") {
                    val actual = bytes.size - pos
                    if (actual > 0) return ParsedWav(sampleRate, channels, bits, bytes.copyOfRange(pos, pos + actual))
                }
                return null
            }
            if (id == "fmt " && size >= 16) {
                channels = bb.getShort(pos + 2).toInt()
                sampleRate = bb.getInt(pos + 4)
                bits = bb.getShort(pos + 14).toInt()
            } else if (id == "data") {
                if (bits != 16 || channels !in 1..2 || sampleRate !in 8000..48000) return null
                return ParsedWav(sampleRate, channels, bits, bytes.copyOfRange(pos, pos + size))
            }
            pos += size + (size and 1)
        }
        return null
    }

    private fun wrapWav(pcm: ByteArray, sampleRate: Int): ByteArray {
        val dataLen = pcm.size
        val out = ByteArray(44 + dataLen)
        val bb = ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN)
        out[0] = 'R'.code.toByte(); out[1] = 'I'.code.toByte(); out[2] = 'F'.code.toByte(); out[3] = 'F'.code.toByte()
        bb.putInt(4, 36 + dataLen)
        out[8] = 'W'.code.toByte(); out[9] = 'A'.code.toByte(); out[10] = 'V'.code.toByte(); out[11] = 'E'.code.toByte()
        out[12] = 'f'.code.toByte(); out[13] = 'm'.code.toByte(); out[14] = 't'.code.toByte(); out[15] = ' '.code.toByte()
        bb.putInt(16, 16)
        bb.putShort(20, 1) // PCM
        bb.putShort(22, 1) // mono
        bb.putInt(24, sampleRate)
        bb.putInt(28, sampleRate * 2)
        bb.putShort(32, 2)
        bb.putShort(34, 16)
        out[36] = 'd'.code.toByte(); out[37] = 'a'.code.toByte(); out[38] = 't'.code.toByte(); out[39] = 'a'.code.toByte()
        bb.putInt(40, dataLen)
        System.arraycopy(pcm, 0, out, 44, dataLen)
        return out
    }

    private fun rmsLevel(buf: ByteArray, len: Int): Double {
        var sum = 0.0
        var count = 0
        var i = 0
        while (i + 1 < len) {
            val s = ((buf[i].toInt() and 0xFF) or (buf[i + 1].toInt() shl 8)).toShort().toDouble() / 32768.0
            sum += s * s
            count++
            i += 8
        }
        return min(1.0, sqrt(sum / max(1, count)) * 3.5)
    }

    private fun computePeaks(pcm: ByteArray): List<Int> {
        val sampleCount = pcm.size / 2
        if (sampleCount <= 0) return List(PEAK_COUNT) { 12 }
        val step = max(1, sampleCount / PEAK_COUNT)
        val raw = DoubleArray(PEAK_COUNT)
        var maxRms = 0.001
        for (i in 0 until PEAK_COUNT) {
            val start = i * step
            val end = if (i == PEAK_COUNT - 1) sampleCount else min(sampleCount, start + step)
            var sum = 0.0
            for (j in start until end) {
                val off = j * 2
                val s = ((pcm[off].toInt() and 0xFF) or (pcm[off + 1].toInt() shl 8)).toShort().toDouble() / 32768.0
                sum += s * s
            }
            val rms = sqrt(sum / max(1, end - start))
            raw[i] = rms
            if (rms > maxRms) maxRms = rms
        }
        return List(PEAK_COUNT) { i ->
            val norm = min(1.0, raw[i] / maxRms)
            (norm * 92 + 8).roundToInt().coerceIn(8, 100)
        }
    }

    private fun post(method: String, args: Any?) {
        mainHandler.post {
            try {
                channelProvider()?.invokeMethod(method, args)
            } catch (_: Exception) {
            }
        }
    }
}
