//! 音声エンジン。
//! マイク入力を WASAPI（共有モード）で取り込んで発話を判定し、表示する絵の状態を
//! OBS のブラウザソース（描画ページ）へ WebSocket で通知する。
//!
//! - 通常モード  : リアルタイムで判定して描画ページへ通知し、遅延を測る
//! - --calibrate : 手順どおりに録音して、しきい値を提案する
//! - --analyze   : 録音済みの WAV を解析し直す
//! - --measure-av: OBS の録画から、声と絵の切り替えのずれを測る

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use clap::Parser;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, FromSample, InputCallbackInfo, Sample, SampleFormat, SizedSample, StreamConfig};
use cv_engine::av_sync::{self, VideoFrames};
use cv_engine::avatar::{AvatarConfig, AvatarMachine, AvatarState};
use cv_engine::calibration::{self, SEGMENTS};
use cv_engine::detector::{DetectorConfig, Transition};
use cv_engine::dsp::{Biquad, lin_to_db};
use cv_engine::pipeline::{Pipeline, PipelineConfig};
use cv_engine::pitch::VoicingConfig;
use cv_engine::server::{self, ClientEvent, Hub, MeterMsg, ServerConfig};

#[derive(Parser, Debug)]
#[command(version, about = "マイク入力から発話を検出します")]
struct Args {
    /// 入力デバイスの一覧を表示して終了する
    #[arg(long)]
    list: bool,

    /// 入力デバイス（一覧の番号、または名前の一部）。省略時は Windows の既定のマイク
    #[arg(short, long)]
    device: Option<String>,

    /// 判定に使う入力チャンネル（1 始まり）
    #[arg(short, long, default_value_t = 1)]
    channel: usize,

    /// 発話開始のしきい値（dBFS）。既定値は 2026-11-07 のキャリブレーション結果（小声にも反応）
    #[arg(long, default_value_t = -32.0, allow_negative_numbers = true)]
    on_db: f32,

    /// 発話終了のしきい値（dBFS）
    #[arg(long, default_value_t = -40.0, allow_negative_numbers = true)]
    off_db: f32,

    /// 声が途切れてから発話終了とみなすまでの時間（ms）
    #[arg(long, default_value_t = 250.0)]
    hold_ms: f32,

    /// ハイパスフィルタのカットオフ（Hz）。0 で無効
    #[arg(long, default_value_t = 80.0)]
    hpf_hz: f32,

    /// 声らしさ（周期性）のしきい値 0〜1。息やタイプ音を除外する。0 で無効（音量だけで判定）
    #[arg(long, default_value_t = 0.75)]
    voicing: f32,

    /// 要求するバッファサイズ（フレーム数）。省略時はドライバ既定
    #[arg(long)]
    buffer: Option<u32>,

    /// 指定秒数で自動終了する（測定用）
    #[arg(long)]
    seconds: Option<f32>,

    /// 無言がこの秒数続いたら「放置」の絵にする。0 で無効
    #[arg(long, default_value_t = 6.0)]
    away_secs: f32,

    /// 無言がこの秒数続いたら「寝落ち」の絵にする（無言の開始から数える）。0 で無効
    #[arg(long, default_value_t = 12.0)]
    sleep_secs: f32,

    /// 描画ページを配信するポート（OBS のブラウザソースに http://127.0.0.1:<port>/ を指定）
    #[arg(long, default_value_t = 39540)]
    port: u16,

    /// 描画ページのフォルダ。省略時は renderer/dist を自動で探す
    #[arg(long)]
    renderer_dir: Option<PathBuf>,

    /// イラスト素材のフォルダ（avatar.json と画像）。省略時は avatar を自動で探す
    #[arg(long)]
    avatar_dir: Option<PathBuf>,

    /// キャリブレーション: 画面の指示どおりに約 40 秒録音し、しきい値を提案する
    #[arg(long)]
    calibrate: bool,

    /// キャリブレーション録音の保存先
    #[arg(long, default_value = "calibration.wav")]
    out: PathBuf,

    /// 録音済みのキャリブレーション WAV を解析する
    #[arg(long, value_name = "WAV")]
    analyze: Option<PathBuf>,

    /// OBS の録画（?sync の四角を映したもの）から、声と絵の切り替えのずれを測る
    #[arg(long, value_name = "VIDEO")]
    measure_av: Option<PathBuf>,

    /// --measure-av で使う録画の音声トラック（1 始まり）
    #[arg(long, default_value_t = 1)]
    audio_track: usize,
}

