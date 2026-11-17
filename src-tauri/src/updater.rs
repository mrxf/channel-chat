use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{ipc::Channel, AppHandle, Manager, State};
use uuid::Uuid;

const REPO: &str = "mrxf/channel-chat";
const API_LATEST: &str = "https://api.github.com/repos/mrxf/channel-chat/releases/latest";
const RELEASE_URL_PREFIX: &str = "https://github.com/mrxf/channel-chat/";

#[derive(Default)]
pub struct UpdaterState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    release: Option<ResolvedRelease>,
    cancel: Option<Arc<AtomicBool>>,
    restart: Option<RestartPlan>,
}

#[derive(Clone)]
struct ResolvedRelease {
    version: String,
    release_url: String,
    notes: String,
    published_at: String,
    asset: Option<GhAsset>,
    can_auto: bool,
    sums_url: Option<String>,
}

#[allow(dead_code)]
enum RestartPlan {
    MacApp(PathBuf),
    WinPortable { exe: PathBuf, old_exe: PathBuf },
    WinNsis { setup_exe: PathBuf, app_exe: PathBuf, work_dir: PathBuf },
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    published_at: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Deserialize, Clone)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub release_url: String,
    pub notes: String,
    pub published_at: String,
    pub asset_name: Option<String>,
    pub asset_size: u64,
    pub can_auto_update: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub phase: &'static str, // "downloading" | "verifying" | "installing" | "ready"
    pub downloaded: u64,
    pub total: u64,
    pub percent: u8,
}

fn cmd_quiet(prog: &str) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(prog);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

#[allow(dead_code)]
fn parse_scutil_proxy(text: &str) -> Option<String> {
    let mut map = std::collections::HashMap::new();
    for line in text.lines() {
        if let Some((k, v)) = line.split_once(':') {
            map.insert(k.trim(), v.trim());
        }
    }
    if map.get("HTTPSEnable") == Some(&"1") {
        if let (Some(h), Some(p)) = (map.get("HTTPSProxy"), map.get("HTTPSPort")) {
            if !h.is_empty() && !p.is_empty() {
                return Some(format!("http://{h}:{p}"));
            }
        }
    }
    if map.get("HTTPEnable") == Some(&"1") {
        if let (Some(h), Some(p)) = (map.get("HTTPProxy"), map.get("HTTPPort")) {
            if !h.is_empty() && !p.is_empty() {
                return Some(format!("http://{h}:{p}"));
            }
        }
    }
    if map.get("SOCKSEnable") == Some(&"1") {
        if let (Some(h), Some(p)) = (map.get("SOCKSProxy"), map.get("SOCKSPort")) {
            if !h.is_empty() && !p.is_empty() {
                return Some(format!("socks5h://{h}:{p}"));
            }
        }
    }
    None
}

#[allow(dead_code)]
fn parse_win_reg_proxy(text: &str) -> Option<String> {
    let mut enabled = false;
    let mut server = "";
    for line in text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 && parts[0].eq_ignore_ascii_case("ProxyEnable") {
            enabled = parts[2] == "0x1" || parts[2] == "1";
        } else if parts.len() >= 3 && parts[0].eq_ignore_ascii_case("ProxyServer") {
            server = parts[2];
        }
    }
    if !enabled || server.is_empty() {
        return None;
    }
    if server.contains('=') {
        let mut https_p = None;
        let mut http_p = None;
        let mut socks_p = None;
        for seg in server.split(';') {
            if let Some((k, v)) = seg.split_once('=') {
                let v = v.trim();
                if v.is_empty() {
                    continue;
                }
                match k.trim().to_ascii_lowercase().as_str() {
                    "https" => https_p = Some(format!("http://{v}")),
                    "http" => http_p = Some(format!("http://{v}")),
                    "socks" | "socks5" => socks_p = Some(format!("socks5h://{v}")),
                    _ => {}
                }
            }
        }
        return https_p.or(http_p).or(socks_p);
    }
    if server.contains("://") {
        Some(server.to_string())
    } else {
        Some(format!("http://{server}"))
    }
}

