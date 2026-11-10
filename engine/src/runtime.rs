//! 実行中のエンジン本体。制御スレッドが 1 本で
//! - マイク入力（デバイスが外れたら 3 秒ごとに再接続）
//! - 発話判定の結果から絵の状態を決めて描画ページへ通知、遅延の集計
//! - キャリブレーション録音と解析
//! - 設定画面から届いた設定の反映
//!
//! を受け持つ。設定画面へは [`RuntimeHandle::status`] で状態を見せる。

use std::path::PathBuf;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::audio::{self, Input, Msg, Processor, Recorder, qpc_now};
use crate::avatar::{AvatarMachine, AvatarState};
use crate::calibration::{self, SEGMENTS};
use crate::detector::Transition;
use crate::dsp::{Biquad, lin_to_db};
use crate::server::{ClientEvent, Hub, MeterMsg};
use crate::settings::{Settings, data_dir};

/// 描画ページの応答を待つ上限
const ACK_TIMEOUT: Duration = Duration::from_millis(300);
/// マイクを開けなかったときに再試行する間隔
const RETRY_INTERVAL: Duration = Duration::from_secs(3);
const STATUS_INTERVAL: Duration = Duration::from_millis(33);
const RECENT_LATENCY: usize = 12;
const COUNTDOWN: Duration = Duration::from_secs(3);

// ───────────────────────── 設定画面に見せる状態 ─────────────────────────

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub count: u32,
    pub avg: f64,
    pub min: f64,
    pub max: f64,
}

impl Summary {
    fn add(&mut self, v: f64) {
        if self.count == 0 {
            (self.min, self.max) = (v, v);
        }
        self.avg = (self.avg * self.count as f64 + v) / (self.count + 1) as f64;
        self.count += 1;
        self.min = self.min.min(v);
        self.max = self.max.max(v);
    }