impl Args {
    fn pipeline_config(&self) -> Result<PipelineConfig> {
        if self.off_db > self.on_db {
            bail!("--off-db は --on-db 以下にしてください");
        }
        Ok(PipelineConfig {
            detector: DetectorConfig {
                on_db: self.on_db,
                off_db: self.off_db,
                hold_ms: self.hold_ms,
                ..Default::default()
            },
            hpf_hz: self.hpf_hz,
            voicing: (self.voicing > 0.0).then(|| VoicingConfig {
                enter: self.voicing,
                exit: (self.voicing - 0.15).max(0.0),
                ..Default::default()
            }),
        })
    }

    fn avatar_config(&self) -> Result<AvatarConfig> {
        let secs = |s: f32| (s > 0.0).then(|| Duration::from_secs_f32(s));
        let cfg = AvatarConfig { away_after: secs(self.away_secs), sleep_after: secs(self.sleep_secs) };
        if let (Some(away), Some(sleep)) = (cfg.away_after, cfg.sleep_after)
            && sleep <= away
        {
            bail!("--sleep-secs は --away-secs より長くしてください（どちらも無言の開始から数えます）");
        }
        Ok(cfg)
    }

    fn server_config(&self) -> ServerConfig {
        ServerConfig {
            port: self.port,
            renderer_dir: self.renderer_dir.clone().unwrap_or_else(|| find_dir("renderer/dist")),
            avatar_dir: self.avatar_dir.clone().unwrap_or_else(|| find_dir("avatar")),
        }
    }
}

/// `rel` のフォルダを、カレントディレクトリと実行ファイルの場所から上へさかのぼって探す
fn find_dir(rel: &str) -> PathBuf {
    let bases = [std::env::current_dir().ok(), std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf))];
    bases
        .iter()
        .flatten()
        .flat_map(|base| base.ancestors())
        .map(|dir| dir.join(rel))
        .find(|p| p.is_dir())
        .unwrap_or_else(|| PathBuf::from(rel))
}

fn main() -> Result<()> {
    let args = Args::parse();
    let pcfg = args.pipeline_config()?;

    if let Some(path) = &args.analyze {
        let (samples, sr) = read_wav(path)?;
        println!("{} を解析します（{:.1} 秒, {} Hz）\n", path.display(), samples.len() as f32 / sr, sr);
        print_report(&samples, sr, &pcfg, args.channel);
        return Ok(());
    }

    if let Some(path) = &args.measure_av {
        return measure_av(path, args.audio_track);
    }

    let host = cpal::default_host();
    if args.list {
        return list_devices(&host);
    }

    let device = select_device(&host, args.device.as_deref())?;
    let supported = device.default_input_config().context("入力設定を取得できません")?;
    let format = supported.sample_format();
    let mut config: StreamConfig = supported.into();
    if let Some(frames) = args.buffer {
        config.buffer_size = BufferSize::Fixed(frames);
    }
    let channels = config.channels as usize;
    if args.channel == 0 || args.channel > channels {
        bail!("--channel は 1〜{channels} で指定してください");
    }

    println!("デバイス : {}（チャンネル {} / {}ch）", device_label(&device), args.channel, channels);
    println!("形式     : {}Hz / {:?}", config.sample_rate, format);

    if args.calibrate {
        return run_calibration(&device, config, format, &args, &pcfg);
    }

    println!(
        "判定     : ON > {} dBFS, OFF < {} dBFS, 保持 {} ms, HPF {} Hz, 声らしさ {}",
        args.on_db,
        args.off_db,
        args.hold_ms,
        args.hpf_hz,
        if args.voicing > 0.0 { format!("≥ {}", args.voicing) } else { "無効".into() }
    );
    let acfg = args.avatar_config()?;
    let fmt_secs = |d: Option<Duration>| d.map_or("無効".into(), |d| format!("{:.0} 秒", d.as_secs_f32()));
    println!("無言     : 放置 {} / 寝落ち {}", fmt_secs(acfg.away_after), fmt_secs(acfg.sleep_after));

    let scfg = args.server_config();
    if !scfg.renderer_dir.join("index.html").is_file() {
        println!("※ 描画ページが見つかりません（{}）。renderer フォルダで npm run build を実行してください", scfg.renderer_dir.display());
    }
    if !scfg.avatar_dir.join("avatar.json").is_file() {
        println!("※ イラスト素材が見つかりません（{}）", scfg.avatar_dir.join("avatar.json").display());
    }
    let (hub, events) = server::start(scfg, AvatarState::Idle)?;
    println!("描画     : http://127.0.0.1:{}/ を OBS のブラウザソースに指定（?debug で状態表示）", args.port);
    println!("Ctrl+C で終了します。\n");

    let (tx, rx) = rtrb::RingBuffer::<Msg>::new(4096);
    let proc = Processor {
        pipeline: Pipeline::new(&pcfg, config.sample_rate as f32),
        channel: args.channel - 1,
        channels,
        sample_rate: config.sample_rate as f32,
        tx,
        control: std::thread::current(),
    };
    let stream = build_any(&device, config, format, proc)?;
    stream.play()?;

    let running = Arc::new(AtomicBool::new(true));
    {
        let running = running.clone();
        ctrlc::set_handler(move || running.store(false, Ordering::SeqCst))?;
    }
    if let Some(secs) = args.seconds {
        let running = running.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs_f32(secs));
            running.store(false, Ordering::SeqCst);
        });
    }

    run_live(rx, &running, &args, acfg, &hub, &events);
    drop(stream);
    Ok(())
}

