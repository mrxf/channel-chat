//! macOS 原生麦克风 / 摄像头权限请求（AVFoundation）
//!
//! Tauri 的 WKWebView 在 macOS 上直接调用 `navigator.mediaDevices.getUserMedia` 时，
//! 往往不会主动触发系统 TCC 权限弹窗，导致应用从未出现在「系统设置 → 隐私与安全性 → 麦克风/摄像头」中。
//! 在进入录音或通话前，先由宿主进程通过 `AVCaptureDevice` 发起原生授权请求即可解决。

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPermStatus {
    pub audio: &'static str,
    pub video: &'static str,
}

#[cfg(target_os = "macos")]
mod mac {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, Bool};
    use objc2_foundation::NSString;
    use std::sync::Mutex;
    use tokio::sync::oneshot;

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    // AVAuthorizationStatus:
    //   0 = NotDetermined, 1 = Restricted, 2 = Denied, 3 = Authorized
    async fn ensure_media_type(media_type_str: &str) -> &'static str {
        let pending: Result<&'static str, oneshot::Receiver<bool>> = {
            let Some(cls) = AnyClass::get(c"AVCaptureDevice") else {
                return "unknown";
            };
            let media_type = NSString::from_str(media_type_str);
            let status: isize =
                unsafe { msg_send![cls, authorizationStatusForMediaType: &*media_type] };
            match status {
                3 => Ok("granted"),
                1 => Ok("restricted"),
                2 => Ok("denied"),
                0 => {
                    let (tx, rx) = oneshot::channel::<bool>();
                    let tx = Mutex::new(Some(tx));
                    let block = RcBlock::new(move |granted: Bool| {
                        if let Ok(mut guard) = tx.lock() {
                            if let Some(sender) = guard.take() {
                                let _ = sender.send(granted.as_bool());
                            }
                        }
                    });
                    unsafe {
                        let _: () = msg_send![
                            cls,
                            requestAccessForMediaType: &*media_type,
                            completionHandler: &*block
                        ];
                    }
                    Err(rx)
                }
                _ => Ok("unknown"),
            }
        };
        match pending {
            Ok(s) => s,
            Err(rx) => match rx.await {
                Ok(true) => "granted",
                Ok(false) => "denied",
                Err(_) => "unknown",
            },
        }
    }

    pub async fn request(video: bool) -> super::MediaPermStatus {
        let audio = ensure_media_type("soun").await;
        let video_status = if video {
            ensure_media_type("vide").await
        } else {
            "skipped"
        };
        super::MediaPermStatus {
            audio,
            video: video_status,
        }
    }
}

#[tauri::command]
pub async fn request_media_permission(video: bool) -> MediaPermStatus {
    #[cfg(target_os = "macos")]
    {
        mac::request(video).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        MediaPermStatus {
            audio: "granted",
            video: if video { "granted" } else { "skipped" },
        }
    }
}
