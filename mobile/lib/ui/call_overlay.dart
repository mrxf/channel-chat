// 移动端 1 对 1 实时语音 / 视频通话浮层（支持收起为顶部状态条 + 全屏视频/语音卡片）
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../chat/chat_controller.dart';
import '../core/call_engine.dart';
import 'theme.dart';
import 'widgets.dart';

String _fmtCallDur(int sec) {
  final m = sec ~/ 60;
  final s = sec % 60;
  return '$m:${s.toString().padLeft(2, '0')}';
}

/// 顶栏下方紧凑状态条（来电横幅 / 收起后的通话状态条）
class CallBanner extends StatelessWidget {
  const CallBanner({
    super.key,
    required this.chat,
    required this.onAcceptAudio,
    required this.onAcceptVideo,
  });

  final ChatController chat;
  final VoidCallback onAcceptAudio;
  final VoidCallback onAcceptVideo;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final call = chat.call;
    return ListenableBuilder(
      listenable: call,
      builder: (context, _) {
        if (!call.active) return const SizedBox.shrink();
        final peer = call.peerCid != null ? chat.members[call.peerCid] : null;
        final who = peer != null ? chat.labelOf(peer).text : '对方';
        final ringing = call.phase == CallPhase.ringing;
        // 非来电且未收起时，由全屏浮层负责展示
        if (!ringing && !call.minimized) return const SizedBox.shrink();

        final statusText = switch (call.phase) {
          CallPhase.ringing => call.video ? '$who 邀请视频通话' : '$who 邀请语音通话',
          CallPhase.calling => '正在呼叫 $who…',
          CallPhase.connecting => '正在建立端到端加密通道…',
          CallPhase.connected => '加密通话中 · ${_fmtCallDur(call.durationSec)}',
          CallPhase.idle => '',
        };

        return Container(
          margin: const EdgeInsets.fromLTRB(14, 4, 14, 6),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: p.panel,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: ringing ? brand.withValues(alpha: 0.45) : p.line),
            boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.06), blurRadius: 10, offset: const Offset(0, 3))],
          ),
          child: InkWell(
            onTap: ringing ? null : () => call.setMinimized(false),
            child: Row(children: [
              StatusDot(color: call.phase == CallPhase.connected ? p.good : const Color(0xFFE0A030), size: 8, pulse: true),
              const SizedBox(width: 10),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Text(statusText, style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: p.text), overflow: TextOverflow.ellipsis),
                  if (!ringing)
                    Text('点击展开通话画面 · 端到端加密', style: TextStyle(fontSize: 11.5, color: p.muted)),
                ]),
              ),
              if (ringing) ...[
                IconButton.filled(
                  onPressed: () {
                    HapticFeedback.mediumImpact();
                    call.rejectCall();
                  },
                  style: IconButton.styleFrom(backgroundColor: p.bad, foregroundColor: Colors.white),
                  icon: const Icon(Icons.call_end_rounded, size: 19),
                  tooltip: '拒接',
                ),
                const SizedBox(width: 6),
                IconButton.filled(
                  onPressed: () {
                    HapticFeedback.mediumImpact();
                    onAcceptAudio();
                  },
                  style: IconButton.styleFrom(backgroundColor: p.good, foregroundColor: Colors.white),
                  icon: const Icon(Icons.call_rounded, size: 19),
                  tooltip: '语音接听',
                ),
                if (call.video) ...[
                  const SizedBox(width: 6),
                  IconButton.filled(
                    onPressed: () {
                      HapticFeedback.mediumImpact();
                      onAcceptVideo();
                    },
                    style: IconButton.styleFrom(backgroundColor: brand, foregroundColor: Colors.white),
                    icon: const Icon(Icons.videocam_rounded, size: 19),
                    tooltip: '视频接听',
                  ),
                ],
              ] else ...[
                IconButton(
                  onPressed: call.toggleMic,
                  icon: Icon(call.micOn ? Icons.mic_rounded : Icons.mic_off_rounded, size: 20, color: call.micOn ? p.text : p.bad),
                ),
                IconButton.filled(
                  onPressed: () => call.hangup(),
                  style: IconButton.styleFrom(backgroundColor: p.bad, foregroundColor: Colors.white, minimumSize: const Size(34, 34)),
                  icon: const Icon(Icons.call_end_rounded, size: 18),
                ),
              ],
            ]),
          ),
        );
      },
    );
  }
}

/// 全屏语音 / 视频通话浮层（受 FLAG_SECURE 保护防截屏录屏）
class CallFullOverlay extends StatelessWidget {
  const CallFullOverlay({
    super.key,
    required this.chat,
    required this.onToggleCam,
  });

  final ChatController chat;
  final VoidCallback onToggleCam;