// ───────────────────────── デバイス ─────────────────────────

fn device_label(device: &cpal::Device) -> String {
    device
        .description()
        .map(|d| d.name().to_string())
        .or_else(|_| device.id().map(|id| id.to_string()))
        .unwrap_or_else(|_| "(名前不明)".into())
}

fn select_device(host: &cpal::Host, query: Option<&str>) -> Result<cpal::Device> {
    let Some(query) = query else {
        return host.default_input_device().context("既定の入力デバイスが見つかりません");
    };
    let devices: Vec<_> = host.input_devices()?.collect();
    if let Ok(n) = query.parse::<usize>() {
        return devices
            .into_iter()
            .nth(n.wrapping_sub(1))
            .with_context(|| format!("デバイス番号 {n} は存在しません（--list で確認）"));
    }
    let q = query.to_lowercase();
    let mut hits: Vec<_> = devices.into_iter().filter(|d| device_label(d).to_lowercase().contains(&q)).collect();
    match hits.len() {
        0 => bail!("\"{query}\" を含むデバイスがありません（--list で確認）"),
        1 => Ok(hits.remove(0)),
        _ => bail!("\"{query}\" に一致するデバイスが複数あります。番号で指定してください"),
    }
}

fn list_devices(host: &cpal::Host) -> Result<()> {
    let default_id = host.default_input_device().and_then(|d| d.id().ok());
    println!("入力デバイス一覧（ホスト: {}）", host.id().name());
    for (i, d) in host.input_devices()?.enumerate() {
        let mark = if d.id().ok() == default_id { " ← 既定" } else { "" };
        println!("  {:>2}. {}{}", i + 1, device_label(&d), mark);
        if let Ok(cfg) = d.default_input_config() {
            println!(
                "      {}ch / {}Hz / {:?} / バッファ {:?}",
                cfg.channels(),
                cfg.sample_rate(),
                cfg.sample_format(),
                cfg.buffer_size()
            );
        }
    }
    Ok(())
}

// ───────────────────────── ストリーム ─────────────────────────

/// オーディオコールバックで呼ばれる処理。コールバック中は確保もロックもしない。
trait Sink: Send + 'static {
    fn push<T>(&mut self, data: &[T], info: &InputCallbackInfo)
    where
        T: Sample,
        f32: FromSample<T>;
}

fn build<T, S: Sink>(device: &cpal::Device, config: StreamConfig, mut sink: S) -> Result<cpal::Stream>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    // 開始直後の 1 回は WASAPI が先頭パケットに不連続フラグを立てるだけなので無視する
    let mut startup = true;
    let stream = device.build_input_stream::<T, _, _>(
        config,
        move |data, info| sink.push(data, info),
        move |err: cpal::Error| {
            if startup && matches!(err.kind(), cpal::ErrorKind::Xrun) {
                startup = false;
                return;
            }
            eprintln!("\nストリームエラー: {err}");
        },
        None,
    )?;
    Ok(stream)
}

fn build_any<S: Sink>(device: &cpal::Device, config: StreamConfig, format: SampleFormat, sink: S) -> Result<cpal::Stream> {
    match format {
        SampleFormat::F32 => build::<f32, S>(device, config, sink),
        SampleFormat::I16 => build::<i16, S>(device, config, sink),
        SampleFormat::I32 => build::<i32, S>(device, config, sink),
        SampleFormat::U16 => build::<u16, S>(device, config, sink),
        SampleFormat::I8 => build::<i8, S>(device, config, sink),
        other => bail!("未対応のサンプル形式です: {other:?}"),
    }
}

/// 現在時刻を QPC（WASAPI のタイムスタンプと同じ時計）で返す
fn qpc_now() -> Duration {
    use windows_sys::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    let (mut count, mut freq) = (0i64, 0i64);
    // SAFETY: 出力用ポインタを渡すだけの Win32 API
    unsafe {
        QueryPerformanceCounter(&mut count);
        QueryPerformanceFrequency(&mut freq);
    }
    Duration::from_nanos((count as u128 * 1_000_000_000 / freq as u128) as u64)
}

// ───────────────────────── リアルタイム判定 ─────────────────────────

