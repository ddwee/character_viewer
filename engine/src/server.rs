//! 表示側（OBS のブラウザソース）と設定画面への配信。
//!
//! - `GET /`          : 描画ページ（renderer をビルドしたもの）。`/settings/` が設定画面
//! - `GET /avatar/…`  : イラスト素材（avatar.json と画像）。フォルダは実行中に切り替えられる
//! - `GET /ws`        : WebSocket。状態が変わった瞬間に通知する（`?role=monitor` は設定画面用で、表示側として数えない）
//! - `/api/…`         : 設定画面用の API（[`crate::api`]）
//!
//! 127.0.0.1 だけで待ち受けるので、同じ PC 以外からは接続できない。
//!
//! ## WebSocket のメッセージ（JSON）
//!
//! エンジン → 表示側
//! - `{"type":"hello","version":1}`                         接続直後に 1 回
//! - `{"type":"state","state":"talk","seq":12}`             状態（idle / talk / away / sleep）。接続直後にも現在の状態を送る
//! - `{"type":"config","blink":true,"blinkRate":1,"mirror":false}`  見た目の設定。接続直後と変更時
//! - `{"type":"reload"}`                                    イラスト素材が変わったので読み込み直す
//! - `{"type":"meter","db":-41.2,"voicing":0.93,"voiced":true}`  音量など（subscribe した側だけ、約 30 回/秒）
//! - `{"type":"level","db":-31.5}`                          音量だけ（subscribe した側だけ、音声の処理単位ごと＝約 100 回/秒）。口の開き具合用
//!
//! 表示側 → エンジン
//! - `{"type":"ack","seq":12}`             その状態を描画したフレームで返す（遅延の測定用）
//! - `{"type":"subscribe","meter":true,"level":true}`   音量などを受け取る（`level` は省略可）

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock, mpsc};
use std::time::Instant;

use anyhow::{Context, Result};
use axum::Router;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, Request, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::serve::ListenerExt;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tower::ServiceExt as _;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

