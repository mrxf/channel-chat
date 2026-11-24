// 1 对 1 实时语音 / 视频通话引擎（flutter_webrtc，纯内存 DTLS-SRTP 加密）
// - 信令（offer / answer / ice / hangup / state）与桌面端 src/call.js 协议 100% 一致
// - 局域网默认零配置直连（iceServers = []，不向第三方 STUN 泄露 IP）；支持设置页自定义 STUN / TURN
// - 支持语音通话中动态开启/关闭摄像头（重协商）、前后置镜头切换、听筒/扬声器切换、静音
import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

enum CallPhase { idle, calling, ringing, connecting, connected }

/// 与桌面端 src/call.js parseIceServers 完全一致
List<Map<String, dynamic>> parseIceServers(String raw) {
  final trimmed = raw.trim();
  if (trimmed.isEmpty) return const [];
  final out = <Map<String, dynamic>>[];
  final entries = trimmed.split(RegExp(r'[\n,;]+')).map((s) => s.trim()).where((s) => s.isNotEmpty);
  final schemeRe = RegExp(r'^(stun|stuns|turn|turns):', caseSensitive: false);
  for (final line in entries.take(12)) {
    final parts = line.split('|').map((s) => s.trim()).toList();
    final urls = parts[0];
    if (!schemeRe.hasMatch(urls)) continue;
    final item = <String, dynamic>{'urls': urls};
    if (parts.length > 1 && parts[1].isNotEmpty) item['username'] = parts[1];
    if (parts.length > 2 && parts[2].isNotEmpty) item['credential'] = parts[2];
    out.add(item);
  }
  return out;
}

class CallEngine extends ChangeNotifier {
  CallEngine({
    required this.sendSignal,
    required this.getIceServers,
    required this.defaultEarpiece,
    this.onIncomingRing,
    this.onError,
    this.onEnded,
  });

  final bool Function(String peerCid, Map<String, dynamic> payload) sendSignal;
  final List<Map<String, dynamic>> Function() getIceServers;
  final bool Function() defaultEarpiece;
  final VoidCallback? onIncomingRing;
  final void Function(String message)? onError;
  final void Function(String reason, int durationSec)? onEnded;

  static const _ringTimeout = Duration(seconds: 35);
  static final _rng = Random.secure();

  final RTCVideoRenderer localRenderer = RTCVideoRenderer();
  final RTCVideoRenderer remoteRenderer = RTCVideoRenderer();
  bool _renderersReady = false;

  RTCPeerConnection? _pc;
  MediaStream? _localStream;
  MediaStream? _remoteStream;
  final List<RTCIceCandidate> _pendingIce = [];
  Timer? _ringTimer;
  Timer? _durTimer;
  DateTime? _startedAt;
  String? _incomingOfferSdp;

  CallPhase phase = CallPhase.idle;
  String? callId;
  String? peerCid;
  bool video = false;
  bool micOn = true;
  bool camOn = false;
  bool peerMicOn = true;
  bool peerCamOn = false;
  bool speakerOn = false;
  bool minimized = false;
  int durationSec = 0;

  bool get active => phase != CallPhase.idle;

  String _genCallId() {
    final buf = StringBuffer();
    for (var i = 0; i < 8; i++) {
      buf.write(_rng.nextInt(256).toRadixString(16).padLeft(2, '0'));
    }
    return buf.toString();
  }

  Future<void> _ensureRenderers() async {
    if (_renderersReady) return;
    await localRenderer.initialize();
    await remoteRenderer.initialize();
    _renderersReady = true;
  }

  void setMinimized(bool v) {
    if (minimized == v) return;
    minimized = v;
    notifyListeners();
  }

  Future<void> _applyAudioRoute(bool speaker) async {
    speakerOn = speaker;
    try {
      await Helper.setSpeakerphoneOn(speakerOn);
    } catch (_) {}
    notifyListeners();
  }

  Future<void> toggleSpeaker() => _applyAudioRoute(!speakerOn);

