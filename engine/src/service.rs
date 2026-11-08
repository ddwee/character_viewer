//! エンジン全体（設定の読み込み → マイク・状態遷移 → 描画ページ・設定画面の配信）を起動する。
//! アプリ（cv-app）とコマンド版（cv-engine）の両方から使う。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::Result;

use crate::api::{self, ApiState};
use crate::jobs::Jobs;
use crate::runtime::{self, RuntimeHandle};
use crate::server::{self, Hub};
use crate::settings::{Settings, settings_path};

pub struct Options {
    /// プロジェクトのフォルダ（None なら自動で探す）
    pub root: Option<PathBuf>,
    /// アプリとして動かすときの実行ファイル（自動起動の登録に使う）
    pub app_exe: Option<PathBuf>,
    /// アプリを終了させる処理
    pub quit: Option<Box<dyn Fn() + Send + Sync>>,
    /// 起動時だけ設定を上書きする（コマンド版のオプション。保存はしない）
    pub overrides: Option<Box<dyn FnOnce(&mut Settings)>>,
}

pub struct Service {
    pub runtime: RuntimeHandle,
    pub api: Arc<ApiState>,
    pub port: u16,
}

impl Service {
    pub fn settings_url(&self) -> String {
        format!("http://127.0.0.1:{}/settings/", self.port)
    }
    pub fn obs_url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.port)
    }
}

/// tools\update.ps1 があるフォルダを、実行ファイルとカレントディレクトリからさかのぼって探す
pub fn find_root() -> PathBuf {
    let bases = [
        std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(Path::to_path_buf)),
        std::env::current_dir().ok(),
    ];
    bases
        .iter()
        .flatten()
        .flat_map(|b| b.ancestors())
        .find(|d| d.join("tools").join("update.ps1").is_file())
        .map(Path::to_path_buf)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 描画ページ: インストール先（実行ファイルの隣の renderer）→ 開発中のビルド結果（renderer/dist）
pub fn renderer_dir(root: &Path) -> PathBuf {
    let installed = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join("renderer")));
    match installed {
        Some(d) if d.join("index.html").is_file() => d,
        _ => root.join("renderer").join("dist"),
    }
}

pub fn start(opts: Options) -> Result<Service> {
    let root = opts.root.unwrap_or_else(find_root);
    let path = settings_path();
    let (mut settings, notice) = Settings::load(&path);
    let mut notices = vec![];
    if let Some(n) = notice {
        log::warn!("{n}");
        notices.push(n);
    }
    if let Some(f) = opts.overrides {
        f(&mut settings);
    }
    let port = settings.server.port;
    let renderer = renderer_dir(&root);
    let default_avatar_dir = root.join("avatar");
    if !renderer.join("index.html").is_file() {
        let n = format!(
            "描画ページが見つかりません（{}）。メンテナンスの「作り直す」を実行してください",
            renderer.display()
        );
        log::warn!("{n}");
        notices.push(n);
    }

    let listener = server::bind(port)?;
    let avatar_dir = settings
        .avatar
        .dir
        .clone()
        .unwrap_or_else(|| default_avatar_dir.clone());
    let (hub, events) = Hub::new(settings.display, avatar_dir);
    let runtime = runtime::start(
        settings.clone(),
        hub.clone(),
        events,
        default_avatar_dir.clone(),
    );

    let api = Arc::new(ApiState {
        rt: runtime.clone(),
        settings: Mutex::new(settings),
        settings_path: path,
        root: root.clone(),
        default_avatar_dir,
        renderer_dir: renderer.clone(),
        port,
        notices: Mutex::new(notices),
        app_exe: opts.app_exe,
        quit: opts.quit,
        jobs: Arc::new(Jobs::default()),
    });
    let app = server::routes(hub, renderer).merge(api::routes(api.clone()));
    server::spawn(listener, app)?;
    log::info!(
        "起動しました（v{}）。設定画面: http://127.0.0.1:{port}/settings/  OBS 用: http://127.0.0.1:{port}/",
        env!("CARGO_PKG_VERSION")
    );
    Ok(Service { runtime, api, port })
}
