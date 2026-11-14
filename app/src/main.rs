//! character_viewer のアプリ本体。
//!
//! - 起動するとエンジン（マイク・描画ページの配信）を動かし、設定画面のウィンドウを開く
//! - ウィンドウを閉じてもタスクトレイに残り、OBS への表示は続く（終了はトレイのメニューから）
//! - 2 回起動したときは、すでに動いているほうのウィンドウを前に出す
//! - 起動に失敗したときは、原因と「PowerShell を開く」などのボタンがある画面を出す

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use cv_engine::service::{self, Service};
use cv_engine::settings::data_dir;
use cv_engine::{logging, maintenance};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// ───── 起動失敗時の画面から呼ぶ機能 ─────

#[tauri::command]
fn open_terminal() -> Result<(), String> {
    maintenance::open_terminal(&service::find_root())
}

#[tauri::command]
fn open_logs() -> Result<(), String> {
    maintenance::open_folder(&data_dir().join("logs"))
}

#[tauri::command]
fn rebuild() -> Result<(), String> {
    maintenance::launch_rebuild(&service::find_root())
}

#[tauri::command]
fn restart(app: AppHandle) {
    app.restart();
}

fn main() {
    let minimized = std::env::args().any(|a| a == "--minimized");
    logging::init(Some(data_dir().join("logs")), cfg!(debug_assertions));
    log::info!("アプリを起動します（v{}）", env!("CARGO_PKG_VERSION"));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .invoke_handler(tauri::generate_handler![
            open_terminal,
            open_logs,
            rebuild,
            restart
        ])
        .setup(move |app| {
            let quit_handle = app.handle().clone();
            let started = service::start(service::Options {
                root: None,
                app_exe: std::env::current_exe().ok(),
                quit: Some(Box::new(move || quit_handle.exit(0))),
                overrides: None,
            });

            // 設定画面が開けるか（描画ページのビルド結果に含まれる）
            let problem = match &started {
                Err(e) => Some(format!("{e:#}")),
                Ok(svc)
                    if !svc
                        .api
                        .renderer_dir
                        .join("settings")
                        .join("index.html")
                        .is_file() =>
                {
                    Some(format!(
                        "設定画面のファイルが見つかりません（{}）。「作り直す」を押してください",
                        svc.api.renderer_dir.join("settings").display()
                    ))
                }
                Ok(_) => None,
            };
            let url = match (&started, &problem) {
                (Ok(svc), None) => WebviewUrl::External(svc.settings_url().parse()?),
                _ => WebviewUrl::App("error.html".into()),
            };
            let mut window = WebviewWindowBuilder::new(app, "main", url)
                .title("character_viewer")
                .inner_size(1180.0, 800.0)
                .min_inner_size(760.0, 540.0)
                .visible(!minimized || problem.is_some());
            if let Some(p) = &problem {
                log::error!("起動に失敗しました: {p}");
                window = window.initialization_script(format!(
                    "window.__CV_ERROR = {};",
                    serde_json::to_string(p)?
                ));
            }
            let window = window.build()?;

            // 閉じてもトレイに残す（エンジンは動かし続ける）。起動に失敗しているときは普通に閉じる
            if started.is_ok() {
                let w = window.clone();
                window.on_window_event(move |ev| {
                    if let WindowEvent::CloseRequested { api, .. } = ev {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }

            let show = MenuItem::with_id(app, "show", "設定を開く", true, None::<&str>)?;
            let quit = MenuItem::with_id(
                app,
                "quit",
                "終了（OBS への表示も止まります）",
                true,
                None::<&str>,
            )?;
            let menu =
                Menu::with_items(app, &[&show, &PredefinedMenuItem::separator(app)?, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("character_viewer")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = e
                    {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            if let Ok(svc) = started {
                app.manage(svc);
            }
            Ok(())
        })
        .build(tauri::generate_context!());

    let app = match app {
        Ok(a) => a,
        Err(e) => {
            log::error!("アプリを起動できません: {e}");
            std::process::exit(1);
        }
    };
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(svc) = app.try_state::<Service>() {
                svc.runtime.shutdown();
            }
            log::info!("アプリを終了します");
        }
    });
}