/// 检测系统代理（GUI 应用从 Finder / 开始菜单启动时无终端代理环境变量，需读取系统代理配置以访问 GitHub）
fn detect_system_proxy() -> Option<String> {
    for key in ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(v) = std::env::var(key) {
            let t = v.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = Command::new("/usr/sbin/scutil").arg("--proxy").output() {
            if out.status.success() {
                if let Some(p) = parse_scutil_proxy(&String::from_utf8_lossy(&out.stdout)) {
                    return Some(p);
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = cmd_quiet("reg")
            .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"])
            .output()
        {
            if out.status.success() {
                if let Some(p) = parse_win_reg_proxy(&String::from_utf8_lossy(&out.stdout)) {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// 调用 curl 执行短请求：若检测到系统代理则优先走代理，代理不通时自动回退直连
fn curl_output(args: &[&str]) -> std::io::Result<std::process::Output> {
    if let Some(proxy) = detect_system_proxy() {
        let out = cmd_quiet("curl").args(["-x", &proxy]).args(args).output()?;
        if out.status.success() {
            return Ok(out);
        }
        return cmd_quiet("curl").args(["--noproxy", "*"]).args(args).output();
    }
    cmd_quiet("curl").args(args).output()
}

fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    let clean = s.trim().trim_start_matches(['v', 'V']);
    let core = clean.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn is_newer(current: &str, candidate: &str) -> bool {
    match (parse_semver(current), parse_semver(candidate)) {
        (Some(cur), Some(cand)) => cand > cur,
        _ => false,
    }
}

fn is_allowed_github_url(url: &str) -> bool {
    url.starts_with(RELEASE_URL_PREFIX)
        || url.starts_with(&format!("https://objects.githubusercontent.com/"))
}

#[cfg(target_os = "macos")]
fn find_macos_app_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    // 期望路径形如 .../ChatBuddy.app/Contents/MacOS/agent
    let macos_dir = exe.parent()?;
    let contents_dir = macos_dir.parent()?;
    let bundle_dir = contents_dir.parent()?;
    if macos_dir.file_name()? == "MacOS"
        && contents_dir.file_name()? == "Contents"
        && bundle_dir.extension().and_then(|e| e.to_str()) == Some("app")
    {
        Some(bundle_dir.to_path_buf())
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn windows_install_kind() -> Option<(PathBuf, bool)> {
    let exe = std::env::current_exe().ok()?;
    // 开发模式下（target\debug 或 target\release）不做原地覆盖
    let s = exe.to_string_lossy();
    if s.contains("\\src-tauri\\target\\") {
        return None;
    }
    let is_nsis = exe
        .parent()
        .map(|p| p.join("uninstall.exe").exists())
        .unwrap_or(false);
    Some((exe, is_nsis))
}

fn select_platform_asset(assets: &[GhAsset]) -> (Option<GhAsset>, bool) {
    let valid: Vec<&GhAsset> = assets
        .iter()
        .filter(|a| a.browser_download_url.starts_with(RELEASE_URL_PREFIX))
        .collect();

    #[cfg(target_os = "macos")]
    {
        let asset = valid
            .iter()
            .find(|a| a.name.ends_with("_macOS_universal.dmg"))
            .or_else(|| valid.iter().find(|a| a.name.ends_with(".dmg")))
            .map(|a| (*a).clone());
        let can_auto = asset.is_some() && find_macos_app_bundle().is_some();
        return (asset, can_auto);
    }

    #[cfg(target_os = "windows")]
    {
        let info = windows_install_kind();
        let prefer_nsis = info.as_ref().map(|(_, nsis)| *nsis).unwrap_or(true);
        let setup = valid.iter().find(|a| a.name.ends_with("-setup.exe"));
        let portable = valid.iter().find(|a| a.name.ends_with("portable.exe"));
        let asset = if prefer_nsis {
            setup.or(portable)
        } else {
            portable.or(setup)
        }
        .map(|a| (*a).clone());
        let can_auto = asset.is_some() && info.is_some();
        return (asset, can_auto);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = valid;
        (None, false)
    }
}

fn fetch_latest_release_blocking() -> Result<ResolvedRelease, String> {
    let out = curl_output(&[
        "-fsSL",
        "--max-time",
        "12",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "User-Agent: private-chat-updater",
        API_LATEST,
    ])
    .map_err(|e| format!("无法调用网络组件：{e}"))?;

    if !out.status.success() {
        return Err("连接 GitHub Releases 失败，请检查网络".into());
    }

    let rel: GhRelease = serde_json::from_slice(&out.stdout)
        .map_err(|_| "解析 GitHub 版本信息失败".to_string())?;

    if rel.draft || rel.prerelease {
        return Err("暂无正式发布版本".into());
    }
    let clean_ver = rel.tag_name.trim().trim_start_matches(['v', 'V']).to_string();
    if parse_semver(&clean_ver).is_none() {
        return Err(format!("远端版本号格式无效：{}", rel.tag_name));
    }

    let release_url = if rel.html_url.starts_with(RELEASE_URL_PREFIX) {
        rel.html_url
    } else {
        format!("https://github.com/{REPO}/releases/latest")
    };

    let sums_url = rel
        .assets
        .iter()
        .find(|a| a.name == "SHA256SUMS.txt" && a.browser_download_url.starts_with(RELEASE_URL_PREFIX))
        .map(|a| a.browser_download_url.clone());

    let (asset, can_auto) = select_platform_asset(&rel.assets);

    Ok(ResolvedRelease {
        version: clean_ver,
        release_url,
        notes: rel.body,
        published_at: rel.published_at,
        asset,
        can_auto,
        sums_url,
    })
}

/// 检查 GitHub 最新正式版 Release
#[tauri::command]
pub async fn update_check(state: State<'_, UpdaterState>) -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let resolved = tokio::task::spawn_blocking(fetch_latest_release_blocking)
        .await
        .map_err(|e| e.to_string())??;

    let has_update = is_newer(&current, &resolved.version);
    let info = UpdateInfo {
        current_version: current,
        latest_version: resolved.version.clone(),
        has_update,
        release_url: resolved.release_url.clone(),
        notes: resolved.notes.clone(),
        published_at: resolved.published_at.clone(),
        asset_name: resolved.asset.as_ref().map(|a| a.name.clone()),
        asset_size: resolved.asset.as_ref().map(|a| a.size).unwrap_or(0),
        can_auto_update: has_update && resolved.can_auto,
    };

    if let Ok(mut guard) = state.inner.lock() {
        guard.release = Some(resolved);
    }
    Ok(info)
}

/// 取消正在进行的下载
#[tauri::command]
pub fn update_cancel(state: State<'_, UpdaterState>) {
    if let Ok(guard) = state.inner.lock() {
        if let Some(flag) = &guard.cancel {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// 在系统默认浏览器中打开 GitHub Release 页面（严格校验域名与仓库前缀）
#[tauri::command]
pub fn update_open_url(url: String) -> Result<(), String> {
    let target = if url.is_empty() {
        format!("https://github.com/{REPO}/releases/latest")
    } else if url.starts_with(RELEASE_URL_PREFIX) {
        url
    } else {
        return Err("不允许打开非官方仓库链接".into());
    };

    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        cmd_quiet("rundll32")
            .args(["url.dll,FileProtocolHandler", &target])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 自动下载、校验 SHA-256 并安装到就绪状态；完成后前端调用 `update_restart` 即可秒级重启生效
#[tauri::command]
pub async fn update_install(
    state: State<'_, UpdaterState>,
    on_event: Channel<UpdateProgress>,
) -> Result<(), String> {
    let current = env!("CARGO_PKG_VERSION");
    let cached = state.inner.lock().ok().and_then(|g| g.release.clone());
    let resolved = match cached {
        Some(r) => r,
        None => tokio::task::spawn_blocking(fetch_latest_release_blocking)
            .await
            .map_err(|e| e.to_string())??,
    };

    if !is_newer(current, &resolved.version) {
        return Err("当前已是最新版本".into());
    }
    let asset = resolved
        .asset
        .clone()
        .ok_or_else(|| "未找到适配当前系统的安装包，请前往 GitHub 手动下载".to_string())?;
    if !is_allowed_github_url(&asset.browser_download_url) {
        return Err("安装包下载地址校验不通过".into());
    }

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut guard = state.inner.lock().map_err(|_| "状态锁异常".to_string())?;
        if let Some(prev) = &guard.cancel {
            prev.store(true, Ordering::Relaxed);
        }
        guard.cancel = Some(cancel.clone());
        guard.restart = None;
    }

    let work_dir = std::env::temp_dir().join(format!("agent-upd-{}", Uuid::new_v4()));
    create_private_dir(&work_dir).map_err(|e| format!("创建临时目录失败：{e}"))?;

    let res = run_download_and_stage(&resolved, &asset, &work_dir, &cancel, &on_event).await;

    if let Ok(mut guard) = state.inner.lock() {
        guard.cancel = None;
        match res {
            Ok((plan, keep_work_dir)) => {
                if !keep_work_dir {
                    let _ = fs::remove_dir_all(&work_dir);
                }
                guard.restart = Some(plan);
                let _ = on_event.send(UpdateProgress {
                    phase: "ready",
                    downloaded: asset.size,
                    total: asset.size,
                    percent: 100,
                });
                Ok(())
            }
            Err(err) => {
                let _ = fs::remove_dir_all(&work_dir);
                Err(err)
            }
        }
    } else {
        let _ = fs::remove_dir_all(&work_dir);
        Err("状态锁异常".into())
    }
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

async fn run_download_and_stage(
    resolved: &ResolvedRelease,
    asset: &GhAsset,
    work_dir: &Path,
    cancel: &Arc<AtomicBool>,
    on_event: &Channel<UpdateProgress>,
) -> Result<(RestartPlan, bool), String> {
    let _ = on_event.send(UpdateProgress {
        phase: "downloading",
        downloaded: 0,
        total: asset.size,
        percent: 0,
    });

    // 1. 拉取 SHA256SUMS.txt（若存在则强制校验）
    let expected_sha = if let Some(sums_url) = resolved.sums_url.clone() {
        let name = asset.name.clone();
        tokio::task::spawn_blocking(move || fetch_expected_sha256(&sums_url, &name))
            .await
            .map_err(|e| e.to_string())??
    } else {
        None
    };

    if cancel.load(Ordering::Relaxed) {
        return Err("已取消更新".into());
    }

    // 2. 流式下载安装包到临时文件，实时轮询文件大小汇报进度（优先系统代理，代理不可达时自动回退直连）
    let pkg_path = work_dir.join(&asset.name);
    let sys_proxy = tokio::task::spawn_blocking(detect_system_proxy).await.ok().flatten();
    let proxy_modes: Vec<Option<String>> = match sys_proxy {
        Some(p) => vec![Some(p), None],
        None => vec![None],
    };
    let total_attempts = proxy_modes.len();

    for (attempt, mode) in proxy_modes.into_iter().enumerate() {
        let _ = fs::remove_file(&pkg_path);
        let mut cmd = cmd_quiet("curl");
        if let Some(ref p) = mode {
            cmd.args(["-x", p]);
        } else if total_attempts > 1 {
            cmd.args(["--noproxy", "*"]);
        }
        let mut child = cmd
            .args([
                "-fSL",
                "--connect-timeout",
                "15",
                "--retry",
                "2",
                "-H",
                "User-Agent: private-chat-updater",
                "-o",
            ])
            .arg(&pkg_path)
            .arg(&asset.browser_download_url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动下载失败：{e}"))?;

        let mut ok_done = false;
        let mut last_err = String::new();
        loop {
            if cancel.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                return Err("已取消更新".into());
            }
            let downloaded = fs::metadata(&pkg_path).map(|m| m.len()).unwrap_or(0);
            let pct = if asset.size > 0 {
                ((downloaded.saturating_mul(100)) / asset.size).min(99) as u8
            } else {
                0
            };
            let _ = on_event.send(UpdateProgress {
                phase: "downloading",
                downloaded,
                total: asset.size,
                percent: pct,
            });

            match child.try_wait().map_err(|e| e.to_string())? {
                Some(status) => {
                    if status.success() {
                        ok_done = true;
                    } else {
                        let mut err_msg = String::new();
                        if let Some(mut se) = child.stderr.take() {
                            let _ = se.read_to_string(&mut err_msg);
                        }
                        let detail = err_msg.lines().last().unwrap_or("").trim();
                        last_err = if detail.is_empty() {
                            "下载安装包失败，请检查网络连接".into()
                        } else {
                            format!("下载失败：{detail}")
                        };
                    }
                    break;
                }
                None => tokio::time::sleep(Duration::from_millis(120)).await,
            }
        }
        if ok_done {
            break;
        }
        if attempt + 1 >= total_attempts {
            return Err(last_err);
        }
    }

    let final_size = fs::metadata(&pkg_path).map(|m| m.len()).unwrap_or(asset.size);
    let _ = on_event.send(UpdateProgress {
        phase: "verifying",
        downloaded: final_size,
        total: final_size,
        percent: 100,
    });

    // 3. 校验 SHA-256 并安装
    let pkg_clone = pkg_path.clone();
    let work_clone = work_dir.to_path_buf();
    let on_ev = on_event.clone();
    let asset_name = asset.name.clone();

    tokio::task::spawn_blocking(move || {
        if let Some(expected) = expected_sha {
            let actual = sha256_file(&pkg_clone).map_err(|e| format!("读取安装包校验失败：{e}"))?;
            if !actual.eq_ignore_ascii_case(&expected) {
                return Err("安装包 SHA-256 校验不一致，已安全中止".into());
            }
        }
        let _ = on_ev.send(UpdateProgress {
            phase: "installing",
            downloaded: final_size,
            total: final_size,
            percent: 100,
        });
        stage_platform_install(&pkg_clone, &asset_name, &work_clone)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn fetch_expected_sha256(sums_url: &str, asset_name: &str) -> Result<Option<String>, String> {
    let out = curl_output(&[
        "-fsSL",
        "--max-time",
        "15",
        "-H",
        "User-Agent: private-chat-updater",
        sums_url,
    ])
    .map_err(|e| format!("拉取校验文件失败：{e}"))?;
    if !out.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        if let (Some(hash), Some(file)) = (parts.next(), parts.next()) {
            let clean_file = file.trim_start_matches('*');
            if clean_file == asset_name && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
                return Ok(Some(hash.to_ascii_lowercase()));
            }
        }
    }
    Ok(None)
}

#[cfg(target_os = "macos")]
fn stage_platform_install(
    dmg_path: &Path,
    _asset_name: &str,
    work_dir: &Path,
) -> Result<(RestartPlan, bool), String> {
    let app_bundle = find_macos_app_bundle()
        .ok_or_else(|| "当前为开发模式运行，请打包成 ChatBuddy.app 后使用自动更新".to_string())?;
    let parent_dir = app_bundle
        .parent()
        .ok_or_else(|| "无法定位应用所在目录".to_string())?;

    let mnt_dir = work_dir.join("mnt");
    fs::create_dir_all(&mnt_dir).map_err(|e| e.to_string())?;

    let attach = Command::new("/usr/bin/hdiutil")
        .args(["attach", "-nobrowse", "-readonly", "-mountpoint"])
        .arg(&mnt_dir)
        .arg(dmg_path)
        .output()
        .map_err(|e| format!("挂载 DMG 失败：{e}"))?;
    if !attach.status.success() {
        return Err("挂载安装包 DMG 失败".into());
    }

    struct DetachGuard(PathBuf);
    impl Drop for DetachGuard {
        fn drop(&mut self) {
            let status = Command::new("/usr/bin/hdiutil")
                .args(["detach", "-quiet"])
                .arg(&self.0)
                .status();
            if !matches!(status, Ok(s) if s.success()) {
                let _ = Command::new("/usr/bin/hdiutil")
                    .args(["detach", "-force", "-quiet"])
                    .arg(&self.0)
                    .status();
            }
        }
    }
    let guard = DetachGuard(mnt_dir.clone());

    let mounted_app = fs::read_dir(&mnt_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| p.extension().and_then(|x| x.to_str()) == Some("app"))
        .ok_or_else(|| "DMG 中未找到 .app 应用包".to_string())?;

    let extracted_app = work_dir.join("ChatBuddy.new.app");
    let ditto = Command::new("/usr/bin/ditto")
        .arg(&mounted_app)
        .arg(&extracted_app)
        .status()
        .map_err(|e| format!("解压应用失败：{e}"))?;
    if !ditto.success() {
        return Err("复制新版本应用包失败".into());
    }

    // 清除隔离属性，避免未签名包更新后被 Gatekeeper 拦截
    let _ = Command::new("/usr/bin/xattr")
        .args(["-cr"])
        .arg(&extracted_app)
        .status();

    drop(guard);
    let _ = fs::remove_file(dmg_path);

    // 优先在应用同目录做同分区原子替换；若无写权限则通过系统授权完成替换
    let staging_same_fs = parent_dir.join(format!(".ChatBuddy.upd-{}.app", std::process::id()));
    let copy_same_fs = Command::new("/usr/bin/ditto")
        .arg(&extracted_app)
        .arg(&staging_same_fs)
        .status();

    if matches!(copy_same_fs, Ok(s) if s.success()) {
        let _ = Command::new("/usr/bin/xattr")
            .args(["-cr"])
            .arg(&staging_same_fs)
            .status();
        let backup = parent_dir.join(format!(".ChatBuddy.bak-{}.app", std::process::id()));
        let _ = fs::remove_dir_all(&backup);
        if let Err(e) = fs::rename(&app_bundle, &backup) {
            let _ = fs::remove_dir_all(&staging_same_fs);
            return Err(format!("替换旧版本失败：{e}"));
        }
        if let Err(e) = fs::rename(&staging_same_fs, &app_bundle) {
            let _ = fs::rename(&backup, &app_bundle);
            let _ = fs::remove_dir_all(&staging_same_fs);
            return Err(format!("写入新版本失败：{e}"));
        }
        let _ = fs::remove_dir_all(&backup);
        return Ok((RestartPlan::MacApp(app_bundle), false));
    }

    let _ = fs::remove_dir_all(&staging_same_fs);
    // 需要管理员权限写入（例如非管理员账户下的 /Applications）
    let escape_sh = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\'', "'\\''"));
    let sh_cmd = format!(
        "rm -rf {dst} && /usr/bin/ditto {src} {dst} && /usr/bin/xattr -cr {dst}",
        src = escape_sh(&extracted_app),
        dst = escape_sh(&app_bundle),
    );
    let osa_script = format!(
        "do shell script \"{}\" with administrator privileges",
        sh_cmd.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let osa = Command::new("/usr/bin/osascript")
        .args(["-e", &osa_script])
        .status()
        .map_err(|e| format!("请求系统授权失败：{e}"))?;
    if !osa.success() {
        return Err("未授予安装权限，更新已取消".into());
    }
    Ok((RestartPlan::MacApp(app_bundle), false))
}

#[cfg(target_os = "windows")]
fn stage_platform_install(
    pkg_path: &Path,
    asset_name: &str,
    work_dir: &Path,
) -> Result<(RestartPlan, bool), String> {
    let (current_exe, _) = windows_install_kind()
        .ok_or_else(|| "当前为开发模式运行，请使用打包后的程序进行自动更新".to_string())?;

    if asset_name.ends_with("-setup.exe") {
        // NSIS 安装版：保留安装包在临时目录，点击重启时静默执行 /S 安装并拉起新进程
        return Ok((
            RestartPlan::WinNsis {
                setup_exe: pkg_path.to_path_buf(),
                app_exe: current_exe,
                work_dir: work_dir.to_path_buf(),
            },
            true,
        ));
    }

    // Portable 免安装版：Windows 允许重命名正在运行的 exe，直接原地原子替换
    let old_exe = current_exe.with_extension("exe.old");
    let new_exe = current_exe.with_extension("exe.new");
    let _ = fs::remove_file(&old_exe);
    let _ = fs::remove_file(&new_exe);
    fs::copy(pkg_path, &new_exe).map_err(|e| format!("写入新版本失败：{e}"))?;
    fs::rename(&current_exe, &old_exe).map_err(|e| format!("重命名旧程序失败：{e}"))?;
    if let Err(e) = fs::rename(&new_exe, &current_exe) {
        let _ = fs::rename(&old_exe, &current_exe);
        let _ = fs::remove_file(&new_exe);
        return Err(format!("替换新程序失败：{e}"));
    }
    Ok((
        RestartPlan::WinPortable {
            exe: current_exe,
            old_exe,
        },
        false,
    ))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn stage_platform_install(
    _pkg_path: &Path,
    _asset_name: &str,
    _work_dir: &Path,
) -> Result<(RestartPlan, bool), String> {
    Err("当前平台暂不支持自动替换安装，请前往 GitHub 下载更新".into())
}

/// 退出当前进程并自动拉起更新后的新版本
#[tauri::command]
pub fn update_restart(app: AppHandle, state: State<'_, UpdaterState>) -> Result<(), String> {
    let plan = state
        .inner
        .lock()
        .map_err(|_| "状态锁异常".to_string())?
        .restart
        .take()
        .ok_or_else(|| "更新尚未准备就绪".to_string())?;

    if let Some(vault) = app.try_state::<crate::vault::Vault>() {
        vault.clear();
    }
    if let Some(relay) = app.try_state::<crate::relay::RelayState>() {
        relay.shutdown();
    }

    match plan {
        RestartPlan::MacApp(bundle) => {
            Command::new("/bin/sh")
                .args(["-c", "sleep 0.5; /usr/bin/open -n \"$1\"", "--"])
                .arg(&bundle)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("启动新版本失败：{e}"))?;
        }
        RestartPlan::WinPortable { exe, old_exe } => {
            let script = format!(
                "timeout /t 1 /nobreak >nul & del /f /q \"{}\" >nul 2>&1 & start \"\" \"{}\"",
                old_exe.display(),
                exe.display()
            );
            cmd_quiet("cmd")
                .args(["/C", &script])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("启动新版本失败：{e}"))?;
        }
        RestartPlan::WinNsis {
            setup_exe,
            app_exe,
            work_dir,
        } => {
            let script = format!(
                "timeout /t 1 /nobreak >nul & start \"\" /wait \"{}\" /S & start \"\" \"{}\" & rmdir /s /q \"{}\" >nul 2>&1",
                setup_exe.display(),
                app_exe.display(),
                work_dir.display()
            );
            cmd_quiet("cmd")
                .args(["/C", &script])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("执行更新安装器失败：{e}"))?;
        }
    }

    app.exit(0);
    Ok(())
}

/* ---------------- 纯 Rust FIPS 180-4 SHA-256（零额外依赖） ---------------- */
const K256: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

struct Sha256 {
    state: [u32; 8],
    buf: [u8; 64],
    buf_len: usize,
    total_len: u64,
}

impl Sha256 {
    fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
            ],
            buf: [0u8; 64],
            buf_len: 0,
            total_len: 0,
        }
    }

    fn compress(state: &mut [u32; 8], block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h.wrapping_add(s1).wrapping_add(ch).wrapping_add(K256[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        for (s, v) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *s = s.wrapping_add(v);
        }
    }

    fn update(&mut self, mut data: &[u8]) {
        self.total_len = self.total_len.wrapping_add(data.len() as u64);
        if self.buf_len > 0 && self.buf_len + data.len() >= 64 {
            let take = 64 - self.buf_len;
            self.buf[self.buf_len..64].copy_from_slice(&data[..take]);
            Self::compress(&mut self.state, &self.buf);
            self.buf_len = 0;
            data = &data[take..];
        }
        while data.len() >= 64 {
            let block: &[u8; 64] = data[..64].try_into().unwrap();
            Self::compress(&mut self.state, block);
            data = &data[64..];
        }
        if !data.is_empty() {
            self.buf[self.buf_len..self.buf_len + data.len()].copy_from_slice(data);
            self.buf_len += data.len();
        }
    }

    fn finalize_hex(mut self) -> String {
        let bit_len = self.total_len.wrapping_mul(8);
        self.buf[self.buf_len] = 0x80;
        self.buf_len += 1;
        if self.buf_len > 56 {
            self.buf[self.buf_len..64].fill(0);
            Self::compress(&mut self.state, &self.buf);
            self.buf_len = 0;
        }
        self.buf[self.buf_len..56].fill(0);
        self.buf[56..64].copy_from_slice(&bit_len.to_be_bytes());
        Self::compress(&mut self.state, &self.buf);

        let mut out = String::with_capacity(64);
        for word in self.state {
            use std::fmt::Write;
            let _ = write!(&mut out, "{word:08x}");
        }
        out
    }
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize_hex())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha256_vectors() {
        let mut h = Sha256::new();
        h.update(b"");
        assert_eq!(
            h.finalize_hex(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );

        let mut h2 = Sha256::new();
        h2.update(b"abc");
        assert_eq!(
            h2.finalize_hex(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );

        let mut h3 = Sha256::new();
        h3.update(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq");
        assert_eq!(
            h3.finalize_hex(),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn test_semver_compare() {
        assert!(is_newer("1.1.6", "v1.1.7"));
        assert!(is_newer("1.1.6", "1.2.0"));
        assert!(is_newer("1.1.6", "2.0.0"));
        assert!(!is_newer("1.1.6", "1.1.6"));
        assert!(!is_newer("1.2.0", "1.1.9"));
    }
}