use crate::avatar::AvatarState;
use crate::settings::DisplaySettings;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct StateMsg {
    pub state: AvatarState,
    pub seq: u64,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct MeterMsg {
    pub db: f32,
    pub voicing: f32,
    pub voiced: bool,
}

/// 表示側から届いた出来事（制御スレッドへ渡す）
#[derive(Clone, Copy, Debug)]
pub enum ClientEvent {
    /// 表示側が接続した（`clients` は接続後の数）
    Connected { clients: usize },
    /// 表示側が切断した（`clients` は切断後の数）
    Disconnected { clients: usize },
    /// 表示側が `seq` の状態を描画した。`at` はエンジンが受け取った時刻
    Ack { seq: u64, at: Instant },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Outgoing {
    Hello { version: u32 },
    State(StateMsg),
    Config(DisplaySettings),
    Reload,
    Meter(MeterMsg),
    Level { db: f32 },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Incoming {
    Ack {
        seq: u64,
    },
    Subscribe {
        #[serde(default)]
        meter: bool,
        #[serde(default)]
        level: bool,
    },
}

/// 制御スレッド・設定 API とサーバーの橋渡し
pub struct Hub {
    state: watch::Sender<StateMsg>,
    meter: watch::Sender<MeterMsg>,
    /// 音量エンベロープ（dB）。音声の処理単位ごとに更新する
    level: watch::Sender<f32>,
    config: watch::Sender<DisplaySettings>,
    reload: watch::Sender<u64>,
    seq: AtomicU64,
    clients: AtomicUsize,
    events: mpsc::Sender<ClientEvent>,
    /// イラスト素材のフォルダ（実行中に切り替えられる）
    avatar_dir: RwLock<PathBuf>,
}

impl Hub {
    pub fn new(
        display: DisplaySettings,
        avatar_dir: PathBuf,
    ) -> (Arc<Self>, mpsc::Receiver<ClientEvent>) {
        let (events, rx) = mpsc::channel();
        let hub = Arc::new(Self {
            state: watch::Sender::new(StateMsg {
                state: AvatarState::Idle,
                seq: 0,
            }),
            meter: watch::Sender::new(MeterMsg::default()),
            level: watch::Sender::new(-120.0),
            config: watch::Sender::new(display),
            reload: watch::Sender::new(0),
            seq: AtomicU64::new(0),
            clients: AtomicUsize::new(0),
            events,
            avatar_dir: RwLock::new(avatar_dir),
        });
        (hub, rx)
    }

    /// 状態を全表示側へ通知する。戻り値は通知の通し番号
    pub fn publish_state(&self, state: AvatarState) -> u64 {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        self.state.send_replace(StateMsg { state, seq });
        seq
    }

    pub fn current_state(&self) -> AvatarState {
        self.state.borrow().state
    }

    pub fn publish_meter(&self, meter: MeterMsg) {
        self.meter.send_replace(meter);
    }

    /// 音量（dB）を通知する。口の開き具合に使うので、届いたらすぐ送る
    pub fn publish_level(&self, db: f32) {
        self.level.send_replace(db);
    }

    pub fn publish_config(&self, display: DisplaySettings) {
        self.config.send_if_modified(|c| {
            let changed = *c != display;
            *c = display;
            changed
        });
    }

    /// イラスト素材を読み込み直させる
    pub fn reload_avatar(&self) {
        self.reload.send_modify(|n| *n += 1);
    }

    pub fn avatar_dir(&self) -> PathBuf {
        self.avatar_dir
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn set_avatar_dir(&self, dir: PathBuf) {
        let mut cur = self.avatar_dir.write().unwrap_or_else(|e| e.into_inner());
        if *cur != dir {
            *cur = dir;
            drop(cur);
            self.reload_avatar();
        }
    }

    /// 接続中の表示側の数
    pub fn clients(&self) -> usize {
        self.clients.load(Ordering::Relaxed)
    }
}

/// ポートを確保する（使えないときはここでエラー）
pub fn bind(port: u16) -> Result<std::net::TcpListener> {
    let listener = std::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
        .with_context(|| format!("ポート {port} を使えません。character_viewer がすでに起動しているか、別のアプリが使っています"))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

/// 描画ページ・素材・WebSocket の経路
pub fn routes(hub: Arc<Hub>, renderer_dir: PathBuf) -> Router {
    // 画像を差し替えたら再読み込みだけで反映されるよう、キャッシュさせない
    let no_cache = SetResponseHeaderLayer::overriding(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache"),
    );
    Router::new()
        .route("/ws", get(ws_handler))
        .route("/avatar/{*path}", get(avatar_file))
        .fallback_service(ServeDir::new(renderer_dir))
        .layer(no_cache)
        .with_state(hub)
}

/// サーバーを別スレッドで動かす
pub fn spawn(listener: std::net::TcpListener, app: Router) -> Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    std::thread::Builder::new()
        .name("server".into())
        .spawn(move || {
            runtime.block_on(async move {
                let listener = match tokio::net::TcpListener::from_std(listener) {
                    Ok(l) => l.tap_io(|tcp| {
                        // 小さなメッセージを溜めずに即送る（Nagle 無効）
                        let _ = tcp.set_nodelay(true);
                    }),
                    Err(e) => return log::error!("サーバーを起動できません: {e}"),
                };
                if let Err(e) = axum::serve(listener, app).await {
                    log::error!("サーバーが停止しました: {e}");
                }
            });
        })?;
    Ok(())
}

async fn avatar_file(State(hub): State<Arc<Hub>>, req: Request<Body>) -> Response {
    // /avatar/xxx → 素材フォルダの xxx（ServeDir が .. などの不正なパスを弾く）
    let (mut parts, body) = req.into_parts();
    let rest = parts
        .uri
        .path()
        .strip_prefix("/avatar")
        .unwrap_or("/")
        .to_string();
    let query = parts
        .uri
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    parts.uri = format!("{rest}{query}").parse().unwrap_or_default();
    match ServeDir::new(hub.avatar_dir())
        .oneshot(Request::from_parts(parts, body))
        .await
    {
        Ok(res) => res.into_response(),
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct WsQuery {
    role: Option<String>,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    State(hub): State<Arc<Hub>>,
) -> Response {
    let monitor = q.role.as_deref() == Some("monitor");
    ws.on_upgrade(move |socket| client(socket, hub, monitor))
}

struct ClientCount<'a>(&'a Hub);

impl<'a> ClientCount<'a> {
    fn enter(hub: &'a Hub) -> Self {
        let clients = hub.clients.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = hub.events.send(ClientEvent::Connected { clients });
        Self(hub)
    }
}

impl Drop for ClientCount<'_> {
    fn drop(&mut self) {
        let clients = self.0.clients.fetch_sub(1, Ordering::Relaxed) - 1;
        let _ = self.0.events.send(ClientEvent::Disconnected { clients });
    }
}

async fn send(socket: &mut WebSocket, msg: &Outgoing) -> bool {
    let text = serde_json::to_string(msg).expect("送信メッセージは必ず JSON にできる");
    socket.send(Message::text(text)).await.is_ok()
}

async fn client(mut socket: WebSocket, hub: Arc<Hub>, monitor: bool) {
    let _count = (!monitor).then(|| ClientCount::enter(&hub));
    let mut state_rx = hub.state.subscribe();
    let mut meter_rx = hub.meter.subscribe();
    let mut level_rx = hub.level.subscribe();
    let mut config_rx = hub.config.subscribe();
    let mut reload_rx = hub.reload.subscribe();
    let mut want_meter = false;
    let mut want_level = false;

    let current = *state_rx.borrow_and_update();
    let config = *config_rx.borrow_and_update();
    reload_rx.borrow_and_update();
    if !send(
        &mut socket,
        &Outgoing::Hello {
            version: PROTOCOL_VERSION,
        },
    )
    .await
        || !send(&mut socket, &Outgoing::Config(config)).await
        || !send(&mut socket, &Outgoing::State(current)).await
    {
        return;
    }

    loop {
        let msg = tokio::select! {
            // 状態の通知を最優先にする
            biased;
            changed = state_rx.changed() => match changed {
                Ok(()) => Outgoing::State(*state_rx.borrow_and_update()),
                Err(_) => break,
            },
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => match serde_json::from_str::<Incoming>(&text) {
                        Ok(Incoming::Ack { seq }) if !monitor => {
                            let _ = hub.events.send(ClientEvent::Ack { seq, at: Instant::now() });
                        }
                        Ok(Incoming::Subscribe { meter, level }) => {
                            want_meter = meter;
                            if level && !want_level {
                                // 購読前の古い値は送らない
                                level_rx.borrow_and_update();
                            }
                            want_level = level;
                        }
                        _ => {}
                    },
                    Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                    Some(Ok(_)) => {}
                }
                continue;
            }
            changed = config_rx.changed() => match changed {
                Ok(()) => Outgoing::Config(*config_rx.borrow_and_update()),
                Err(_) => break,
            },
            changed = reload_rx.changed() => match changed {
                Ok(()) => {
                    reload_rx.borrow_and_update();
                    Outgoing::Reload
                }
                Err(_) => break,
            },
            changed = level_rx.changed(), if want_level => match changed {
                Ok(()) => Outgoing::Level { db: *level_rx.borrow_and_update() },
                Err(_) => break,
            },
            changed = meter_rx.changed(), if want_meter => match changed {
                Ok(()) => Outgoing::Meter(*meter_rx.borrow_and_update()),
                Err(_) => break,
            },
        };
        if !send(&mut socket, &msg).await {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscribe_accepts_old_and_new_forms() {
        // 古い描画ページは level を送らない
        let m: Incoming = serde_json::from_str(r#"{"type":"subscribe","meter":true}"#).unwrap();
        assert!(matches!(
            m,
            Incoming::Subscribe {
                meter: true,
                level: false
            }
        ));
        let m: Incoming = serde_json::from_str(r#"{"type":"subscribe","level":true}"#).unwrap();
        assert!(matches!(
            m,
            Incoming::Subscribe {
                meter: false,
                level: true
            }
        ));
    }

    #[test]
    fn level_message_shape() {
        let text = serde_json::to_string(&Outgoing::Level { db: -31.5 }).unwrap();
        assert_eq!(text, r#"{"type":"level","db":-31.5}"#);
    }
}
