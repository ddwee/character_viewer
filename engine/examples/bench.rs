//! 判定処理の CPU 負荷を測る。WAV を 1 本の判定処理に通し、実時間に対する処理時間の割合を出す。
//!
//! 実行: cargo run --release --example bench -- calibration.wav

use std::time::Instant;

use cv_engine::detector::DetectorConfig;
use cv_engine::pipeline::{Pipeline, PipelineConfig};
use cv_engine::pitch::VoicingConfig;

fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| "calibration.wav".into());
    let mut r = hound::WavReader::open(&path)?;
    let spec = r.spec();
    let sr = spec.sample_rate as f32;
    let samples: Vec<f32> = r.samples::<f32>().step_by(spec.channels as usize).collect::<Result<_, _>>()?;
    let secs = samples.len() as f64 / sr as f64;

    let configs = [
        ("A: 小声にも反応 (-32dB)", -32.0, Some(0.75)),
        ("B: 普段の声だけ (-24dB)", -24.0, Some(0.75)),
        ("声らしさ判定なし", -32.0, None),
    ];
    for (name, on_db, voicing) in configs {
        let cfg = PipelineConfig {
            detector: DetectorConfig { on_db, off_db: on_db - 8.0, ..Default::default() },
            hpf_hz: 80.0,
            voicing: voicing.map(|enter| VoicingConfig { enter, exit: enter - 0.15, ..Default::default() }),
        };
        let mut best = f64::MAX;
        for _ in 0..5 {
            let mut p = Pipeline::new(&cfg, sr);
            let t = Instant::now();
            let mut n = 0u32;
            for &x in &samples {
                n += p.process(x).is_some() as u32;
            }
            std::hint::black_box(n);
            best = best.min(t.elapsed().as_secs_f64());
        }
        println!(
            "{name:<24} {secs:.0} 秒の音声を {:.0} ms で処理 → CPU 1 コアの {:.2}%",
            best * 1000.0,
            best / secs * 100.0
        );
    }
    Ok(())
}
