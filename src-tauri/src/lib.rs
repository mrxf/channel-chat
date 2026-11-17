mod discovery;
mod prefs;
mod relay;
mod secret;
mod updater;
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

/// 未读数：macOS 更新 Dock 角标和菜单栏数字；Windows 没有角标，写到托盘图标的悬停提示里。0 表示清除。
#[tauri::command]
fn set_unread(app: AppHandle, count: u32) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_badge_count(if count > 0 { Some(count as i64) } else { None });
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let title = if count > 0 { Some(count.to_string()) } else { None };
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(title);
        #[cfg(not(target_os = "macos"))]
        let _ = tray.set_tooltip(Some(title.map_or("ChatBuddy".into(), |n| format!("ChatBuddy ({n})"))));
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
        .manage(relay::RelayState::default())
        .manage(updater::UpdaterState::default())
        .register_uri_scheme_protocol(vault::SCHEME, vault::protocol)
        .invoke_handler(tauri::generate_handler![
            set_unread,
            request_attention,
            discovery::health_check,
            discovery::discover_servers,
            discovery::scan_subnet,
            relay::relay_start,
            relay::relay_stop,
            relay::relay_status,
            secret::secret_get,
            secret::secret_set,
            secret::secret_delete,
            secret::device_id,
            updater::update_check,
            updater::update_install,
            updater::update_cancel,
            updater::update_restart,
            updater::update_open_url,
            vault::media_put,
            vault::media_drop,
            vault::media_clear,
            prefs::prefs_load,
            prefs::prefs_save,
        ])
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "打开 ChatBuddy", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 ChatBuddy", true, Some("CmdOrCtrl+Q"))?;
            let menu = Menu::with_items(app, &[&show, &PredefinedMenuItem::separator(app)?, &quit])?;
            // macOS 菜单栏用单色模板图标（自动适配深浅色）；Windows 任务栏用彩色应用图标
            #[cfg(target_os = "macos")]
            let icon = tauri::include_image!("icons/tray.png");
            #[cfg(not(target_os = "macos"))]
            let icon = app.default_window_icon().cloned().unwrap_or_else(|| tauri::include_image!("icons/tray.png"));
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(icon)
                .icon_as_template(true)
                .tooltip("ChatBuddy")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id().as_ref() {
                    "show" => show_main(app),
                    "quit" => {
                        if let Some(r) = app.try_state::<relay::RelayState>() {
                            r.shutdown();
                        }
                        app.exit(0);
                    }
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
        // 点关闭按钮只隐藏窗口（macOS 原生习惯；Windows 上留在托盘），连接保持，消息仍可通知
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
        if let RunEvent::Exit = event {
            if let Some(r) = app.try_state::<relay::RelayState>() {
                r.shutdown();
            }
        }
        let _ = (app, event);
    });
}