/// オーディオスレッド → 制御スレッドへ送るメッセージ（確保なしで送れるよう Copy 型）
#[derive(Clone, Copy, Debug)]
enum Msg {
    Meter { level_db: f32, env_db: f32, voicing: f32, voiced: bool, frames: u32 },
    /// `latency_us`: 音が入ってから判定までの遅延。`at`: 判定した時刻（QPC）
    Transition { kind: Transition, latency_us: u32, at: Duration },
}

struct Processor {
    pipeline: Pipeline,
    channel: usize,
    channels: usize,
    sample_rate: f32,
    tx: rtrb::Producer<Msg>,
    /// 発話の開始・終了をすぐ処理させるために起こす制御スレッド
    control: std::thread::Thread,
}

impl Sink for Processor {
    fn push<T>(&mut self, data: &[T], info: &InputCallbackInfo)
    where
        T: Sample,
        f32: FromSample<T>,
    {
        // cpal の callback 時刻はデバイス時計の位置なので、実時間は QPC で自前に取る
        let capture = Duration::from_nanos(info.timestamp().capture.as_nanos() as u64);
        let now = qpc_now();
        let cap_to_cb = now.saturating_sub(capture);
        let frames = data.len() / self.channels;
        let mut peak = 0.0f32;

        for (i, frame) in data.chunks_exact(self.channels).enumerate() {
            let x = frame[self.channel].to_sample::<f32>();
            peak = peak.max(x.abs());
            if let Some(kind) = self.pipeline.process(x) {
                // WASAPI の capture 時刻は実測上「パケットが揃った時刻」（≒末尾フレーム）を指す。
                // よって i 番目のフレームは、末尾までの (frames - i) / sr 秒だけ待たされている。
                // ※ ADC・USB 転送などハードウェア側の遅延（数 ms）はソフトからは測れないため含まない
                let wait = Duration::from_secs_f32((frames - i) as f32 / self.sample_rate);
                let latency = cap_to_cb + wait;
                let _ = self.tx.push(Msg::Transition { kind, latency_us: latency.as_micros() as u32, at: now });
                // 制御スレッドを待たせずに起こす（ロックも確保もしない）
                self.control.unpark();
            }
        }

        let _ = self.tx.push(Msg::Meter {
            level_db: lin_to_db(peak),
            env_db: lin_to_db(self.pipeline.envelope()),
            voicing: self.pipeline.voicing_score(),
            voiced: self.pipeline.is_voiced(),
            frames: frames as u32,
        });
    }
}

/// 統計（最小・平均・最大）
#[derive(Default)]
struct Stats {
    n: u32,
    sum: f64,
    min: f64,
    max: f64,
}

impl Stats {
    fn add(&mut self, v: f64) {
        if self.n == 0 {
            self.min = v;
            self.max = v;
        }
        self.n += 1;
        self.sum += v;
        self.min = self.min.min(v);
        self.max = self.max.max(v);
    }
    fn summary(&self) -> String {
        if self.n == 0 {
            return "データなし".into();
        }
        format!("平均 {:.1}ms / 最小 {:.1}ms / 最大 {:.1}ms（{}回）", self.sum / self.n as f64, self.min, self.max, self.n)
    }
}

const METER_MIN_DB: f32 = -70.0;
const METER_WIDTH: usize = 35;

/// 音量メーター。`marks` に (ON, OFF) しきい値を渡すと位置に `|` と `:` を表示する
fn meter_bar(db: f32, marks: Option<(f32, f32)>) -> String {
    let pos = |db: f32| (((db - METER_MIN_DB) / -METER_MIN_DB).clamp(0.0, 1.0) * METER_WIDTH as f32) as usize;
    let fill = pos(db);
    let (on, off) = marks.map_or((usize::MAX, usize::MAX), |(on, off)| (pos(on), pos(off)));
    (0..METER_WIDTH)
        .map(|i| match i {
            _ if i == on => '|',
            _ if i == off => ':',
            _ if i < fill => '#',
            _ => '-',
        })
        .collect()
}

/// 描画ページからの応答（ack）を待っている通知
struct Pending {
    seq: u64,
    sent: Instant,
    /// 判定してから通知するまで（ms）
    to_publish_ms: f64,
    /// 音が入ってから判定まで（ms）。発話開始のときだけ
    detect_ms: Option<f64>,
    line: String,
}

/// これより遅い応答は「応答なし」として扱う
const ACK_TIMEOUT: Duration = Duration::from_millis(300);

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// 状態の通知と遅延の集計
struct Live<'a> {
    hub: &'a Hub,
    out: std::io::Stdout,
    pending: Option<Pending>,
    /// 音が入ってから判定まで
    detect: Stats,
    /// 判定してから描画ページがそのフレームを描くまで
    display: Stats,
    /// 音が入ってから描画まで
    total: Stats,
}

