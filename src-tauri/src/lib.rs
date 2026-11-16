mod discovery;
mod prefs;
mod secret;
mod vault;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, UserAttentionType, WindowEvent,
};

const TRAY_ID: &str = "main";

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 未读数：同时更新 Dock 角标和菜单栏（状态栏）数字。0 表示清除。
#[tauri::command]
fn set_unread(app: AppHandle, count: u32) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_badge_count(if count > 0 { Some(count as i64) } else { None });
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let title = if count > 0 { Some(count.to_string()) } else { None };
        let _ = tray.set_title(title);
    }
}

/// 戳一戳等动作：窗口不在前台时让 Dock 图标跳一下。
#[tauri::command]
fn request_attention(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if !w.is_focused().unwrap_or(false) {
            let _ = w.request_user_attention(Some(UserAttentionType::Informational));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(vault::Vault::default())
        .register_uri_scheme_protocol(vault::SCHEME, vault::protocol)
        .invoke_handler(tauri::generate_handler![
            set_unread,
            request_attention,
            discovery::discover_servers,
            discovery::scan_subnet,
            secret::secret_get,
            secret::secret_set,
            secret::secret_delete,
            secret::device_id,
            vault::media_put,
            vault::media_drop,
            vault::media_clear,
            prefs::prefs_load,
            prefs::prefs_save,
        ])
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Open Agent", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?;
            let menu = Menu::with_items(app, &[&show, &PredefinedMenuItem::separator(app)?, &quit])?;
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(tauri::include_image!("icons/tray.png"))
                .icon_as_template(true)
                .tooltip("Agent")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id().as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        // 点关闭按钮只隐藏窗口（macOS 原生习惯），连接保持，消息仍可通知
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            show_main(app);
        }
        let _ = (app, event);
    });
}
