//! キャリブレーション WAV に対して判定パラメータを総当たりし、成績を一覧にする（調整用）。
//!
//! 実行: cargo run --release --example sweep -- calibration.wav

use cv_engine::calibration::{SEGMENTS, SETTLE_SECS};
use cv_engine::detector::{DetectorConfig, Transition};
use cv_engine::dsp::db_to_lin;
use cv_engine::pipeline::{Pipeline, PipelineConfig};
use cv_engine::pitch::VoicingConfig;

struct Outcome {
    /// 雑音区間（無音・呼吸・タイプ音）での発話開始回数
    false_starts: u32,
    /// 声の区間での発話中の割合
    quiet_ratio: f32,
    normal_ratio: f32,
    /// 音量がしきい値を超えてから発話開始と判定されるまでの遅れ（ms, 中央値と最大）
    delay_p50: f32,
    delay_max: f32,
}

fn run(samples: &[f32], sr: f32, cfg: &PipelineConfig) -> Outcome {
    let mut p = Pipeline::new(cfg, sr);
    let on_lin = db_to_lin(cfg.detector.on_db);
    let bounds: Vec<(f32, f32, bool, &str)> = {
        let mut t = 0.0;
        SEGMENTS
            .iter()
            .map(|s| {
                let r = (t + SETTLE_SECS, t + s.secs - 0.3, s.is_speech, s.key);
                t += s.secs;
                r
            })
            .collect()
    };
    let mut false_starts = 0;
    let mut speak = [0usize; 2];
    let mut total = [0usize; 2];
    let mut delays = vec![];
    let mut loud_since: Option<usize> = None;

    for (i, &x) in samples.iter().enumerate() {
        let tr = p.process(x);
        let t = i as f32 / sr;
        if p.envelope() >= on_lin {
            loud_since.get_or_insert(i);
        } else {
            loud_since = None;
        }
        let Some(&(_, _, is_speech, key)) = bounds.iter().find(|b| t >= b.0 && t < b.1) else { continue };
        if tr == Some(Transition::SpeechStart) {
            if is_speech {
                if let Some(s) = loud_since {
                    delays.push((i - s) as f32 / sr * 1000.0);
                }
            } else {
                false_starts += 1;
            }
        }
        if is_speech {
            let k = (key == "normal") as usize;
            total[k] += 1;
            speak[k] += p.is_speaking() as usize;
        }
    }
    delays.sort_by(f32::total_cmp);
    Outcome {
        false_starts,
        quiet_ratio: speak[0] as f32 / total[0].max(1) as f32,
        normal_ratio: speak[1] as f32 / total[1].max(1) as f32,
        delay_p50: delays.get(delays.len() / 2).copied().unwrap_or(f32::NAN),
        delay_max: delays.last().copied().unwrap_or(f32::NAN),
    }
}

fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| "calibration.wav".into());
    let mut r = hound::WavReader::open(&path)?;
    let spec = r.spec();
    let sr = spec.sample_rate as f32;
    let samples: Vec<f32> = r.samples::<f32>().step_by(spec.channels as usize).collect::<Result<_, _>>()?;

    // --detail <enter> <confirm> <on_db>: その設定で、雑音区間での発話開始の時刻を表示する
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 6 && args[2] == "--detail" {
        let (enter, confirm, on_db): (f32, u32, f32) = (args[3].parse()?, args[4].parse()?, args[5].parse()?);
        let cfg = PipelineConfig {
            detector: DetectorConfig { on_db, off_db: on_db - 8.0, ..Default::default() },
            hpf_hz: 80.0,
            voicing: Some(VoicingConfig { enter, exit: enter - 0.15, confirm_hops: confirm, ..Default::default() }),
        };
        let mut p = Pipeline::new(&cfg, sr);
        let mut start = None;
        for (i, &x) in samples.iter().enumerate() {
            match p.process(x) {
                Some(Transition::SpeechStart) => start = Some(i),
                Some(Transition::SpeechEnd) => {
                    let s = start.take().unwrap_or(i);
                    let (ts, te) = (s as f32 / sr, i as f32 / sr);
                    let mut acc = 0.0;
                    let seg = SEGMENTS.iter().find(|g| { acc += g.secs; ts < acc }).map_or("?", |g| g.label);
                    if !matches!(seg, "小声" | "普段の声") {
                        println!("{seg}: {ts:.3}s 〜 {te:.3}s（{:.0}ms）", (te - ts) * 1000.0);
                    }
                }
                None => {}
            }
        }
        return Ok(());
    }

    println!("enter confirm  on_db | 誤反応  小声%  普段%  遅れms(中央/最大)");
    for &enter in &[0.6f32, 0.7, 0.75, 0.8, 0.85, 0.9] {
        for &confirm in &[3u32, 4, 6] {
            for &on_db in &[-45.0f32, -40.0, -36.0, -32.0] {
                let cfg = PipelineConfig {
                    detector: DetectorConfig { on_db, off_db: on_db - 8.0, ..Default::default() },
                    hpf_hz: 80.0,
                    voicing: Some(VoicingConfig { enter, exit: enter - 0.15, confirm_hops: confirm, ..Default::default() }),
                };
                let o = run(&samples, sr, &cfg);
                println!(
                    "{enter:5.2} {confirm:7} {on_db:6.0} | {:6} {:6.1} {:6.1}   {:5.1} / {:5.1}",
                    o.false_starts,
                    o.quiet_ratio * 100.0,
                    o.normal_ratio * 100.0,
                    o.delay_p50,
                    o.delay_max
                );
            }
        }
    }
    Ok(())
}