impl Live<'_> {
    fn log(&mut self, line: &str) {
        let _ = write!(self.out, "\r{:<120}\r{line}\n", "");
    }

    fn publish(&mut self, state: AvatarState, line: String, detect_ms: Option<f64>, detected_at: Option<Duration>) {
        self.flush_pending(false);
        let to_publish_ms = detected_at.map_or(0.0, |at| ms(qpc_now().saturating_sub(at)));
        let seq = self.hub.publish_state(state);
        let p = Pending { seq, sent: Instant::now(), to_publish_ms, detect_ms, line };
        if self.hub.clients() == 0 {
            let detect = p.detect_ms.map_or(String::new(), |d| format!("検出 {d:4.1} ms   "));
            self.log(&format!("{}   {detect}（描画ページ未接続）", p.line));
        } else {
            self.pending = Some(p);
        }
    }

    fn on_ack(&mut self, seq: u64, at: Instant) {
        let Some(p) = self.pending.take_if(|p| p.seq == seq) else { return };
        let disp = p.to_publish_ms + ms(at.saturating_duration_since(p.sent));
        self.display.add(disp);
        let detail = match p.detect_ms {
            Some(d) => {
                self.total.add(d + disp);
                format!("検出 {d:4.1} + 表示 {disp:4.1} = 合計 {:5.1} ms", d + disp)
            }
            None => format!("表示 {disp:4.1} ms"),
        };
        self.log(&format!("{}   {detail}", p.line));
    }

    /// 応答を待たずに表示する。`timed_out_only` なら待ちすぎたものだけ
    fn flush_pending(&mut self, timed_out_only: bool) {
        if self.pending.as_ref().is_some_and(|p| !timed_out_only || p.sent.elapsed() >= ACK_TIMEOUT) {
            let p = self.pending.take().expect("直前に確認済み");
            let detect = p.detect_ms.map_or(String::new(), |d| format!("検出 {d:4.1} ms   "));
            self.log(&format!("{}   {detect}（描画ページの応答なし）", p.line));
        }
    }
}

fn run_live(
    mut rx: rtrb::Consumer<Msg>,
    running: &AtomicBool,
    args: &Args,
    acfg: AvatarConfig,
    hub: &Hub,
    events: &mpsc::Receiver<ClientEvent>,
) {
    let start = Instant::now();
    let mut machine = AvatarMachine::new(acfg, start.elapsed());
    let mut live =
        Live { hub, out: std::io::stdout(), pending: None, detect: Stats::default(), display: Stats::default(), total: Stats::default() };
    let mut speech_started: Option<Instant> = None;
    let mut last = (METER_MIN_DB, METER_MIN_DB, 0.0f32, false, 0u32);
    let mut last_draw = Instant::now() - Duration::from_secs(1);

    while running.load(Ordering::SeqCst) {
        while let Ok(msg) = rx.pop() {
            match msg {
                Msg::Meter { level_db, env_db, voicing, voiced, frames } => {
                    last = (level_db, env_db, voicing, voiced, frames);
                }
                Msg::Transition { kind, latency_us, at } => {
                    let now = start.elapsed();
                    let silent = machine.silent_for(now).unwrap_or_default();
                    let detect_ms = (kind == Transition::SpeechStart).then(|| latency_us as f64 / 1000.0);
                    if let Some(d) = detect_ms {
                        live.detect.add(d);
                    }
                    let Some(state) = machine.on_transition(kind, now) else { continue };
                    let t = now.as_secs_f64();
                    let line = match state {
                        AvatarState::Talk => {
                            speech_started = Some(Instant::now());
                            format!("[{t:8.3}s] ▶ 発話     （直前の無言 {:5.1}s）", silent.as_secs_f32())
                        }
                        _ => {
                            let dur = speech_started.take().map_or(0.0, |s| s.elapsed().as_secs_f32());
                            format!("[{t:8.3}s] ■ {}     （発話 {dur:5.2}s）  ", state.label())
                        }
                    };
                    live.publish(state, line, detect_ms, Some(at));
                }
            }
        }

        // 無言が続いたときの「放置」「寝落ち」
        let now = start.elapsed();
        if let Some(state) = machine.tick(now) {
            let silent = machine.silent_for(now).unwrap_or_default().as_secs_f32();
            let mark = if state == AvatarState::Sleep { "z" } else { "…" };
            let line = format!("[{:8.3}s] {mark} {}   （無言 {silent:5.1}s）  ", now.as_secs_f64(), state.label());
            live.publish(state, line, None, None);
        }

        while let Ok(event) = events.try_recv() {
            let t = start.elapsed().as_secs_f64();
            match event {
                ClientEvent::Ack { seq, at } => live.on_ack(seq, at),
                ClientEvent::Connected { clients } => live.log(&format!("[{t:8.3}s] + 描画ページが接続しました（{clients} 個）")),
                ClientEvent::Disconnected { clients } => live.log(&format!("[{t:8.3}s] - 描画ページが切断しました（{clients} 個）")),
            }
        }
        live.flush_pending(true);

        if last_draw.elapsed() >= Duration::from_millis(33) {
            last_draw = Instant::now();
            let (level_db, env_db, voicing, voiced, frames) = last;
            hub.publish_meter(MeterMsg { db: env_db, voicing, voiced });
            let state = match machine.silent_for(now) {
                None => "● 発話中        ".to_string(),
                Some(d) => format!("○ {:<4} {:5.1}s", machine.state().label(), d.as_secs_f32()),
            };
            let _ = write!(
                live.out,
                "\r[{}] {:6.1}dB (peak {:6.1})  声らしさ {:.2}{}  {}  描画 {}  buf {}f   ",
                meter_bar(env_db, Some((args.on_db, args.off_db))),
                env_db,
                level_db,
                voicing,
                if voiced { "♪" } else { " " },
                state,
                hub.clients(),
                frames,
            );
            let _ = live.out.flush();
        }
        // 発話の開始・終了ではオーディオスレッドがすぐ起こしてくれるので、普段は短く眠るだけ
        std::thread::park_timeout(Duration::from_millis(5));
    }

    live.flush_pending(false);
    println!("\n\n── 測定結果 ──");
    println!("音 → 判定（検出遅延）       : {}", live.detect.summary());
    println!("判定 → 描画フレーム         : {}", live.display.summary());
    println!("音 → 描画フレーム（合計）   : {}", live.total.summary());
    println!("※ ハードウェア（ADC・USB）と OBS の合成・出力にかかる時間は含みません");
}

