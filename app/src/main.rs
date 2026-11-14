//! character_viewer のアプリ本体。
//!
//! - 起動するとエンジン（マイク・描画ページの配信）を動かし、設定画面のウィンドウを開く
//! - ウィンドウを閉じてもタスクトレイに残り、OBS への表示は続く（終了はトレイのメニューから）
//! - 2 回起動したときは、すでに動いているほうのウィンドウを前に出す
//! - 起動に失敗したときは、原因と「PowerShell を開く」などのボタンがある画面を出す
//! - カメラの読み取り（顔の向き・表情）用に、見えないウィンドウをもう 1 つ持つ。
//!   設定画面を閉じていても読み取りを続けるため。設定画面の「カメラの映像を表示」で見えるようにできる
//! - 表情を切り替えるキー（設定画面の「カメラ」で割り当てる）を、ほかのアプリを使っている間も受け取る

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{BTreeMap, HashMap};
use std::str::FromStr;
use std::sync::Mutex;
use std::time::Duration;

use cv_engine::service::{self, Service};
use cv_engine::settings::data_dir;
use cv_engine::{logging, maintenance};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// 登録してあるキー（キーの番号 → 表情の名前）
#[derive(Default)]
struct Hotkeys(Mutex<HashMap<u32, String>>);

/// 設定のとおりにキーを登録し直す。使えないキー（ほかのアプリが使っている等）は、ログに残して飛ばす
fn apply_hotkeys(app: &AppHandle, want: &BTreeMap<String, String>) {
    let shortcuts = app.global_shortcut();
    if let Err(e) = shortcuts.unregister_all() {
        log::warn!("キーの登録を外せません: {e}");
    }
    let mut map = HashMap::new();
    for (name, keys) in want {
        match Shortcut::from_str(keys) {
            Ok(sc) => match shortcuts.register(sc) {
                Ok(()) => {
                    map.insert(sc.id(), name.clone());
                }
                Err(e) => log::warn!("キー {keys}（表情 {name}）を登録できません: {e}"),
            },
            Err(e) => log::warn!("キー {keys}（表情 {name}）の書き方が正しくありません: {e}"),
        }
    }
    log::info!("表情を切り替えるキーを {} 個登録しました", map.len());
    if let Some(state) = app.try_state::<Hotkeys>() {
        *state.0.lock().unwrap_or_else(|e| e.into_inner()) = map;
    }
}

/// キーが押された: その表情にする。もう一度押すと解除する
fn on_hotkey(app: &AppHandle, shortcut: &Shortcut) {
    let (Some(keys), Some(svc)) = (app.try_state::<Hotkeys>(), app.try_state::<Service>()) else {
        return;
    };
    let name = keys
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&shortcut.id())
        .cloned();
    if let Some(name) = name {
        let hub = &svc.runtime.hub;
        let next = (hub.expression().as_deref() != Some(name.as_str())).then_some(name);
        hub.publish_expression(next);
    }
}

/// 設定が変わったら、キーを登録し直す（設定画面で割り当てを変えるとすぐ反映される）
fn watch_hotkeys(app: AppHandle) {
    std::thread::spawn(move || {
        let mut applied: Option<BTreeMap<String, String>> = None;
        loop {
            if let Some(svc) = app.try_state::<Service>() {
                let want = svc
                    .api
                    .settings
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .hotkeys
                    .clone();
                // 起動時にキーの割り当てがなければ、何もしない
                if applied.as_ref() != Some(&want) && !(applied.is_none() && want.is_empty()) {
                    apply_hotkeys(&app, &want);
                }
                applied = Some(want);
            }
            std::thread::sleep(Duration::from_millis(700));
        }
    });
}

/// WebView2 の起動オプション。同じアプリのウィンドウは全部同じ値にする必要がある。
/// 1 つ目は Tauri の既定値。残りは、カメラのウィンドウが隠れていても読み取りを止めないため
/// （隠れたページはタイマーが 1 秒に 1 回まで絞られ、表情が追いつかなくなる）
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
    --disable-background-timer-throttling --disable-renderer-backgrounding \
    --disable-backgrounding-occluded-windows";

const TRACKER_WINDOW: &str = "tracker";

/// カメラの映像のウィンドウを表示する / 隠す
fn show_tracker(app: &AppHandle, show: bool) {
    if let Some(w) = app.get_webview_window(TRACKER_WINDOW) {
        if show {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        } else {
            let _ = w.hide();
        }
    }
}

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
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        on_hotkey(app, shortcut);
                    }
                })
                .build(),
        )
        .manage(Hotkeys::default())
        .invoke_handler(tauri::generate_handler![
            open_terminal,
            open_logs,
            rebuild,
            restart
        ])
        .setup(move |app| {
            let quit_handle = app.handle().clone();
            let camera_handle = app.handle().clone();
            let started = service::start(service::Options {
                camera_window: Some(Box::new(move |show| show_tracker(&camera_handle, show))),
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
                .additional_browser_args(BROWSER_ARGS)
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

            // カメラの読み取り用のウィンドウ（見えないまま動かす。カメラを使わない設定なら、ページは何もしない）
            if let (Ok(svc), None) = (&started, &problem) {
                if svc
                    .api
                    .renderer_dir
                    .join("tracker")
                    .join("index.html")
                    .is_file()
                {
                    let tracker = WebviewWindowBuilder::new(
                        app,
                        TRACKER_WINDOW,
                        WebviewUrl::External(svc.tracker_url().parse()?),
                    )
                    .title("character_viewer カメラ")
                    .inner_size(560.0, 560.0)
                    .min_inner_size(360.0, 360.0)
                    .additional_browser_args(BROWSER_ARGS)
                    .visible(false)
                    .build()?;
                    let w = tracker.clone();
                    tracker.on_window_event(move |ev| {
                        if let WindowEvent::CloseRequested { api, .. } = ev {
                            api.prevent_close();
                            let _ = w.hide();
                        }
                    });
                }
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
                watch_hotkeys(app.handle().clone());
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
