//! 表示側（OBS のブラウザソース）への配信。
//!
//! - `GET /`         : 描画ページ（renderer をビルドしたもの）
//! - `GET /avatar/…` : イラスト素材（avatar.json と画像）
//! - `GET /ws`       : WebSocket。状態が変わった瞬間に通知する
//!
//! 127.0.0.1 だけで待ち受けるので、同じ PC 以外からは接続できない。
//!
//! ## WebSocket のメッセージ（JSON）
//!
//! エンジン → 表示側
//! - `{"type":"hello","version":1}`                         接続直後に 1 回
//! - `{"type":"state","state":"talk","seq":12}`             状態（idle / talk / away / sleep）。接続直後にも現在の状態を送る
//! - `{"type":"meter","db":-41.2,"voicing":0.93,"voiced":true}`  音量など（subscribe した表示側だけ、約 30 回/秒）
//!
//! 表示側 → エンジン
//! - `{"type":"ack","seq":12}`             その状態を描画したフレームで返す（遅延の測定用）
//! - `{"type":"subscribe","meter":true}`   音量などを受け取る（デバッグ表示用）

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::Instant;

use anyhow::{Context, Result};
use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderValue, header};
use axum::response::Response;
use axum::routing::get;
use axum::serve::ListenerExt;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

use crate::avatar::AvatarState;

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
    Meter(MeterMsg),
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Incoming {
    Ack { seq: u64 },
    Subscribe { meter: bool },
}

pub struct ServerConfig {
    pub port: u16,
    /// 描画ページ（renderer/dist）
    pub renderer_dir: PathBuf,
    /// イラスト素材（avatar）
    pub avatar_dir: PathBuf,
}

/// 制御スレッドとサーバーの橋渡し
pub struct Hub {
    state: watch::Sender<StateMsg>,
    meter: watch::Sender<MeterMsg>,
    seq: AtomicU64,
    clients: AtomicUsize,
    events: mpsc::Sender<ClientEvent>,
}

impl Hub {
    /// 状態を全表示側へ通知する。戻り値は通知の通し番号
    pub fn publish_state(&self, state: AvatarState) -> u64 {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        self.state.send_replace(StateMsg { state, seq });
        seq
    }

    pub fn publish_meter(&self, meter: MeterMsg) {
        self.meter.send_replace(meter);
    }

    /// 接続中の表示側の数
    pub fn clients(&self) -> usize {
        self.clients.load(Ordering::Relaxed)
    }
}

/// サーバーを別スレッドで起動する。ポートが使えないときはここでエラーを返す
pub fn start(cfg: ServerConfig, initial: AvatarState) -> Result<(Arc<Hub>, mpsc::Receiver<ClientEvent>)> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, cfg.port));
    let listener = std::net::TcpListener::bind(addr)
        .with_context(|| format!("ポート {} を使えません（別の cv-engine が起動中かもしれません。--port で変更できます）", cfg.port))?;
    listener.set_nonblocking(true)?;

    let (events, event_rx) = mpsc::channel();
    let hub = Arc::new(Hub {
        state: watch::Sender::new(StateMsg { state: initial, seq: 0 }),
        meter: watch::Sender::new(MeterMsg::default()),
        seq: AtomicU64::new(0),
        clients: AtomicUsize::new(0),
        events,
    });

    // 画像を差し替えたら再読み込みだけで反映されるよう、キャッシュさせない
    let no_cache = SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .nest_service("/avatar", ServeDir::new(&cfg.avatar_dir))
        .fallback_service(ServeDir::new(&cfg.renderer_dir))
        .layer(no_cache)
        .with_state(hub.clone());

    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    std::thread::Builder::new().name("server".into()).spawn(move || {
        runtime.block_on(async move {
            let listener = match tokio::net::TcpListener::from_std(listener) {
                Ok(l) => l.tap_io(|tcp| {
                    // 小さなメッセージを溜めずに即送る（Nagle 無効）
                    let _ = tcp.set_nodelay(true);
                }),
                Err(e) => return eprintln!("\nサーバーを起動できません: {e}"),
            };
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("\nサーバーが停止しました: {e}");
            }
        });
    })?;
    Ok((hub, event_rx))
}

async fn ws_handler(ws: WebSocketUpgrade, State(hub): State<Arc<Hub>>) -> Response {
    ws.on_upgrade(move |socket| client(socket, hub))
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

async fn client(mut socket: WebSocket, hub: Arc<Hub>) {
    let _count = ClientCount::enter(&hub);
    let mut state_rx = hub.state.subscribe();
    let mut meter_rx = hub.meter.subscribe();
    let mut want_meter = false;

    let current = *state_rx.borrow_and_update();
    if !send(&mut socket, &Outgoing::Hello { version: PROTOCOL_VERSION }).await
        || !send(&mut socket, &Outgoing::State(current)).await
    {
        return;
    }

    loop {
        tokio::select! {
            // 状態の通知を最優先にする
            biased;
            changed = state_rx.changed() => {
                if changed.is_err() {
                    break;
                }
                let msg = *state_rx.borrow_and_update();
                if !send(&mut socket, &Outgoing::State(msg)).await {
                    break;
                }
            }
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => match serde_json::from_str::<Incoming>(&text) {
                    Ok(Incoming::Ack { seq }) => {
                        let _ = hub.events.send(ClientEvent::Ack { seq, at: Instant::now() });
                    }
                    Ok(Incoming::Subscribe { meter }) => want_meter = meter,
                    Err(_) => {}
                },
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            changed = meter_rx.changed(), if want_meter => {
                if changed.is_err() {
                    break;
                }
                let msg = *meter_rx.borrow_and_update();
                if !send(&mut socket, &Outgoing::Meter(msg)).await {
                    break;
                }
            }
        }
    }
}