// ───────────────────────── キャリブレーション ─────────────────────────

/// 指定チャンネルのサンプルをそのまま表示スレッドへ送る
struct Recorder {
    channel: usize,
    channels: usize,
    tx: rtrb::Producer<f32>,
}

impl Sink for Recorder {
    fn push<T>(&mut self, data: &[T], _info: &InputCallbackInfo)
    where
        T: Sample,
        f32: FromSample<T>,
    {
        for frame in data.chunks_exact(self.channels) {
            let _ = self.tx.push(frame[self.channel].to_sample::<f32>());
        }
    }
}

fn run_calibration(
    device: &cpal::Device,
    config: StreamConfig,
    format: SampleFormat,
    args: &Args,
    pcfg: &PipelineConfig,
) -> Result<()> {
    let sr = config.sample_rate as f32;
    let (tx, mut rx) = rtrb::RingBuffer::<f32>::new(sr as usize * 2);
    let recorder = Recorder { channel: args.channel - 1, channels: config.channels as usize, tx };

    println!("\n── キャリブレーション（約 {:.0} 秒）──", calibration::total_secs());
    println!("画面の指示に合わせて、次の順に音を出してください。");
    for (i, s) in SEGMENTS.iter().enumerate() {
        println!("  {}. {}（{:.0}秒）: {}", i + 1, s.label, s.secs, s.prompt);
    }
    println!();

    let stream = build_any(device, config, format, recorder)?;
    stream.play()?;
    let mut out = std::io::stdout();

    let countdown = Instant::now();
    while countdown.elapsed() < Duration::from_secs(3) {
        while rx.pop().is_ok() {}
        let _ = write!(out, "\r開始まで {:.0} 秒…", 3.0 - countdown.elapsed().as_secs_f32().floor());
        let _ = out.flush();
        std::thread::sleep(Duration::from_millis(20));
    }

    let total = (calibration::total_secs() * sr) as usize;
    let mut samples = Vec::with_capacity(total + sr as usize);
    // 表示用: 判定と同じハイパスを通したピーク（減衰付き）
    let mut hp = if pcfg.hpf_hz > 0.0 {
        Biquad::highpass(pcfg.hpf_hz, sr, std::f32::consts::FRAC_1_SQRT_2)
    } else {
        Biquad::identity()
    };
    let mut shown = 0.0f32;
    let mut seg_end = 0usize;
    for seg in SEGMENTS {
        seg_end += (seg.secs * sr) as usize;
        println!("\r{:<60}\n▶ {}: {}", "", seg.label, seg.prompt);
        while samples.len() < seg_end {
            let mut peak = 0.0f32;
            while let Ok(x) = rx.pop() {
                samples.push(x);
                peak = peak.max(hp.process(x).abs());
            }
            shown = peak.max(shown * 0.8);
            let peak = shown;
            let remain = seg_end.saturating_sub(samples.len()) as f32 / sr;
            let _ = write!(
                out,
                "\r  残り {remain:4.1} 秒   入力 [{}] {:6.1} dB   ",
                meter_bar(lin_to_db(peak), None),
                lin_to_db(peak)
            );
            let _ = out.flush();
            std::thread::sleep(Duration::from_millis(15));
        }
    }
    drop(stream);
    samples.truncate(total);
    println!("\n\n録音完了。");

    write_wav(&args.out, &samples, sr as u32)?;
    println!("録音を {} に保存しました（解析し直すときは --analyze で指定）\n", args.out.display());
    print_report(&samples, sr, pcfg, args.channel);
    Ok(())
}

