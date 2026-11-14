//! 設定画面用の API（`/api/…`、JSON）。
//!
//! 安全のため（ブラウザで開いた別のサイトから勝手に操作されないように）:
//! - Host ヘッダーが 127.0.0.1 / localhost のときだけ受け付ける（DNS リバインディング対策）
//! - Origin ヘッダーがあれば、このサーバー自身のときだけ受け付ける
//! - GET 以外は `X-CV: 1` ヘッダーを必須にする（別のサイトからは CORS の事前確認で止まる）

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path as UrlPath, Query, Request, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use serde::Deserialize;
use serde_json::json;

use crate::avatar_files;
use crate::jobs::Jobs;
use crate::maintenance::{self, UpdateOptions};
use crate::recording;
use crate::runtime::RuntimeHandle;
use crate::settings::Settings;
use crate::snapshot;

pub struct ApiState {
    pub rt: RuntimeHandle,
    pub settings: Mutex<Settings>,
    pub settings_path: PathBuf,
    /// プロジェクトのフォルダ（tools・renderer・avatar がある場所）
    pub root: PathBuf,
    pub default_avatar_dir: PathBuf,
    pub renderer_dir: PathBuf,
    pub port: u16,
    /// 起動時に利用者へ伝えること（設定ファイルが壊れていた等）
    pub notices: Mutex<Vec<String>>,
    /// 自動起動に登録する実行ファイル（アプリとして動いているときだけ）
    pub app_exe: Option<PathBuf>,
    /// アプリを終了させる（アプリとして動いているときだけ）
    pub quit: Option<Box<dyn Fn() + Send + Sync>>,
    /// カメラの映像のウィンドウを表示する / 隠す（アプリとして動いているときだけ）
    pub camera_window: Option<Box<dyn Fn(bool) + Send + Sync>>,
    pub jobs: Arc<Jobs>,
}

type S = State<Arc<ApiState>>;

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

fn bad(msg: impl Into<String>) -> Response {
    err(StatusCode::BAD_REQUEST, msg)
}

fn ok() -> Response {
    Json(json!({ "ok": true })).into_response()
}

pub fn routes(state: Arc<ApiState>) -> Router {
    let port = state.port;
    Router::new()
        .route("/api/info", get(info))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/settings/reset", post(reset_settings))
        .route("/api/status", get(status))
        .route("/api/devices", get(devices))
        .route("/api/calibration/start", post(cal_start))
        .route("/api/calibration/cancel", post(cal_cancel))
        .route("/api/avatar", get(avatar_view))
        .route("/api/avatar/reload", post(avatar_reload))
        .route("/api/avatar/rig", get(rig_get).put(rig_put))
        .route(
            "/api/avatar/{state}/{slot}",
            put(avatar_put).layer(DefaultBodyLimit::max(avatar_files::MAX_BYTES + 1024)),
        )
        .route("/api/avatar/{state}/{slot}", delete(avatar_delete))
        .route(
            "/api/snapshot",
            put(snapshot_put).layer(DefaultBodyLimit::max(snapshot::MAX_BYTES + 1024)),
        )
        .route("/api/recordings", get(recordings))
        .route("/api/measure", post(measure))
        .route("/api/jobs/{id}", get(job))
        .route("/api/logs", get(logs))
        .route("/api/maintenance/versions", post(versions))
        .route("/api/maintenance/check", post(check_updates))
        .route("/api/maintenance/update", post(update))
        .route("/api/maintenance/rebuild", post(rebuild))
        .route("/api/maintenance/rollback", post(rollback))
        .route("/api/maintenance/terminal", post(terminal))
        .route("/api/maintenance/ffmpeg", post(install_ffmpeg))
        .route("/api/maintenance/open", post(open_folder))
        .route(
            "/api/maintenance/autostart",
            get(get_autostart).put(put_autostart),
        )
        .route("/api/app/quit", post(quit))
        .route("/api/expression", get(get_expression).post(set_expression))
        .route("/api/camera/window", post(camera_window))
        .layer(middleware::from_fn(move |req, next| guard(port, req, next)))
        .with_state(state)
}