    pub fn text(&self) -> String {
        if self.count == 0 {
            return "データなし".into();
        }
        format!(
            "平均 {:.1}ms / 最小 {:.1}ms / 最大 {:.1}ms（{}回）",
            self.avg, self.min, self.max, self.count
        )
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyEvent {
    pub state: AvatarState,
    /// 音 → 判定（発話開始のときだけ）
    pub detect_ms: Option<f64>,
    /// 判定 → 描画フレーム（描画ページの応答がないときは None）
    pub display_ms: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyStatus {
    pub detect: Summary,
    pub display: Summary,
    pub total: Summary,
    /// 新しい順
    pub recent: Vec<LatencyEvent>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputStatus {
    pub name: String,
    pub sample_rate: u32,
    pub channels: usize,
    pub format: String,
    pub buffer_frames: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalSegmentInfo {
    pub label: &'static str,
    pub prompt: &'static str,
    pub secs: f32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalSegmentResult {
    pub label: &'static str,
    /// 反応すべき区間か
    pub target: bool,
    pub reacted: bool,
    pub starts: u32,
    /// 声の捕捉率（%）
    pub recall: Option<f32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalOption {
    pub name: &'static str,
    pub quiet_target: bool,
    pub on_db: f32,
    pub off_db: f32,
    pub voicing: f32,
    pub note: Option<String>,
    pub segments: Vec<CalSegmentResult>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalSegmentStats {
    pub label: &'static str,
    pub median_db: Option<f32>,
    pub p99_db: Option<f32>,
    pub voiced_ratio: f32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationResult {
    pub options: Vec<CalOption>,
    pub stats: Vec<CalSegmentStats>,
    pub wav: Option<PathBuf>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationStatus {
    /// countdown / recording / analyzing / done / error
    pub phase: &'static str,
    pub segments: Vec<CalSegmentInfo>,
    /// 今の区間（0 始まり）
    pub segment: usize,
    pub remaining_secs: f32,
    /// 全体の進み具合（0〜1）
    pub progress: f32,
    pub level_db: f32,
    pub result: Option<CalibrationResult>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: AvatarState,
    pub speaking: bool,
    /// 無言が続いている秒数（発話中は None）
    pub silent_secs: Option<f32>,
    pub level_db: f32,
    pub env_db: f32,
    pub voicing: f32,
    pub voiced: bool,
    pub input: Option<InputStatus>,
    pub input_error: Option<String>,
    /// 接続中の描画ページの数
    pub clients: usize,
    pub latency: LatencyStatus,
    pub calibration: Option<CalibrationStatus>,
}

// ───────────────────────── 外から操作する口 ─────────────────────────

enum Command {
    Apply(Box<Settings>),
    StartCalibration,
    CancelCalibration,
    Shutdown,
}

#[derive(Clone)]
pub struct RuntimeHandle {
    status: Arc<Mutex<Status>>,
    cmd: mpsc::Sender<Command>,
    control: std::thread::Thread,
    pub hub: Arc<Hub>,
}

impl RuntimeHandle {
    pub fn status(&self) -> Status {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn send(&self, c: Command) {
        let _ = self.cmd.send(c);
        self.control.unpark();
    }

    /// 設定を反映する（マイクの設定が変わっていれば開き直す）
    pub fn apply(&self, settings: Settings) {
        self.send(Command::Apply(Box::new(settings)));
    }

    pub fn start_calibration(&self) {
        self.send(Command::StartCalibration);
    }

    /// キャリブレーションを中止する（結果の表示も消す）
    pub fn cancel_calibration(&self) {
        self.send(Command::CancelCalibration);
    }

    pub fn shutdown(&self) {
        self.send(Command::Shutdown);
    }
}

/// エンジンを起動する。`default_avatar_dir` は設定で素材フォルダが指定されていないときに使う
pub fn start(
    settings: Settings,
    hub: Arc<Hub>,
    events: mpsc::Receiver<ClientEvent>,
    default_avatar_dir: PathBuf,
) -> RuntimeHandle {
    let status = Arc::new(Mutex::new(Status::default()));
    let (cmd, cmd_rx) = mpsc::channel();
    hub.set_avatar_dir(
        settings
            .avatar
            .dir
            .clone()
            .unwrap_or_else(|| default_avatar_dir.clone()),
    );
    hub.publish_config(settings.display);

    let ctl = Control::new(settings, hub.clone(), status.clone(), default_avatar_dir);
    let thread = std::thread::Builder::new()
        .name("control".into())
        .spawn(move || ctl.run(cmd_rx, events))
        .expect("制御スレッドを起動できません");
    spawn_avatar_watcher(hub.clone());
    RuntimeHandle {
        status,
        cmd,
        control: thread.thread().clone(),
        hub,
    }
}

/// 素材フォルダのファイルが変わったら（Krita で上書き保存したときなど）描画ページに読み込み直させる。
/// avatar.json だけが変わったとき（設定画面でパーツを調整したときなど）は、画像を読み直さなくてよいと伝える
fn spawn_avatar_watcher(hub: Arc<Hub>) {
    std::thread::Builder::new()
        .name("avatar-watch".into())
        .spawn(move || {
            let mut last = avatar_fingerprint(&hub.avatar_dir());
            loop {
                std::thread::sleep(Duration::from_millis(800));
                let now = avatar_fingerprint(&hub.avatar_dir());
                if now.images != last.images {
                    log::info!("イラスト素材の変更を検出しました。描画ページに読み込み直させます");
                    hub.reload_avatar();
                } else if now.manifest != last.manifest {
                    hub.reload_manifest();
                }
                last = now;
            }
        })
        .expect("監視スレッドを起動できません");
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct AvatarFingerprint {
    /// avatar.json
    manifest: u64,
    /// それ以外（画像など）とフォルダの場所
    images: u64,
}

/// 素材フォルダの中身の指紋（名前・大きさ・更新時刻）。中身は読まないので軽い
fn avatar_fingerprint(dir: &std::path::Path) -> AvatarFingerprint {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    type Entry = (std::ffi::OsString, u64, Option<std::time::SystemTime>, bool);
    let list = |d: &std::path::Path| -> Vec<Entry> {
        let Ok(entries) = std::fs::read_dir(d) else {
            return vec![];
        };
        let mut v: Vec<_> = entries
            .flatten()
            .filter_map(|e| {
                let m = e.metadata().ok()?;
                Some((e.file_name(), m.len(), m.modified().ok(), m.is_dir()))
            })
            .collect();
        v.sort();
        v
    };
    let mut manifest = DefaultHasher::new();
    let mut images = DefaultHasher::new();
    dir.hash(&mut images);
    for e in list(dir) {
        // avatar.json と、保存途中の avatar.json.tmp
        if e.0.to_string_lossy().starts_with("avatar.json") {
            e.hash(&mut manifest);
        } else if e.3 {
            // パーツを `parts/` のようなフォルダに分けて置けるよう、1 段下のフォルダまで見る
            e.0.hash(&mut images);
            list(&dir.join(&e.0)).hash(&mut images);
        } else {
            e.hash(&mut images);
        }
    }
    AvatarFingerprint {
        manifest: manifest.finish(),
        images: images.finish(),
    }
}

// ───────────────────────── 制御スレッド ─────────────────────────

/// 描画ページからの応答（ack）を待っている通知
struct Pending {
    seq: u64,
    sent: Instant,
    to_publish_ms: f64,
    detect_ms: Option<f64>,
    state: AvatarState,
    line: String,
}

struct Live {
    input: Input,
    rx: rtrb::Consumer<Msg>,
}

enum CalPhase {
    Countdown(Instant),
    Recording,
    Analyzing(std::thread::JoinHandle<CalibrationResult>),
    Done,
}

struct Calibration {
    input: Option<Input>,
    rx: rtrb::Consumer<f32>,
    sr: f32,
    samples: Vec<f32>,
    phase: CalPhase,
    hp: Biquad,
    shown_peak: f32,
    status: CalibrationStatus,
}

struct Control {
    settings: Settings,
    hub: Arc<Hub>,
    status: Arc<Mutex<Status>>,
    default_avatar_dir: PathBuf,
    start: Instant,
    machine: AvatarMachine,
    live: Option<Live>,
    retry_at: Option<Instant>,
    last_error: Option<String>,
    cal: Option<Calibration>,
    pending: Option<Pending>,
    lat: LatencyStatus,
    speech_started: Option<Instant>,
    meter: (f32, f32, f32, bool, u32),
}

impl Control {
    fn new(
        settings: Settings,
        hub: Arc<Hub>,
        status: Arc<Mutex<Status>>,
        default_avatar_dir: PathBuf,
    ) -> Self {
        let start = Instant::now();
        let machine = AvatarMachine::new(settings.avatar_config(), Duration::ZERO);
        Self {
            settings,
            hub,
            status,
            default_avatar_dir,
            start,
            machine,
            live: None,
            retry_at: None,
            last_error: None,
            cal: None,
            pending: None,
            lat: LatencyStatus::default(),
            speech_started: None,
            meter: (-120.0, -120.0, 0.0, false, 0),
        }
    }

    fn now(&self) -> Duration {
        self.start.elapsed()
    }

    fn run(mut self, cmd_rx: mpsc::Receiver<Command>, events: mpsc::Receiver<ClientEvent>) {
        let mut last_status = Instant::now() - STATUS_INTERVAL;
        loop {
            while let Ok(c) = cmd_rx.try_recv() {
                match c {
                    Command::Apply(s) => self.apply(*s),
                    Command::StartCalibration => self.start_calibration(),
                    Command::CancelCalibration => {
                        if self.cal.take().is_some() {
                            log::info!("キャリブレーションを終了しました");
                        }
                    }
                    Command::Shutdown => {
                        self.live = None;
                        return;
                    }
                }
            }

            if self.cal.as_ref().is_some_and(|c| c.input.is_some()) {
                self.step_calibration();
            } else {
                self.ensure_input();
                self.pump_audio();
            }
            if let Some(cal) = &mut self.cal {
                Self::poll_analysis(cal);
            }

            let now = self.now();
            if let Some(state) = self.machine.tick(now) {
                let silent = self
                    .machine
                    .silent_for(now)
                    .unwrap_or_default()
                    .as_secs_f32();
                let line = format!(
                    "{} {}（無言 {silent:.1} 秒）",
                    if state == AvatarState::Sleep {
                        "z"
                    } else {
                        "…"
                    },
                    state.label()
                );
                self.publish(state, line, None, None);
            }

            while let Ok(ev) = events.try_recv() {
                match ev {
                    ClientEvent::Ack { seq, at } => self.on_ack(seq, at),
                    ClientEvent::Connected { clients } => {
                        log::info!("描画ページが接続しました（{clients} 個）")
                    }
                    ClientEvent::Disconnected { clients } => {
                        log::info!("描画ページが切断しました（{clients} 個）")
                    }
                }
            }
            self.flush_pending(true);

            if last_status.elapsed() >= STATUS_INTERVAL {
                last_status = Instant::now();
                self.update_status();
            }
            // 発話の開始・終了と設定画面からの指示ではすぐ起こされるので、普段は短く眠るだけ
            std::thread::park_timeout(Duration::from_millis(5));
        }
    }

    fn apply(&mut self, s: Settings) {
        if s.audio != self.settings.audio {
            log::info!("マイクの設定を反映します");
            self.live = None;
            self.retry_at = None;
            self.last_error = None;
        }
        if s.avatar != self.settings.avatar {
            self.machine.set_config(s.avatar_config());
            self.hub.set_avatar_dir(
                s.avatar
                    .dir
                    .clone()
                    .unwrap_or_else(|| self.default_avatar_dir.clone()),
            );
        }
        self.hub.publish_config(s.display);
        self.settings = s;
    }

    fn ensure_input(&mut self) {
        if let Some(live) = &self.live
            && live.input.failed.load(std::sync::atomic::Ordering::SeqCst)
        {
            log::warn!("マイクとの接続が切れました。再接続を試みます");
            self.live = None;
            self.retry_at = Some(Instant::now() + Duration::from_millis(500));
        }
        if self.live.is_some() || self.retry_at.is_some_and(|t| Instant::now() < t) {
            return;
        }
        match self.open_live() {
            Ok(live) => {
                log::info!(
                    "マイクを開きました: {}（チャンネル {} / {}ch, {}Hz, {:?}）",
                    live.input.name,
                    self.settings.audio.channel,
                    live.input.channels,
                    live.input.sample_rate,
                    live.input.format
                );
                self.live = Some(live);
                self.last_error = None;
                self.retry_at = None;
            }
            Err(e) => {
                let msg = format!("{e:#}");
                if self.last_error.as_deref() != Some(&msg) {
                    log::error!("マイクを開けません: {msg}");
                }
                self.last_error = Some(msg);
                self.retry_at = Some(Instant::now() + RETRY_INTERVAL);
            }
        }
    }

    fn open_live(&self) -> anyhow::Result<Live> {
        let device = crate::devices::select(self.settings.audio.device.as_deref())?;
        let (tx, rx) = rtrb::RingBuffer::<Msg>::new(4096);
        let pcfg = self.settings.pipeline_config();
        let channel = self.settings.audio.channel;
        let input = audio::open(&device, |sr, ch| Processor::new(&pcfg, sr, ch, channel, tx))?;
        Ok(Live { input, rx })
    }

    fn pump_audio(&mut self) {
        let Some(live) = self.live.as_mut() else {
            return;
        };
        let mut transitions = vec![];
        let mut level = None;
        while let Ok(msg) = live.rx.pop() {
            match msg {
                Msg::Meter {
                    level_db,
                    env_db,
                    voicing,
                    voiced,
                    frames,
                } => {
                    self.meter = (level_db, env_db, voicing, voiced, frames);
                    level = Some(env_db);
                }
                Msg::Transition {
                    kind,
                    latency_us,
                    at,
                } => transitions.push((kind, latency_us, at)),
            }
        }
        for (kind, latency_us, at) in transitions {
            let now = self.now();
            let silent = self.machine.silent_for(now).unwrap_or_default();
            let detect_ms = (kind == Transition::SpeechStart).then(|| latency_us as f64 / 1000.0);
            if let Some(d) = detect_ms {
                self.lat.detect.add(d);
            }
            let Some(state) = self.machine.on_transition(kind, now) else {
                continue;
            };
            let line = match state {
                AvatarState::Talk => {
                    self.speech_started = Some(Instant::now());
                    format!("▶ 発話（直前の無言 {:.1} 秒）", silent.as_secs_f32())
                }
                _ => {
                    let dur = self
                        .speech_started
                        .take()
                        .map_or(0.0, |s| s.elapsed().as_secs_f32());
                    format!("■ {}（発話 {dur:.2} 秒）", state.label())
                }
            };
            self.publish(state, line, detect_ms, Some(at));
        }
        // 状態の通知のあとに送る（発話の開始は状態の通知が最優先）
        if let Some(db) = level {
            self.hub.publish_level(db);
        }
    }

    fn publish(
        &mut self,
        state: AvatarState,
        line: String,
        detect_ms: Option<f64>,
        detected_at: Option<Duration>,
    ) {
        self.flush_pending(false);
        let to_publish_ms = detected_at.map_or(0.0, |at| {
            qpc_now().saturating_sub(at).as_secs_f64() * 1000.0
        });
        let seq = self.hub.publish_state(state);
        let p = Pending {
            seq,
            sent: Instant::now(),
            to_publish_ms,
            detect_ms,
            state,
            line,
        };
        if self.hub.clients() == 0 {
            self.finish(p, None);
        } else {
            self.pending = Some(p);
        }
    }

    fn on_ack(&mut self, seq: u64, at: Instant) {
        if let Some(p) = self.pending.take_if(|p| p.seq == seq) {
            let disp =
                p.to_publish_ms + at.saturating_duration_since(p.sent).as_secs_f64() * 1000.0;
            self.finish(p, Some(disp));
        }
    }

    fn flush_pending(&mut self, timed_out_only: bool) {
        if self
            .pending
            .as_ref()
            .is_some_and(|p| !timed_out_only || p.sent.elapsed() >= ACK_TIMEOUT)
        {
            let p = self.pending.take().expect("直前に確認済み");
            self.finish(p, None);
        }
    }

    fn finish(&mut self, p: Pending, display_ms: Option<f64>) {
        let detail = match (p.detect_ms, display_ms) {
            (Some(d), Some(s)) => {
                self.lat.total.add(d + s);
                format!("検出 {d:.1} + 表示 {s:.1} = 合計 {:.1} ms", d + s)
            }
            (None, Some(s)) => format!("表示 {s:.1} ms"),
            (Some(d), None) => format!("検出 {d:.1} ms"),
            (None, None) => String::new(),
        };
        if let Some(s) = display_ms {
            self.lat.display.add(s);
        }
        log::info!("{}  {detail}", p.line);
        self.lat.recent.insert(
            0,
            LatencyEvent {
                state: p.state,
                detect_ms: p.detect_ms,
                display_ms,
            },
        );
        self.lat.recent.truncate(RECENT_LATENCY);
    }

    fn update_status(&mut self) {
        let (level_db, env_db, voicing, voiced, frames) = self.meter;
        if self.live.is_some() {
            self.hub.publish_meter(MeterMsg {
                db: env_db,
                voicing,
                voiced,
            });
        }
        let now = self.now();
        let mut s = self.status.lock().unwrap_or_else(|e| e.into_inner());
        s.state = self.machine.state();
        s.silent_secs = self.machine.silent_for(now).map(|d| d.as_secs_f32());
        s.speaking = s.silent_secs.is_none();
        (s.level_db, s.env_db, s.voicing, s.voiced) = (level_db, env_db, voicing, voiced);
        s.input = self.live.as_ref().map(|l| InputStatus {
            name: l.input.name.clone(),
            sample_rate: l.input.sample_rate,
            channels: l.input.channels,
            format: format!("{:?}", l.input.format),
            buffer_frames: frames,
        });
        s.input_error =
            if self.live.is_none() && self.cal.as_ref().is_none_or(|c| c.input.is_none()) {
                self.last_error.clone()
            } else {
                None
            };
        s.clients = self.hub.clients();
        s.latency = self.lat.clone();
        s.calibration = self.cal.as_ref().map(|c| c.status.clone());
    }

    // ───────────── キャリブレーション ─────────────

    fn start_calibration(&mut self) {
        // 録音中は発話判定を止める（同じデバイスを録音用に開き直す）
        self.live = None;
        let result = (|| -> anyhow::Result<Calibration> {
            let device = crate::devices::select(self.settings.audio.device.as_deref())?;
            let (cfg, _) = audio::device_config(&device)?;
            let sr = cfg.sample_rate as f32;
            let (tx, rx) = rtrb::RingBuffer::<f32>::new(sr as usize * 2);
            let channel = self.settings.audio.channel;
            let input = audio::open(&device, |_, channels| {
                anyhow::ensure!(
                    channel >= 1 && channel <= channels,
                    "チャンネル {channel} はありません"
                );
                Ok(Recorder {
                    channel: channel - 1,
                    channels,
                    tx,
                })
            })?;
            let hpf = self.settings.audio.hpf_hz;
            Ok(Calibration {
                input: Some(input),
                rx,
                sr,
                samples: Vec::with_capacity(((calibration::total_secs() + 1.0) * sr) as usize),
                phase: CalPhase::Countdown(Instant::now()),
                hp: if hpf > 0.0 {
                    Biquad::highpass(hpf, sr, std::f32::consts::FRAC_1_SQRT_2)
                } else {
                    Biquad::identity()
                },
                shown_peak: 0.0,
                status: CalibrationStatus {
                    phase: "countdown",
                    segments: SEGMENTS
                        .iter()
                        .map(|s| CalSegmentInfo {
                            label: s.label,
                            prompt: s.prompt,
                            secs: s.secs,
                        })
                        .collect(),
                    segment: 0,
                    remaining_secs: COUNTDOWN.as_secs_f32(),
                    progress: 0.0,
                    level_db: -120.0,
                    result: None,
                    error: None,
                },
            })
        })();
        match result {
            Ok(c) => {
                log::info!("キャリブレーションを開始しました");
                self.cal = Some(c);
            }
            Err(e) => {
                log::error!("キャリブレーションを開始できません: {e:#}");
                self.cal = Some(Calibration::failed(format!("{e:#}")));
            }
        }
    }

    fn step_calibration(&mut self) {
        let base = self.settings.pipeline_config();
        let Some(cal) = self.cal.as_mut() else { return };
        let mut peak = 0.0f32;
        while let Ok(x) = cal.rx.pop() {
            peak = peak.max(cal.hp.process(x).abs());
            if matches!(cal.phase, CalPhase::Recording) {
                cal.samples.push(x);
            }
        }
        cal.shown_peak = peak.max(cal.shown_peak * 0.85);
        cal.status.level_db = lin_to_db(cal.shown_peak);

        if cal
            .input
            .as_ref()
            .is_some_and(|i| i.failed.load(std::sync::atomic::Ordering::SeqCst))
        {
            log::error!("録音中にマイクとの接続が切れました");
            *cal = Calibration::failed("録音中にマイクとの接続が切れました".into());
            return;
        }

        match &cal.phase {
            CalPhase::Countdown(t0) => {
                let left = COUNTDOWN.saturating_sub(t0.elapsed());
                cal.status.remaining_secs = left.as_secs_f32();
                if left.is_zero() {
                    cal.phase = CalPhase::Recording;
                    cal.status.phase = "recording";
                }
            }
            CalPhase::Recording => {
                let total = (calibration::total_secs() * cal.sr) as usize;
                let t = cal.samples.len() as f32 / cal.sr;
                let mut acc = 0.0;
                let seg = SEGMENTS.iter().position(|s| {
                    acc += s.secs;
                    t < acc
                });
                cal.status.segment = seg.unwrap_or(SEGMENTS.len() - 1);
                cal.status.remaining_secs = (acc - t).max(0.0);
                cal.status.progress = (cal.samples.len() as f32 / total as f32).min(1.0);
                if cal.samples.len() >= total {
                    cal.samples.truncate(total);
                    cal.input = None; // 録音終了。発話判定は次のループで再開する
                    cal.status.phase = "analyzing";
                    let samples = std::mem::take(&mut cal.samples);
                    let sr = cal.sr;
                    cal.phase = CalPhase::Analyzing(std::thread::spawn(move || {
                        analyze_calibration(samples, sr, base)
                    }));
                    log::info!("キャリブレーションの録音が終わりました。解析しています");
                }
            }
            CalPhase::Analyzing(_) | CalPhase::Done => {}
        }
    }

    fn poll_analysis(cal: &mut Calibration) {
        if !matches!(&cal.phase, CalPhase::Analyzing(h) if h.is_finished()) {
            return;
        }
        let CalPhase::Analyzing(h) = std::mem::replace(&mut cal.phase, CalPhase::Done) else {
            unreachable!()
        };
        match h.join() {
            Ok(result) => {
                log::info!("キャリブレーションの解析が終わりました");
                cal.status.phase = "done";
                cal.status.progress = 1.0;
                cal.status.result = Some(result);
            }
            Err(_) => {
                log::error!("キャリブレーションの解析中にエラーが起きました");
                cal.status.phase = "error";
                cal.status.error =
                    Some("解析中にエラーが起きました。ログを確認してください".into());
            }
        }
    }
}

impl Calibration {
    fn failed(error: String) -> Self {
        let (_, rx) = rtrb::RingBuffer::<f32>::new(1);
        Self {
            input: None,
            rx,
            sr: 48_000.0,
            samples: vec![],
            phase: CalPhase::Done,
            hp: Biquad::identity(),
            shown_peak: 0.0,
            status: CalibrationStatus {
                phase: "error",
                segments: vec![],
                segment: 0,
                remaining_secs: 0.0,
                progress: 0.0,
                level_db: -120.0,
                result: None,
                error: Some(error),
            },
        }
    }
}

fn analyze_calibration(
    samples: Vec<f32>,
    sr: f32,
    base: crate::pipeline::PipelineConfig,
) -> CalibrationResult {
    let wav = data_dir().join("calibration.wav");
    let wav = match audio::write_wav(&wav, &samples, sr as u32) {
        Ok(()) => Some(wav),
        Err(e) => {
            log::warn!("録音を保存できませんでした: {e:#}");
            None
        }
    };
    let report = calibration::analyze(&samples, sr, &base);
    let pct = |sorted: &[f32], p: f32| {
        (!sorted.is_empty()).then(|| sorted[((sorted.len() - 1) as f32 * p).round() as usize])
    };
    CalibrationResult {
        options: report
            .sims
            .iter()
            .map(|sim| CalOption {
                name: sim.name,
                quiet_target: sim.quiet_target,
                on_db: sim.on_db,
                off_db: sim.off_db,
                voicing: sim.voicing.unwrap_or(0.0),
                note: sim.note.clone(),
                segments: SEGMENTS
                    .iter()
                    .zip(&sim.per_segment)
                    .map(|(seg, r)| CalSegmentResult {
                        label: seg.label,
                        target: sim.is_target(seg),
                        reacted: r.reacted(),
                        starts: r.starts,
                        recall: r.recall.map(|v| v * 100.0),
                    })
                    .collect(),
            })
            .collect(),
        stats: report
            .stats
            .iter()
            .map(|s| CalSegmentStats {
                label: s.label,
                median_db: pct(&s.env_db, 0.5),
                p99_db: pct(&s.env_db, 0.99),
                voiced_ratio: s.voiced_ratio,
            })
            .collect(),
        wav,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_separates_manifest_from_images() {
        let d = std::env::temp_dir().join(format!("cv-watch-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("parts")).unwrap();
        std::fs::write(d.join("avatar.json"), "{}").unwrap();
        std::fs::write(d.join("parts").join("a.png"), "x").unwrap();
        let a = avatar_fingerprint(&d);

        std::fs::write(d.join("avatar.json"), "{\"rig\":{}}").unwrap();
        let b = avatar_fingerprint(&d);
        assert_ne!(a.manifest, b.manifest);
        assert_eq!(
            a.images, b.images,
            "avatar.json だけの変更は画像の変更にしない"
        );

        // 1 段下のフォルダの画像の上書き
        std::fs::write(d.join("parts").join("a.png"), "xy").unwrap();
        let c = avatar_fingerprint(&d);
        assert_ne!(b.images, c.images);
        assert_eq!(b.manifest, c.manifest);
        let _ = std::fs::remove_dir_all(&d);
    }
}