fn print_report(samples: &[f32], sr: f32, pcfg: &PipelineConfig, channel: usize) {
    let report = calibration::analyze(samples, sr, pcfg);
    println!("{report}");
    if let Some(best) = report.sims.first() {
        let voicing = best.voicing.map_or(" --voicing 0".to_string(), |v| format!(" --voicing {v}"));
        println!(
            "例: .\\target\\release\\cv-engine.exe --channel {channel} --on-db {} --off-db {}{voicing}",
            best.on_db, best.off_db
        );
    }
}

fn write_wav(path: &Path, samples: &[f32], sr: u32) -> Result<()> {
    let spec = hound::WavSpec { channels: 1, sample_rate: sr, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
    let mut w = hound::WavWriter::create(path, spec).with_context(|| format!("{} を作成できません", path.display()))?;
    for &x in samples {
        w.write_sample(x)?;
    }
    w.finalize()?;
    Ok(())
}

fn read_wav(path: &Path) -> Result<(Vec<f32>, f32)> {
    let mut r = hound::WavReader::open(path).with_context(|| format!("{} を開けません", path.display()))?;
    let spec = r.spec();
    let ch = spec.channels as usize;
    let all: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().collect::<Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1u64 << (spec.bits_per_sample - 1)) as f32;
            r.samples::<i32>().map(|s| s.map(|v| v as f32 * scale)).collect::<Result<_, _>>()?
        }
    };
    // 複数チャンネルなら 1 チャンネル目を使う
    Ok((all.into_iter().step_by(ch).collect(), spec.sample_rate as f32))
}

// ───────────────────────── 録画での遅延測定 ─────────────────────────

/// 映像を縮小するサイズ（16:9。1920x1080 なら 1 セル 30x30 ピクセル）
const AV_WIDTH: usize = 64;
const AV_HEIGHT: usize = 36;

fn ffmpeg_command(name: &str) -> Result<std::process::Command> {
    let ok = std::process::Command::new(name).arg("-version").output().map(|o| o.status.success()).unwrap_or(false);
    if !ok {
        bail!("{name} が見つかりません。PowerShell で winget install Gyan.FFmpeg を実行してください（無料）");
    }
    let mut cmd = std::process::Command::new(name);
    cmd.args(["-v", "error", "-nostdin"]).stdin(std::process::Stdio::null());
    Ok(cmd)
}

