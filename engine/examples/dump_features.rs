//! WAV を判定処理に通し、2.5ms ごとの特徴量を CSV に書き出す（調整用）。
//!
//! 実行: cargo run --release --example dump_features -- <入力.wav> <出力.csv>

use std::io::Write as _;

use cv_engine::dsp::lin_to_db;
use cv_engine::pipeline::{Pipeline, PipelineConfig};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(
        args.len() == 3,
        "使い方: dump_features <入力.wav> <出力.csv>"
    );
    let mut r = hound::WavReader::open(&args[1])?;
    let spec = r.spec();
    let sr = spec.sample_rate as f32;
    let samples: Vec<f32> = r
        .samples::<f32>()
        .step_by(spec.channels as usize)
        .collect::<Result<_, _>>()?;

    let mut p = Pipeline::new(&PipelineConfig::default(), sr);
    let hop = (sr / 400.0) as usize;
    let mut out = std::io::BufWriter::new(std::fs::File::create(&args[2])?);
    writeln!(out, "t,env_db,score,voiced,speaking")?;
    for (i, &x) in samples.iter().enumerate() {
        p.process(x);
        if i % hop == 0 {
            writeln!(
                out,
                "{:.4},{:.2},{:.3},{},{}",
                i as f32 / sr,
                lin_to_db(p.envelope()),
                p.voicing_score(),
                p.is_voiced() as u8,
                p.is_speaking() as u8
            )?;
        }
    }
    Ok(())
}
