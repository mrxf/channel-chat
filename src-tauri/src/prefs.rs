//! 本地偏好（名称、服务器地址、主题、自定义动作等，不含任何消息内容）。
//! WebView 开了无痕模式，localStorage 不会持久化，所以偏好由这里落到配置目录。
use std::fs;
use tauri::{AppHandle, Manager};

const MAX_LEN: usize = 64 * 1024;

fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    // 开发版用单独的文件，调试时不会覆盖正式版的偏好
    let file = if cfg!(debug_assertions) { "prefs.dev.json" } else { "prefs.json" };
    app.path().app_config_dir().ok().map(|d| d.join(file))
}

#[tauri::command]
pub fn prefs_load(app: AppHandle) -> String {
    path(&app).and_then(|p| fs::read_to_string(p).ok()).unwrap_or_else(|| "{}".into())
}

#[tauri::command]
pub fn prefs_save(app: AppHandle, json: String) -> Result<(), String> {
    if json.len() > MAX_LEN {
        return Err("too large".into());
    }
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?;
    let p = path(&app).ok_or("no config dir")?;
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(tmp, p).map_err(|e| e.to_string())
}
