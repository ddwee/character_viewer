//! コマンド版のエンジン（普段はアプリ cv-app を使う。こちらはトラブル時の確認・開発用）。
//!
//! - 引数なし      : アプリと同じくエンジンを動かし、ログをこの画面に出す（設定画面も使える）
//! - --list        : 入力デバイスの一覧
//! - --analyze     : キャリブレーション録音（WAV）を解析し直す
//! - --measure-av  : OBS の録画から声と絵のずれを測る

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::Result;
use clap::Parser;
use cv_engine::settings::{Settings, data_dir};
use cv_engine::{audio, calibration, devices, logging, recording, service};

#[derive(Parser, Debug)]
#[command(version, about = "character_viewer の音声エンジン（コマンド版）")]
struct Args {
    /// 入力デバイスの一覧を表示して終了する
    #[arg(long)]
    list: bool,

    /// 録音済みのキャリブレーション WAV を解析する
    #[arg(long, value_name = "WAV")]
    analyze: Option<PathBuf>,

    /// OBS の録画（?sync の四角を映したもの）から、声と絵のずれを測る
    #[arg(long, value_name = "VIDEO")]
    measure_av: Option<PathBuf>,

    /// --measure-av で使う録画の音声トラック（1 始まり）
    #[arg(long, default_value_t = 1)]
    audio_track: usize,

    /// 以下は設定画面の値を一時的に上書きする（保存はしない）
    /// 入力デバイス（名前・名前の一部・一覧の番号）
    #[arg(short, long)]
    device: Option<String>,

    /// 判定に使う入力チャンネル（1 始まり）
    #[arg(short, long)]
    channel: Option<usize>,

    /// 発話開始のしきい値（dBFS）
    #[arg(long, allow_negative_numbers = true)]
    on_db: Option<f32>,

    /// 発話終了のしきい値（dBFS）
    #[arg(long, allow_negative_numbers = true)]
    off_db: Option<f32>,

    /// 声らしさのしきい値（0 で無効）
    #[arg(long)]
    voicing: Option<f32>,

    /// ポート
    #[arg(long)]
    port: Option<u16>,

    /// 指定秒数で自動終了する（測定用）
    #[arg(long)]
    seconds: Option<f32>,
}

fn main() -> Result<()> {
    let args = Args::parse();

    if args.list {
        println!("入力デバイス一覧");
        for d in devices::list()? {
            println!(
                "  {:>2}. {}{}",
                d.index,
                d.name,
                if d.is_default { " ← 既定" } else { "" }
            );
            println!(
                "      {}ch / {}Hz / {}",
                d.channels, d.sample_rate, d.format
            );
        }
        return Ok(());
    }

    if let Some(path) = &args.analyze {
        let (settings, _) = Settings::load(&cv_engine::settings::settings_path());
        let (samples, sr) = audio::read_wav(path)?;
        println!(
            "{} を解析します（{:.1} 秒, {} Hz）\n",
            path.display(),
            samples.len() as f32 / sr,
            sr
        );
        println!(
            "{}",
            calibration::analyze(&samples, sr, &settings.pipeline_config())
        );
        return Ok(());
    }

    if let Some(path) = &args.measure_av {
        println!(
            "{} を解析します（映像と音声トラック {} を読み込み中…）",
            path.display(),
            args.audio_track
        );
        let started = Instant::now();
        let report = recording::measure(path, args.audio_track)?;
        println!(
            "（{:.1} 秒かかりました）\n",
            started.elapsed().as_secs_f32()
        );
        println!("{report}");
        let a = recording::advice(&report);
        println!("判定: {}", a.verdict);
        for d in a.details {
            println!("  ・{d}");
        }
        return Ok(());
    }

    logging::init(Some(data_dir().join("logs")), true);
    let seconds = args.seconds;
    let a = args;
    let service = service::start(service::Options {
        camera_window: None,
        root: None,
        app_exe: None,
        quit: None,
        overrides: Some(Box::new(move |s: &mut Settings| {
            if let Some(v) = a.device {
                s.audio.device = Some(v);
            }
            if let Some(v) = a.channel {
                s.audio.channel = v;
            }
            if let Some(v) = a.on_db {
                s.audio.on_db = v;
            }
            if let Some(v) = a.off_db {
                s.audio.off_db = v;
            }
            if let Some(v) = a.voicing {
                s.audio.voicing = v;
            }
            if let Some(v) = a.port {
                s.server.port = v;
            }
        })),
    })?;
    println!(
        "設定画面: {}   OBS 用: {}",
        service.settings_url(),
        service.obs_url()
    );
    println!("Ctrl+C で終了します。\n");

    let running = Arc::new(AtomicBool::new(true));
    {
        let running = running.clone();
        ctrlc::set_handler(move || running.store(false, Ordering::SeqCst))?;
    }
    let deadline = seconds.map(|s| Instant::now() + Duration::from_secs_f32(s));
    while running.load(Ordering::SeqCst) && deadline.is_none_or(|d| Instant::now() < d) {
        std::thread::sleep(Duration::from_millis(50));
    }
    service.runtime.shutdown();
    let lat = service.runtime.status().latency;
    println!("\n── 測定結果 ──");
    println!("音 → 判定（検出遅延）     : {}", lat.detect.text());
    println!("判定 → 描画フレーム       : {}", lat.display.text());
    println!("音 → 描画フレーム（合計） : {}", lat.total.text());
    Ok(())
}