async fn guard(port: u16, req: Request, next: Next) -> Response {
    let headers = req.headers();
    let host_ok = headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"));
    let origin_ok = headers
        .get("origin")
        .and_then(|h| h.to_str().ok())
        .is_none_or(|o| {
            o == format!("http://127.0.0.1:{port}") || o == format!("http://localhost:{port}")
        });
    let header_ok = req.method() == Method::GET || headers.get("x-cv").is_some_and(|v| v == "1");
    if !(host_ok && origin_ok && header_ok) {
        return err(StatusCode::FORBIDDEN, "このページからは操作できません");
    }
    next.run(req).await
}

fn avatar_dir(st: &ApiState) -> PathBuf {
    st.rt.hub.avatar_dir()
}

async fn info(State(st): S) -> Response {
    let settings_url = format!("http://127.0.0.1:{}/settings/", st.port);
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "port": st.port,
        "root": st.root,
        "settingsPath": st.settings_path,
        "logDir": crate::logging::log_dir(),
        "logFile": crate::logging::today_file(),
        "avatarDir": avatar_dir(&st),
        "defaultAvatarDir": st.default_avatar_dir,
        "rendererBuilt": st.renderer_dir.join("index.html").is_file(),
        "ffmpeg": recording::ffmpeg_available(),
        "notices": *st.notices.lock().unwrap_or_else(|e| e.into_inner()),
        "obsUrl": format!("http://127.0.0.1:{}/", st.port),
        "settingsUrl": settings_url,
        "isApp": st.app_exe.is_some(),
    }))
    .into_response()
}

async fn get_settings(State(st): S) -> Response {
    Json(
        st.settings
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
    )
    .into_response()
}

fn store(st: &ApiState, new: Settings) -> Response {
    if let Err(e) = new.validate() {
        return bad(e);
    }
    let mut cur = st.settings.lock().unwrap_or_else(|e| e.into_inner());
    if let Err(e) = new.save(&st.settings_path) {
        return err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("設定を保存できません: {e}"),
        );
    }
    let restart = new.server.port != st.port;
    *cur = new.clone();
    st.rt.apply(new.clone());
    Json(json!({ "settings": new, "restartRequired": restart })).into_response()
}

async fn put_settings(State(st): S, Json(new): Json<Settings>) -> Response {
    store(&st, new)
}

#[derive(Deserialize)]
struct ResetReq {
    /// audio / avatar / display / server（省略で全部）
    section: Option<String>,
}

async fn reset_settings(State(st): S, Json(req): Json<ResetReq>) -> Response {
    let mut s = st
        .settings
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let d = Settings::default();
    match req.section.as_deref() {
        Some("audio") => {
            // デバイスの選択は残す
            let (device, channel) = (s.audio.device.take(), s.audio.channel);
            s.audio = d.audio;
            (s.audio.device, s.audio.channel) = (device, channel);
        }
        Some("avatar") => {
            let dir = s.avatar.dir.take();
            s.avatar = d.avatar;
            s.avatar.dir = dir;
        }
        Some("display") => s.display = d.display,
        Some("camera") => {
            // カメラを使うかどうか、カメラの選択、測った値（基準・表情の大きさ）は残す
            let c = std::mem::replace(&mut s.camera, d.camera);
            s.camera.enabled = c.enabled;
            s.camera.device = c.device;
            s.camera.neutral = c.neutral;
            s.camera.ranges = c.ranges;
        }
        Some("hotkeys") => s.hotkeys = d.hotkeys,
        Some("server") => s.server = d.server,
        None => s = d,
        Some(other) => return bad(format!("不明な項目です: {other}")),
    }
    store(&st, s)
}

async fn status(State(st): S) -> Response {
    Json(st.rt.status()).into_response()
}