  @override
  Widget build(BuildContext context) {
    final call = chat.call;
    return ListenableBuilder(
      listenable: call,
      builder: (context, _) {
        if (!call.active || call.phase == CallPhase.ringing || call.minimized) {
          return const SizedBox.shrink();
        }
        final peer = call.peerCid != null ? chat.members[call.peerCid] : null;
        final who = peer != null ? chat.labelOf(peer).text : '对方';
        final p = context.pal;
        final isVideo = call.video;
        final statusStr = switch (call.phase) {
          CallPhase.calling => '正在呼叫…',
          CallPhase.connecting => '正在建立端到端加密通道…',
          CallPhase.connected => _fmtCallDur(call.durationSec),
          _ => '',
        };

        return Positioned.fill(
          child: Material(
            color: const Color(0xFF141413),
            child: SafeArea(
              child: Stack(children: [
                // 远端视频画布
                if (isVideo && call.peerCamOn)
                  Positioned.fill(
                    child: RTCVideoView(
                      call.remoteRenderer,
                      objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover,
                    ),
                  )
                else
                  Center(
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      Container(
                        width: 88,
                        height: 88,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: brand.withValues(alpha: 0.2),
                          border: Border.all(color: brand.withValues(alpha: 0.55), width: 2),
                        ),
                        alignment: Alignment.center,
                        child: Text(
                          who.isNotEmpty ? who.characters.first.toUpperCase() : '?',
                          style: const TextStyle(fontSize: 34, fontWeight: FontWeight.w600, color: Colors.white),
                        ),
                      ),
                      const SizedBox(height: 18),
                      Text(who, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w600, color: Colors.white)),
                      const SizedBox(height: 6),
                      Text(statusStr, style: TextStyle(fontSize: 14, color: Colors.white.withValues(alpha: 0.7))),
                      if (!call.peerMicOn && call.phase == CallPhase.connected) ...[
                        const SizedBox(height: 10),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                          decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(99)),
                          child: const Text('对方已静音', style: TextStyle(fontSize: 12, color: Colors.white70)),
                        ),
                      ],
                    ]),
                  ),

                // 顶部栏：收起按钮 + 加密标识 + 对方昵称
                Positioned(
                  top: 8,
                  left: 12,
                  right: 12,
                  child: Row(children: [
                    IconButton(
                      onPressed: () => call.setMinimized(true),
                      style: IconButton.styleFrom(backgroundColor: Colors.black38, foregroundColor: Colors.white),
                      icon: const Icon(Icons.keyboard_arrow_down_rounded, size: 26),
                      tooltip: '收起',
                    ),
                    const Spacer(),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                      decoration: BoxDecoration(color: Colors.black45, borderRadius: BorderRadius.circular(99)),
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        const Icon(Icons.lock_outline_rounded, size: 13, color: Colors.white70),
                        const SizedBox(width: 5),
                        Text(
                          isVideo ? '$who · $statusStr' : 'DTLS-SRTP 端到端加密',
                          style: const TextStyle(fontSize: 12, color: Colors.white),
                        ),
                      ]),
                    ),
                    const Spacer(),
                    if (isVideo && call.camOn)
                      IconButton(
                        onPressed: call.switchCamera,
                        style: IconButton.styleFrom(backgroundColor: Colors.black38, foregroundColor: Colors.white),
                        icon: const Icon(Icons.cameraswitch_rounded, size: 20),
                        tooltip: '切换前后摄像头',
                      )
                    else
                      const SizedBox(width: 48),
                  ]),
                ),

                // 右上角本地画中画视频
                if (isVideo && call.camOn)
                  Positioned(
                    top: 68,
                    right: 14,
                    width: 108,
                    height: 152,
                    child: GestureDetector(
                      onTap: call.switchCamera,
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(14),
                        child: Container(
                          decoration: BoxDecoration(
                            color: const Color(0xFF222220),
                            border: Border.all(color: Colors.white24, width: 1.5),
                            borderRadius: BorderRadius.circular(14),
                          ),
                          child: RTCVideoView(
                            call.localRenderer,
                            mirror: true,
                            objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover,
                          ),
                        ),
                      ),
                    ),
                  ),

                // 底部控制栏
                Positioned(
                  left: 20,
                  right: 20,
                  bottom: 28,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                    decoration: BoxDecoration(
                      color: Colors.black.withValues(alpha: 0.52),
                      borderRadius: BorderRadius.circular(24),
                      border: Border.all(color: Colors.white12),
                    ),
                    child: Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
                      _CtrlBtn(
                        icon: call.micOn ? Icons.mic_rounded : Icons.mic_off_rounded,
                        label: call.micOn ? '静音' : '已静音',
                        active: !call.micOn,
                        onTap: call.toggleMic,
                      ),
                      _CtrlBtn(
                        icon: call.speakerOn ? Icons.volume_up_rounded : Icons.hearing_rounded,
                        label: call.speakerOn ? '外放' : '听筒',
                        active: call.speakerOn,
                        onTap: call.toggleSpeaker,
                      ),
                      _CtrlBtn(
                        icon: call.camOn ? Icons.videocam_rounded : Icons.videocam_off_rounded,
                        label: call.camOn ? '关视频' : '开视频',
                        active: call.camOn,
                        onTap: onToggleCam,
                      ),
                      Column(mainAxisSize: MainAxisSize.min, children: [
                        IconButton.filled(
                          onPressed: () {
                            HapticFeedback.mediumImpact();
                            call.hangup();
                          },
                          style: IconButton.styleFrom(
                            backgroundColor: p.bad,
                            foregroundColor: Colors.white,
                            minimumSize: const Size(54, 54),
                          ),
                          icon: const Icon(Icons.call_end_rounded, size: 26),
                        ),
                        const SizedBox(height: 4),
                        const Text('挂断', style: TextStyle(fontSize: 11, color: Colors.white70)),
                      ]),
                    ]),
                  ),
                ),
              ]),
            ),
          ),
        );
      },
    );
  }
}

class _CtrlBtn extends StatelessWidget {
  const _CtrlBtn({required this.icon, required this.label, required this.active, required this.onTap});
  final IconData icon;
  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Column(mainAxisSize: MainAxisSize.min, children: [
      IconButton.filled(
        onPressed: onTap,
        style: IconButton.styleFrom(
          backgroundColor: active ? Colors.white : Colors.white.withValues(alpha: 0.16),
          foregroundColor: active ? const Color(0xFF141413) : Colors.white,
          minimumSize: const Size(50, 50),
        ),
        icon: Icon(icon, size: 23),
      ),
      const SizedBox(height: 4),
      Text(label, style: const TextStyle(fontSize: 11, color: Colors.white70)),
    ]);
  }
}
