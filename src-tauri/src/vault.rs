//! 内存保险箱：解密后的视频只存在于这里（进程内存），通过 `vault://` 协议喂给播放器。
//! 不写磁盘；删除时用 zeroize 清零。
use std::{borrow::Cow, collections::HashMap, sync::Mutex};
use tauri::{
    http::{header, Request, Response, StatusCode},
    ipc::InvokeBody,
    Manager, Runtime, State, UriSchemeContext,
};
use zeroize::Zeroize;

pub const SCHEME: &str = "vault";
const MAX_BYTES: usize = 60 * 1024 * 1024;
const MAX_RANGE: usize = 4 * 1024 * 1024; // 单次响应最多 4MB，播放器会继续按需请求
const ALLOWED_MIME: &[&str] = &["image/gif", "video/mp4", "video/quicktime", "video/webm", "video/x-m4v"];

struct Entry {
    data: Vec<u8>,
    mime: &'static str,
}

impl Drop for Entry {
    fn drop(&mut self) {
        self.data.zeroize();
    }
}

#[derive(Default)]
pub struct Vault(Mutex<HashMap<String, Entry>>);

impl Vault {
    pub fn clear(&self) {
        if let Ok(mut guard) = self.0.lock() {
            guard.clear();
        }
    }
}

#[tauri::command]
pub fn media_put(request: tauri::ipc::Request<'_>, vault: State<'_, Vault>) -> Result<String, String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("expected raw body".into());
    };
    if data.is_empty() || data.len() > MAX_BYTES {
        return Err("invalid size".into());
    }
    let mime = request
        .headers()
        .get("x-mime")
        .and_then(|v| v.to_str().ok())
        .and_then(|m| ALLOWED_MIME.iter().find(|a| **a == m).copied())
        .ok_or("unsupported type")?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    vault.0.lock().unwrap().insert(token.clone(), Entry { data: data.clone(), mime });
    Ok(token)
}

#[tauri::command]
pub fn media_drop(token: String, vault: State<'_, Vault>) {
    vault.0.lock().unwrap().remove(&token); // Drop 时清零
}

#[tauri::command]
pub fn media_clear(vault: State<'_, Vault>) {
    vault.0.lock().unwrap().clear();
}

fn parse_range(h: &str, len: usize) -> Option<(usize, usize)> {
    let spec = h.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let (start, end) = if a.is_empty() {
        let n: usize = b.parse().ok()?;
        (len.saturating_sub(n), len.checked_sub(1)?)
    } else {
        let start: usize = a.parse().ok()?;
        let end = if b.is_empty() { len.checked_sub(1)? } else { b.parse::<usize>().ok()?.min(len.checked_sub(1)?) };
        (start, end)
    };
    (start <= end && start < len).then_some((start, end))
}

pub fn protocol<R: Runtime>(ctx: UriSchemeContext<'_, R>, req: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let respond = |status: StatusCode| Response::builder().status(status).body(Cow::Borrowed(&[][..])).unwrap();
    let token = req.uri().path().trim_start_matches('/').to_string();
    let vault = ctx.app_handle().state::<Vault>();
    let map = vault.0.lock().unwrap();
    let Some(entry) = map.get(&token) else { return respond(StatusCode::NOT_FOUND) };
    let len = entry.data.len();

    let base = Response::builder()
        .header(header::CONTENT_TYPE, entry.mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store, no-cache, must-revalidate")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");

    match req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()) {
        Some(h) => match parse_range(h, len) {
            Some((start, end)) => {
                let end = end.min(start + MAX_RANGE - 1);
                base.status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                    .header(header::CONTENT_LENGTH, end - start + 1)
                    .body(Cow::Owned(entry.data[start..=end].to_vec()))
                    .unwrap()
            }
            None => Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .body(Cow::Borrowed(&[][..]))
                .unwrap(),
        },
        None => base.status(StatusCode::OK).header(header::CONTENT_LENGTH, len).body(Cow::Owned(entry.data.clone())).unwrap(),
    }
}