async fn devices() -> Response {
    match tokio::task::spawn_blocking(crate::devices::list).await {
        Ok(Ok(list)) => Json(list).into_response(),
        Ok(Err(e)) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("デバイスの一覧を取れません: {e:#}"),
        ),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn cal_start(State(st): S) -> Response {
    st.rt.start_calibration();
    ok()
}

async fn cal_cancel(State(st): S) -> Response {
    st.rt.cancel_calibration();
    ok()
}

async fn avatar_view(State(st): S) -> Response {
    Json(avatar_files::view(&avatar_dir(&st))).into_response()
}

async fn avatar_reload(State(st): S) -> Response {
    st.rt.hub.reload_avatar();
    ok()
}

async fn rig_get(State(st): S) -> Response {
    match avatar_files::get_rig(&avatar_dir(&st)) {
        Ok(rig) => Json(json!({ "rig": rig })).into_response(),
        Err(e) => bad(e),
    }
}

/// パーツの調整（設定画面）。avatar.json の rig だけを書き換え、画像は読み直させない
async fn rig_put(State(st): S, Json(rig): Json<serde_json::Value>) -> Response {
    match avatar_files::set_rig(&avatar_dir(&st), rig) {
        Ok(()) => {
            st.rt.hub.reload_manifest();
            ok()
        }
        Err(e) => bad(e),
    }
}

#[derive(Deserialize)]
struct NameQuery {
    name: String,
}

async fn avatar_put(
    State(st): S,
    UrlPath((state, slot)): UrlPath<(String, String)>,
    Query(q): Query<NameQuery>,
    body: Bytes,
) -> Response {
    match avatar_files::set_slot(&avatar_dir(&st), &state, &slot, &q.name, &body) {
        Ok(file) => {
            log::info!("イラスト素材を設定しました: {state} / {slot} → {file}");
            st.rt.hub.reload_avatar();
            Json(json!({ "file": file })).into_response()
        }
        Err(e) => bad(e),
    }
}

async fn avatar_delete(
    State(st): S,
    UrlPath((state, slot)): UrlPath<(String, String)>,
) -> Response {
    match avatar_files::clear_slot(&avatar_dir(&st), &state, &slot) {
        Ok(()) => {
            st.rt.hub.reload_avatar();
            ok()
        }
        Err(e) => bad(e),
    }
}

#[derive(Deserialize)]
struct SnapshotQuery {
    /// ファイル名に付ける状態の名前（idle など）
    state: Option<String>,
}

/// いまの絵（描画ページが作った透過 PNG）を「ピクチャ」に保存する
async fn snapshot_put(Query(q): Query<SnapshotQuery>, body: Bytes) -> Response {
    match tokio::task::spawn_blocking(move || snapshot::save(&body, q.state.as_deref())).await {
        Ok(Ok(path)) => {
            log::info!("いまの絵を保存しました: {}", path.display());
            Json(json!({ "path": path })).into_response()
        }
        Ok(Err(e)) => bad(e),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn recordings() -> Response {
    match tokio::task::spawn_blocking(|| recording::recent_recordings(15)).await {
        Ok(list) => Json(list).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
struct MeasureReq {
    path: PathBuf,
    track: Option<usize>,
}

async fn measure(State(st): S, Json(req): Json<MeasureReq>) -> Response {
    if !req.path.is_file() {
        return bad(format!("ファイルが見つかりません: {}", req.path.display()));
    }
    let id = st.jobs.spawn("録画の解析", move |p| {
        p.set("映像と音声を読み込んでいます");
        let report =
            recording::measure(&req.path, req.track.unwrap_or(1)).map_err(|e| format!("{e:#}"))?;
        let (p10, p90) = report.spread_ms();
        Ok(json!({
            "file": req.path,
            "fps": report.fps,
            "count": report.events.len(),
            "unmatched": report.unmatched,
            "medianMs": report.median_ms(),
            "p10Ms": p10,
            "p90Ms": p90,
            "offsets": report.sorted_offsets(),
            "advice": recording::advice(&report),
        }))
    });
    Json(json!({ "job": id })).into_response()
}

async fn job(State(st): S, UrlPath(id): UrlPath<u64>) -> Response {
    match st.jobs.get(id) {
        Some(j) => Json(j).into_response(),
        None => err(StatusCode::NOT_FOUND, "処理が見つかりません"),
    }
}

#[derive(Deserialize)]
struct LogQuery {
    after: Option<u64>,
}

async fn logs(Query(q): Query<LogQuery>) -> Response {
    Json(crate::logging::recent(q.after.unwrap_or(0))).into_response()
}

async fn versions(State(st): S) -> Response {
    let root = st.root.clone();
    let id = st.jobs.spawn("バージョンの確認", move |_| {
        Ok(serde_json::to_value(maintenance::versions(&root)).expect("JSON にできる"))
    });
    Json(json!({ "job": id })).into_response()
}

async fn check_updates(State(st): S) -> Response {
    let root = st.root.clone();
    let id = st.jobs.spawn("更新の確認", move |p| {
        let r = maintenance::check_updates(&root, |s| p.set(s));
        Ok(serde_json::to_value(r).expect("JSON にできる"))
    });
    Json(json!({ "job": id })).into_response()
}

fn result(r: Result<(), String>) -> Response {
    match r {
        Ok(()) => ok(),
        Err(e) => bad(e),
    }
}

async fn update(State(st): S, Json(o): Json<UpdateOptions>) -> Response {
    log::info!(
        "更新を開始します（GitHub: {} / Rust: {} / 部品: {}）",
        o.git,
        o.rust,
        o.deps
    );
    result(maintenance::launch_update(&st.root, o))
}

async fn rebuild(State(st): S) -> Response {
    log::info!("作り直しを開始します");
    result(maintenance::launch_rebuild(&st.root))
}

async fn rollback(State(st): S) -> Response {
    log::info!("前の版に戻します");
    result(maintenance::launch_rollback(&st.root))
}

async fn terminal(State(st): S) -> Response {
    result(maintenance::open_terminal(&st.root))
}

async fn install_ffmpeg(State(st): S) -> Response {
    result(maintenance::install_ffmpeg(&st.root))
}

#[derive(Deserialize)]
struct OpenReq {
    /// settings / logs / avatar / project / snapshots / file
    target: String,
    path: Option<PathBuf>,
}

async fn open_folder(State(st): S, Json(req): Json<OpenReq>) -> Response {
    let path = match req.target.as_str() {
        "settings" => st.settings_path.parent().map(PathBuf::from),
        "logs" => crate::logging::log_dir(),
        "avatar" => Some(avatar_dir(&st)),
        "project" => Some(st.root.clone()),
        "snapshots" => Some(snapshot::dir()),
        // 録画ファイルの場所（ファイルならそのフォルダ）
        "file" => req.path.and_then(|p| {
            if p.is_dir() {
                Some(p)
            } else {
                p.parent().map(PathBuf::from)
            }
        }),
        other => return bad(format!("不明な場所です: {other}")),
    };
    match path {
        Some(p) => result(maintenance::open_folder(&p)),
        None => bad("場所が分かりません"),
    }
}

async fn get_autostart(State(st): S) -> Response {
    let available = st.app_exe.is_some();
    let enabled = tokio::task::spawn_blocking(maintenance::autostart_enabled)
        .await
        .unwrap_or(false);
    Json(json!({ "available": available, "enabled": enabled })).into_response()
}

#[derive(Deserialize)]
struct AutostartReq {
    enabled: bool,
}

async fn put_autostart(State(st): S, Json(req): Json<AutostartReq>) -> Response {
    let Some(exe) = st.app_exe.clone() else {
        return bad("アプリとして起動しているときだけ設定できます");
    };
    match tokio::task::spawn_blocking(move || maintenance::set_autostart(req.enabled, &exe)).await {
        Ok(r) => result(r),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
struct ExpressionReq {
    /// rig.expressions の名前。None で解除
    name: Option<String>,
}

async fn get_expression(State(st): S) -> Response {
    Json(json!({ "name": st.rt.hub.expression(), "trackers": st.rt.hub.trackers() }))
        .into_response()
}

async fn set_expression(State(st): S, Json(req): Json<ExpressionReq>) -> Response {
    if req
        .name
        .as_ref()
        .is_some_and(|n| n.is_empty() || n.len() > 64)
    {
        return bad("表情の名前が正しくありません");
    }
    st.rt.hub.publish_expression(req.name);
    ok()
}

#[derive(Deserialize)]
struct CameraWindowReq {
    show: bool,
}

async fn camera_window(State(st): S, Json(req): Json<CameraWindowReq>) -> Response {
    match &st.camera_window {
        Some(f) => {
            f(req.show);
            ok()
        }
        None => bad(
            "アプリとして起動しているときだけ使えます（ブラウザでは /tracker/ を開いてください）",
        ),
    }
}

async fn quit(State(st): S, _headers: HeaderMap) -> Response {
    match &st.quit {
        Some(q) => {
            log::info!("設定画面からの指示で終了します");
            // 応答を返してから終了する
            let st2 = st.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(200));
                if let Some(q) = &st2.quit {
                    q();
                }
            });
            let _ = q;
            ok()
        }
        None => bad("アプリとして起動しているときだけ終了できます"),
    }
}
