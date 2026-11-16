//! 记住的会话口令：存在应用配置目录里（和 prefs.json 同一个目录），不用系统钥匙串，不会弹授权窗口。
//! 文件里是前端加密后的密文（密钥由本机硬件 ID 派生），拷到别的电脑上解不开。
//! 只有勾选「Remember on this Mac」时才会保存；取消勾选立即删除。
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

const MAX_LEN: usize = 4096;

fn path(app: &AppHandle) -> Option<PathBuf> {
    // 开发版用单独的文件，调试时不会覆盖正式版保存的口令
    let file = if cfg!(debug_assertions) { "session.dev.dat" } else { "session.dat" };
    app.path().app_config_dir().ok().map(|d| d.join(file))
}

#[tauri::command]
pub fn secret_get(app: AppHandle) -> Option<String> {
    let s = fs::read_to_string(path(&app)?).ok()?;
    let s = s.trim();
    (!s.is_empty() && s.len() <= MAX_LEN).then(|| s.to_string())
}

#[tauri::command]
pub fn secret_set(app: AppHandle, value: String) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_LEN {
        return Err("invalid".into());
    }
    let p = path(&app).ok_or("no config dir")?;
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("dat.tmp");
    fs::write(&tmp, value).map_err(|e| e.to_string())?;
    // 只有当前用户可读写
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(tmp, p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_delete(app: AppHandle) -> Result<(), String> {
    let p = path(&app).ok_or("no config dir")?;
    match fs::remove_file(p) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// 本机硬件 ID，用来派生本地加密密钥：macOS 用 IOPlatformUUID，Windows 用 MachineGuid。读不到时退回主机名。
#[tauri::command]
pub fn device_id() -> String {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| hardware_id().or_else(host_name).unwrap_or_else(|| "agent-workspace".into())).clone()
}

#[cfg(target_os = "macos")]
fn hardware_id() -> Option<String> {
    let out = Command::new("/usr/sbin/ioreg").args(["-rd1", "-c", "IOPlatformExpertDevice"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| l.contains("\"IOPlatformUUID\""))?;
    line.rsplit('"').nth(1).filter(|s| !s.is_empty()).map(str::to_string)
}

#[cfg(windows)]
fn hardware_id() -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000; // 不弹黑色控制台窗口
    let out = Command::new("reg")
        .args(["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| l.contains("MachineGuid"))?;
    line.split_whitespace().last().filter(|s| s.len() >= 32).map(str::to_string)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn hardware_id() -> Option<String> {
    std::fs::read_to_string("/etc/machine-id").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn host_name() -> Option<String> {
    if let Ok(n) = std::env::var("COMPUTERNAME") {
        return Some(n);
    }
    let out = Command::new("hostname").output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
}