  void _clearTimers() {
    _ringTimer?.cancel();
    _ringTimer = null;
    _durTimer?.cancel();
    _durTimer = null;
  }

  void _startDurTimer() {
    if (_durTimer != null) return;
    _startedAt = DateTime.now();
    durationSec = 0;
    _durTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (_startedAt == null) return;
      durationSec = DateTime.now().difference(_startedAt!).inSeconds;
      notifyListeners();
    });
  }

  Future<MediaStream> _acquireMedia(bool wantVideo) async {
    final constraints = <String, dynamic>{
      'audio': {
        'echoCancellation': true,
        'noiseSuppression': true,
        'autoGainControl': true,
      },
      'video': wantVideo
          ? {
              'facingMode': 'user',
              'width': {'ideal': 720, 'max': 1280},
              'height': {'ideal': 1280, 'max': 1280},
              'frameRate': {'ideal': 24, 'max': 30},
            }
          : false,
    };
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  Future<RTCPeerConnection> _createPc(String id, String peer) async {
    final config = <String, dynamic>{
      'iceServers': getIceServers(),
      'sdpSemantics': 'unified-plan',
    };
    final pc = await createPeerConnection(config);

    pc.onIceCandidate = (c) {
      if (callId != id || c.candidate == null || c.candidate!.isEmpty) return;
      sendSignal(peer, {
        't': 'call',
        'callId': id,
        'op': 'ice',
        'cand': {
          'candidate': c.candidate,
          'sdpMid': c.sdpMid,
          'sdpMLineIndex': c.sdpMLineIndex,
        },
      });
    };

    pc.onTrack = (ev) {
      if (callId != id) return;
      if (ev.streams.isNotEmpty) {
        _remoteStream = ev.streams.first;
        if (_renderersReady) remoteRenderer.srcObject = _remoteStream;
      }
      if (ev.track.kind == 'video') {
        video = true;
        peerCamOn = true;
      }
      notifyListeners();
    };

    pc.onConnectionState = (state) {
      if (callId != id) return;
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _ringTimer?.cancel();
        _ringTimer = null;
        if (phase != CallPhase.connected) {
          phase = CallPhase.connected;
          _startDurTimer();
          notifyListeners();
        }
      } else if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        sendSignal(peer, {'t': 'call', 'callId': id, 'op': 'hangup', 'reason': 'error'});
        _cleanup(reason: 'error', notifyEnd: true);
      } else if (state == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
        _cleanup(reason: 'hangup', notifyEnd: true);
      }
    };

    return pc;
  }

  Future<void> _flushPendingIce() async {
    final pc = _pc;
    if (pc == null) return;
    final list = List<RTCIceCandidate>.from(_pendingIce);
    _pendingIce.clear();
    for (final c in list) {
      try {
        await pc.addCandidate(c);
      } catch (_) {}
    }
  }

  Future<bool> startCall(String targetCid, {required bool wantVideo}) async {
    if (phase != CallPhase.idle) return false;
    await _ensureRenderers();
    final id = _genCallId();
    phase = CallPhase.calling;
    callId = id;
    peerCid = targetCid;
    video = wantVideo;
    micOn = true;
    camOn = wantVideo;
    peerMicOn = true;
    peerCamOn = wantVideo;
    minimized = false;
    durationSec = 0;
    _incomingOfferSdp = null;
    notifyListeners();

    try {
      _localStream = await _acquireMedia(wantVideo);
    } catch (_) {
      await _cleanup(reason: 'error', notifyEnd: false);
      onError?.call(wantVideo ? '无法访问麦克风或摄像头，请检查权限' : '无法访问麦克风，请检查权限');
      return false;
    }
    if (callId != id) {
      await _stopLocalStream();
      return false;
    }
    if (_renderersReady) localRenderer.srcObject = _localStream;
    await _applyAudioRoute(wantVideo ? true : !defaultEarpiece());

    try {
      final pc = await _createPc(id, targetCid);
      _pc = pc;
      for (final track in _localStream!.getTracks()) {
        await pc.addTrack(track, _localStream!);
      }
      final offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (callId != id) return false;
      final sent = sendSignal(targetCid, {
        't': 'call',
        'callId': id,
        'op': 'offer',
        'video': wantVideo,
        'sdp': offer.sdp,
      });
      if (!sent) {
        await _cleanup(reason: 'offline', notifyEnd: false);
        onError?.call('对方已离线，无法发起通话');
        return false;
      }
      _ringTimer = Timer(_ringTimeout, () {
        if (callId == id && phase == CallPhase.calling) {
          sendSignal(targetCid, {'t': 'call', 'callId': id, 'op': 'hangup', 'reason': 'timeout'});
          _cleanup(reason: 'timeout', notifyEnd: true);
        }
      });
      return true;
    } catch (_) {
      await _cleanup(reason: 'error', notifyEnd: false);
      onError?.call('发起通话失败');
      return false;
    }
  }

  Future<bool> acceptCall({required bool wantVideo}) async {
    if (phase != CallPhase.ringing || _incomingOfferSdp == null || callId == null || peerCid == null) {
      return false;
    }
    await _ensureRenderers();
    final id = callId!;
    final peer = peerCid!;
    final offerSdp = _incomingOfferSdp!;
    _incomingOfferSdp = null;
    _ringTimer?.cancel();
    _ringTimer = null;

    phase = CallPhase.connecting;
    video = video || wantVideo;
    camOn = wantVideo;
    micOn = true;
    minimized = false;
    notifyListeners();

    try {
      _localStream = await _acquireMedia(wantVideo);
    } catch (_) {
      sendSignal(peer, {'t': 'call', 'callId': id, 'op': 'hangup', 'reason': 'error'});
      await _cleanup(reason: 'error', notifyEnd: false);
      onError?.call(wantVideo ? '无法访问麦克风或摄像头，请检查权限' : '无法访问麦克风，请检查权限');
      return false;
    }
    if (callId != id) {
      await _stopLocalStream();
      return false;
    }
    if (_renderersReady) localRenderer.srcObject = _localStream;
    await _applyAudioRoute(video ? true : !defaultEarpiece());

    try {
      final pc = await _createPc(id, peer);
      _pc = pc;
      for (final track in _localStream!.getTracks()) {
        await pc.addTrack(track, _localStream!);
      }
      await pc.setRemoteDescription(RTCSessionDescription(offerSdp, 'offer'));
      await _flushPendingIce();
      final answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (callId != id) return false;
      sendSignal(peer, {
        't': 'call',
        'callId': id,
        'op': 'answer',
        'video': wantVideo,
        'sdp': answer.sdp,
      });
      sendSignal(peer, {'t': 'call', 'callId': id, 'op': 'state', 'mic': micOn, 'cam': camOn});
      return true;
    } catch (_) {
      sendSignal(peer, {'t': 'call', 'callId': id, 'op': 'hangup', 'reason': 'error'});
      await _cleanup(reason: 'error', notifyEnd: false);
      onError?.call('接听通话失败');
      return false;
    }
  }

  void rejectCall() {
    if (phase != CallPhase.ringing) return;
    if (peerCid != null && callId != null) {
      sendSignal(peerCid!, {'t': 'call', 'callId': callId, 'op': 'hangup', 'reason': 'reject'});
    }
    _cleanup(reason: 'reject', notifyEnd: true);
  }

  void hangup([String? reason]) {
    if (phase == CallPhase.idle) return;
    final r = reason ?? (phase == CallPhase.calling ? 'cancel' : phase == CallPhase.ringing ? 'reject' : 'hangup');
    if (peerCid != null && callId != null) {
      sendSignal(peerCid!, {'t': 'call', 'callId': callId, 'op': 'hangup', 'reason': r});
    }
    _cleanup(reason: r, notifyEnd: true);
  }

  void toggleMic() {
    if (!active || _localStream == null) return;
    micOn = !micOn;
    for (final t in _localStream!.getAudioTracks()) {
      t.enabled = micOn;
    }
    if (peerCid != null && callId != null) {
      sendSignal(peerCid!, {'t': 'call', 'callId': callId, 'op': 'state', 'mic': micOn, 'cam': camOn});
    }
    notifyListeners();
  }

  Future<void> toggleCam() async {
    if ((phase != CallPhase.connected && phase != CallPhase.connecting) || _localStream == null || _pc == null) {
      return;
    }
    final tracks = _localStream!.getVideoTracks();
    if (tracks.isNotEmpty) {
      camOn = !camOn;
      for (final t in tracks) {
        t.enabled = camOn;
      }
      if (peerCid != null && callId != null) {
        sendSignal(peerCid!, {'t': 'call', 'callId': callId, 'op': 'state', 'mic': micOn, 'cam': camOn});
      }
      notifyListeners();
      return;
    }
    // 语音通话中动态开启摄像头并重协商
    try {
      final camStream = await navigator.mediaDevices.getUserMedia({
        'audio': false,
        'video': {
          'facingMode': 'user',
          'width': {'ideal': 720, 'max': 1280},
          'height': {'ideal': 1280, 'max': 1280},
          'frameRate': {'ideal': 24, 'max': 30},
        },
      });
      final vTrack = camStream.getVideoTracks().firstOrNull;
      if (vTrack == null || _pc == null || !active) {
        await camStream.dispose();
        return;
      }
      await _localStream!.addTrack(vTrack);
      await _pc!.addTrack(vTrack, _localStream!);
      if (_renderersReady) localRenderer.srcObject = _localStream;
      video = true;
      camOn = true;
      minimized = false;
      await _applyAudioRoute(true);
      final offer = await _pc!.createOffer();
      await _pc!.setLocalDescription(offer);
      sendSignal(peerCid!, {
        't': 'call',
        'callId': callId,
        'op': 'offer',
        'video': true,
        'renegotiate': true,
        'sdp': offer.sdp,
      });
      sendSignal(peerCid!, {'t': 'call', 'callId': callId, 'op': 'state', 'mic': micOn, 'cam': true});
      notifyListeners();
    } catch (_) {
      onError?.call('无法开启摄像头，请检查相机权限');
    }
  }

  Future<void> switchCamera() async {
    final track = _localStream?.getVideoTracks().firstOrNull;
    if (track == null) return;
    try {
      await Helper.switchCamera(track);
    } catch (_) {}
  }

  Future<void> handleSignal(String fromCid, Map<String, dynamic> m) async {
    final op = m['op'];
    final id = m['callId'];
    if (op is! String || id is! String) return;

    if (op == 'offer') {
      final sdp = m['sdp'];
      if (sdp is! String) return;
      // 通话中重协商（对方动态打开视频）
      if (m['renegotiate'] == true && callId == id && peerCid == fromCid && _pc != null) {
        try {
          await _pc!.setRemoteDescription(RTCSessionDescription(sdp, 'offer'));
          await _flushPendingIce();
          final answer = await _pc!.createAnswer();
          await _pc!.setLocalDescription(answer);
          video = video || m['video'] == true;
          peerCamOn = m['video'] == true;
          sendSignal(fromCid, {
            't': 'call',
            'callId': id,
            'op': 'answer',
            'video': camOn,
            'renegotiate': true,
            'sdp': answer.sdp,
          });
          notifyListeners();
        } catch (_) {}
        return;
      }
      if (phase != CallPhase.idle) {
        if (callId != id) {
          sendSignal(fromCid, {'t': 'call', 'callId': id, 'op': 'hangup', 'reason': 'busy'});
        }
        return;
      }
      phase = CallPhase.ringing;
      callId = id;
      peerCid = fromCid;
      video = m['video'] == true;
      micOn = true;
      camOn = false;
      peerMicOn = true;
      peerCamOn = m['video'] == true;
      minimized = false;
      durationSec = 0;
      _incomingOfferSdp = sdp;
      _pendingIce.clear();
      _ringTimer = Timer(_ringTimeout, () {
        if (callId == id && phase == CallPhase.ringing) {
          _cleanup(reason: 'timeout', notifyEnd: true);
        }
      });
      notifyListeners();
      onIncomingRing?.call();
      return;
    }

    if (callId != id || peerCid != fromCid) return;

    if (op == 'answer') {
      final sdp = m['sdp'];
      if (sdp is! String || _pc == null) return;
      try {
        await _pc!.setRemoteDescription(RTCSessionDescription(sdp, 'answer'));
        await _flushPendingIce();
        if (m['renegotiate'] != true) {
          phase = CallPhase.connecting;
          peerCamOn = m['video'] == true;
          _ringTimer?.cancel();
          _ringTimer = null;
          notifyListeners();
        }
      } catch (_) {
        onError?.call('通话连接失败');
        hangup('error');
      }
      return;
    }

    if (op == 'ice') {
      final c = m['cand'];
      if (c is! Map || c['candidate'] is! String) return;
      final cand = RTCIceCandidate(
        c['candidate'] as String,
        c['sdpMid'] as String?,
        c['sdpMLineIndex'] is int ? c['sdpMLineIndex'] as int : null,
      );
      if (_pc != null && await _pc!.getRemoteDescription() != null) {
        try {
          await _pc!.addCandidate(cand);
        } catch (_) {}
      } else if (_pendingIce.length < 120) {
        _pendingIce.add(cand);
      }
      return;
    }

    if (op == 'state') {
      if (m['mic'] is bool) peerMicOn = m['mic'] as bool;
      if (m['cam'] is bool) {
        peerCamOn = m['cam'] as bool;
        if (peerCamOn) video = true;
      }
      notifyListeners();
      return;
    }

    if (op == 'hangup') {
      final r = m['reason'] is String ? m['reason'] as String : 'hangup';
      await _cleanup(reason: r, notifyEnd: true);
    }
  }

  void onPeerOffline(String cid) {
    if (active && peerCid == cid) {
      _cleanup(reason: 'offline', notifyEnd: true);
    }
  }

  Future<void> _stopLocalStream() async {
    final s = _localStream;
    _localStream = null;
    if (_renderersReady) localRenderer.srcObject = null;
    if (s != null) {
      for (final t in s.getTracks()) {
        try {
          await t.stop();
        } catch (_) {}
      }
      try {
        await s.dispose();
      } catch (_) {}
    }
  }

  Future<void> _cleanup({required String reason, required bool notifyEnd}) async {
    final prevActive = active;
    final prevDur = durationSec;
    _clearTimers();
    _pendingIce.clear();
    _incomingOfferSdp = null;
    _startedAt = null;

    final pc = _pc;
    _pc = null;
    if (pc != null) {
      pc.onIceCandidate = null;
      pc.onTrack = null;
      pc.onConnectionState = null;
      try {
        await pc.close();
      } catch (_) {}
      try {
        await pc.dispose();
      } catch (_) {}
    }
    await _stopLocalStream();
    _remoteStream = null;
    if (_renderersReady) remoteRenderer.srcObject = null;

    phase = CallPhase.idle;
    callId = null;
    peerCid = null;
    video = false;
    micOn = true;
    camOn = false;
    peerMicOn = true;
    peerCamOn = false;
    minimized = false;
    durationSec = 0;
    notifyListeners();

    if (notifyEnd && prevActive) {
      onEnded?.call(reason, prevDur);
    }
  }

  @override
  void dispose() {
    _clearTimers();
    final pc = _pc;
    _pc = null;
    pc?.close();
    pc?.dispose();
    _localStream?.dispose();
    _localStream = null;
    if (_renderersReady) {
      localRenderer.dispose();
      remoteRenderer.dispose();
    }
    super.dispose();
  }
}