/// 音声トラックをモノラル f32 で読む。戻り値は（サンプル, サンプルレート）。
/// 先頭のサンプルが録画の時刻 0 になるよう、足りない分は無音で埋める
fn decode_audio(path: &Path, track: usize) -> Result<(Vec<f32>, f32)> {
    let stream = format!("a:{}", track.saturating_sub(1));
    let mut probe = std::process::Command::new("ffprobe");
    probe.args(["-v", "error", "-select_streams", &stream, "-show_entries", "stream=sample_rate", "-of", "default=noprint_wrappers=1"]);
    let out = probe.arg(path).output().context("ffprobe を実行できません")?;
    let text = String::from_utf8_lossy(&out.stdout);
    let field = |key: &str| text.lines().find_map(|l| l.strip_prefix(key)?.strip_prefix('=').map(str::trim).map(str::to_string));
    let sr: f32 = field("sample_rate").and_then(|v| v.parse().ok()).with_context(|| format!("音声トラック {track} がありません"))?;

    let mut cmd = ffmpeg_command("ffmpeg")?;
    // ストリームの開始時刻の情報はエンコーダの先頭無音（AAC で約 21ms）を含むことがあり当てにならない。
    // デコードした音声そのものの時刻（-copyts）を使い、時刻 0 まで無音で埋めて映像と同じ時間軸にそろえる
    cmd.args(["-copyts", "-i"]).arg(path).args([
        "-map",
        &format!("0:{stream}"),
        "-af",
        "aresample=async=1:first_pts=0",
        "-ac",
        "1",
        "-c:a",
        "pcm_f32le",
        "-f",
        "f32le",
        "-",
    ]);
    let out = cmd.output().context("ffmpeg を実行できません")?;
    if !out.status.success() {
        bail!("音声を読めません: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    let samples = out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    Ok((samples, sr))
}

/// 映像を縮小グレースケールで読み、各フレームの表示時刻（元の録画の時刻）も取る
fn decode_video(path: &Path) -> Result<VideoFrames> {
    use std::io::{BufRead, Read};
    let mut cmd = ffmpeg_command("ffmpeg")?;
    // 時刻は showinfo が stderr に出す pts_time を使う（-copyts で元の時刻のまま）
    cmd.args(["-v", "info", "-nostats", "-copyts", "-i"]).arg(path).args([
        "-map",
        "0:v:0",
        "-vf",
        &format!("scale={AV_WIDTH}:{AV_HEIGHT}:flags=area,format=gray,showinfo"),
        "-fps_mode",
        "passthrough",
        "-f",
        "rawvideo",
        "-",
    ]);
    let mut child = cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().context("ffmpeg を実行できません")?;
    let stderr = child.stderr.take().expect("stderr はパイプにしてある");
    let times_thread = std::thread::spawn(move || {
        let mut times = vec![];
        let mut log = String::new();
        for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(rest) = line.split("pts_time:").nth(1) {
                if line.contains("showinfo") {
                    if let Some(t) = rest.split_whitespace().next().and_then(|v| v.parse::<f64>().ok()) {
                        times.push(t);
                    }
                }
            } else if line.contains("rror") {
                log.push_str(&line);
                log.push('\n');
            }
        }
        (times, log)
    });
    let mut luma = vec![];
    child.stdout.take().expect("stdout はパイプにしてある").read_to_end(&mut luma)?;
    let status = child.wait()?;
    let (times, log) = times_thread.join().expect("stderr の読み取りスレッド");
    if !status.success() {
        bail!("映像を読めません: {}", log.trim());
    }
    let frames = luma.len() / (AV_WIDTH * AV_HEIGHT);
    if frames != times.len() {
        bail!("映像のフレーム数（{frames}）と時刻の数（{}）が合いません", times.len());
    }
    Ok(VideoFrames { width: AV_WIDTH, height: AV_HEIGHT, times, luma })
}

fn measure_av(path: &Path, track: usize) -> Result<()> {
    println!("{} を解析します（映像と音声トラック {track} を読み込み中…）", path.display());
    let started = Instant::now();
    let (samples, sr) = decode_audio(path, track)?;
    let video = decode_video(path)?;
    println!(
        "読み込み完了（{:.1} 秒, 映像 {} フレーム, 音声 {} Hz, {:.1} 秒かかりました）\n",
        samples.len() as f64 / sr as f64,
        video.times.len(),
        sr,
        started.elapsed().as_secs_f32()
    );
    let report = av_sync::analyze(&video, &samples, sr, 0.0)?;
    println!("{report}");

    print_av_advice(&report);
    Ok(())
}

/// 測定結果から、OBS での調整方法を案内する。
/// 目安は ITU-R BT.1359: 音が映像より 45ms 以上先だと気づかれやすく、音が後なら 125ms までは気づかれにくい
fn print_av_advice(report: &av_sync::AvReport) {
    let median = report.median_ms();
    let (p10, p90) = report.spread_ms();
    let round5 = |v: f64| ((v / 5.0).round() * 5.0) as i32;
    println!();
    if median >= 0.0 {
        println!("判定: 絵が声より {median:.0} ms 遅れています（声が先に聞こえる）。");
        if median <= 20.0 {
            println!("  1 フレーム程度のずれなので、調整は不要です。");
        } else {
            println!("  ぴったり揃えるには、マイクの音声を {} ms 遅らせます。", round5(median));
            println!("  OBS の音声ミキサーでマイクの「⋮」→「オーディオの詳細プロパティ」→「同期オフセット」に");
            println!("  今の値 + {} ms を入れてください。", round5(median));
        }
    } else {
        let lead = -median;
        println!("判定: 絵が声より {lead:.0} ms 早く出ています（録画の中で声のほうが遅れている）。");
        println!("  マイクのノイズ除去などのフィルタは処理に時間がかかり、録画の音声だけが遅れます。");
        println!("  OBS はその遅れを補正しないので、絵のほうが先になります。");
        if lead <= 125.0 {
            println!("  この向きのずれは 125 ms までは視聴者にほぼ気づかれないので、このままで問題ありません。");
        } else {
            println!("  この向きでも {lead:.0} ms は気づかれやすい大きさです。");
        }
        println!("  ぴったり揃えたいときは、測定用ではない描画のブラウザソースに「フィルタ」→「レンダリング遅延」を");
        println!("  追加して {} ms にします（絵を声に合わせて遅らせる）。マイクの同期オフセットは増やさないでください。", round5(lead));
    }
    if p90 - p10 > 60.0 {
        println!();
        println!("※ 回ごとのばらつきが大きめです（10〜90% で {p10:.0}〜{p90:.0} ms）。");
        println!("  声がゆっくり大きくなる出だしでは、エンジンのしきい値（--on-db）を超えるまでに時間がかかります。");
        println!("  「あっ」「たっ」のように、はっきり区切って声を出すと安定して測れます。");
    }
}
