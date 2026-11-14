//! キャリブレーション: 決まった手順で録音した音声を区間ごとに分析し、しきい値を提案する。
//!
//! 1. 区間ごとに「音量」と「声らしさ」の分布を集計する
//! 2. 「声らしさの基準 × 音量しきい値」の候補をすべて実際に判定へ通す（並列）
//! 3. 雑音（無音・呼吸・タイプ音）での誤反応が少なく、声をよく捉える設定を選ぶ

use std::fmt;

use crate::detector::Transition;
use crate::dsp::lin_to_db;
use crate::pipeline::{Pipeline, PipelineConfig};
use crate::pitch::VoicingConfig;

pub struct Segment {
    pub key: &'static str,
    pub label: &'static str,
    pub prompt: &'static str,
    pub secs: f32,
    pub is_speech: bool,
}

/// 録音手順。区間の切り替え直後は動作が追いつかないため SETTLE_SECS だけ集計から除く
pub const SEGMENTS: &[Segment] = &[
    Segment {
        key: "silence",
        label: "無音",
        prompt: "何もせず、静かにしていてください",
        secs: 6.0,
        is_speech: false,
    },
    Segment {
        key: "breath",
        label: "呼吸",
        prompt: "マイクの前で、息を吸ったり吐いたりしてください（少し大きめに）",
        secs: 8.0,
        is_speech: false,
    },
    Segment {
        key: "typing",
        label: "タイプ音",
        prompt: "キーボードを普段どおりタイプしてください",
        secs: 8.0,
        is_speech: false,
    },
    Segment {
        key: "quiet",
        label: "小声",
        prompt: "小声で話してください（独り言くらいの声）",
        secs: 8.0,
        is_speech: true,
    },
    Segment {
        key: "normal",
        label: "普段の声",
        prompt: "配信のときの普段の声で話してください",
        secs: 8.0,
        is_speech: true,
    },
];
pub const SETTLE_SECS: f32 = 1.0;
const TAIL_SECS: f32 = 0.3;

/// 特徴量を記録する間隔（2.5ms）
const HOPS_PER_SEC: f32 = 400.0;
/// 「はっきり声」とみなす声らしさと、無音の上限からの音量差
const CLEAR_VOICE_SCORE: f32 = 0.9;
const CLEAR_VOICE_MARGIN_DB: f32 = 12.0;

/// 探索する「声らしさ」の基準と音量しきい値
const ENTER_GRID: &[f32] = &[0.6, 0.7, 0.75, 0.8, 0.85];
const ON_DB_MIN: f32 = -50.0;
const ON_DB_MAX: f32 = -24.0;
const ON_DB_STEP: f32 = 2.0;
/// 反応してはいけない区間での反応 1 回を、声の捕捉率何ポイント分の損とみなすか。
/// ゲーム中はキーボードを常に使うため重めにしている
const FALSE_PENALTY: f32 = 10.0;

pub fn total_secs() -> f32 {
    SEGMENTS.iter().map(|s| s.secs).sum()
}

/// 区間 i の集計対象範囲（サンプル番号）
fn segment_range(i: usize, sr: f32) -> (usize, usize) {
    let start: f32 = SEGMENTS[..i].iter().map(|s| s.secs).sum();
    let end = start + SEGMENTS[i].secs;
    (
        ((start + SETTLE_SECS) * sr) as usize,
        ((end - TAIL_SECS) * sr) as usize,
    )
}

fn percentile(sorted: &[f32], p: f32) -> Option<f32> {
    if sorted.is_empty() {
        return None;
    }
    let idx = ((sorted.len() - 1) as f32 * p).round() as usize;
    Some(sorted[idx])
}

pub struct SegmentStats {
    pub label: &'static str,
    pub key: &'static str,
    /// 音量エンベロープ（dBFS）の分布（昇順）
    pub env_db: Vec<f32>,
    /// 有声と判定された時点の音量の分布（昇順）
    pub voiced_env_db: Vec<f32>,
    pub voiced_ratio: f32,
}

impl SegmentStats {
    fn env(&self, p: f32) -> Option<f32> {
        percentile(&self.env_db, p)
    }
    fn voiced_env(&self, p: f32) -> Option<f32> {
        percentile(&self.voiced_env_db, p)
    }
}

/// ある設定で判定したときの、1 区間の結果
#[derive(Clone, Copy, Debug, Default)]
pub struct SegmentResult {
    /// 発話開始の回数
    pub starts: u32,
    /// 発話中だった時間の割合（0〜1）
    pub speaking: f32,
    /// 「はっきり声」の瞬間のうち発話中にできた割合（0〜1）。声の区間のみ
    pub recall: Option<f32>,
}

impl SegmentResult {
    /// その区間で反応したか（新たに発話開始したか、前の区間から発話が続いていたか）
    pub fn reacted(&self) -> bool {
        self.starts > 0 || self.speaking > 0.02
    }
}

pub struct Simulation {
    pub name: &'static str,
    pub on_db: f32,
    pub off_db: f32,
    /// 声らしさの基準（None なら声らしさ判定なし）
    pub voicing: Option<f32>,
    pub note: Option<String>,
    /// 小声にも反応させたい設定か
    pub quiet_target: bool,
    pub per_segment: Vec<SegmentResult>,
}

impl Simulation {
    /// この設定で反応すべき区間か
    pub fn is_target(&self, seg: &Segment) -> bool {
        seg.is_speech && (seg.key != "quiet" || self.quiet_target)
    }
}

pub struct Report {
    pub stats: Vec<SegmentStats>,
    pub sims: Vec<Simulation>,
    pub base: PipelineConfig,
}

/// 基準設定で 1 回通して、区間ごとの統計と「はっきり声」の瞬間（2.5ms 単位）を求める
fn collect_stats(
    samples: &[f32],
    sr: f32,
    base: &PipelineConfig,
) -> (Vec<SegmentStats>, Vec<bool>) {
    let hop = (sr / HOPS_PER_SEC) as usize;
    let mut p = Pipeline::new(base, sr);
    // (サンプル番号, 音量 dB, 有声, 声らしさ)
    let mut frames = Vec::with_capacity(samples.len() / hop + 1);
    for (i, &x) in samples.iter().enumerate() {
        p.process(x);
        if i % hop == 0 {
            frames.push((i, lin_to_db(p.envelope()), p.is_voiced(), p.voicing_score()));
        }
    }

    let stats: Vec<SegmentStats> = SEGMENTS
        .iter()
        .enumerate()
        .map(|(si, seg)| {
            let (a, b) = segment_range(si, sr);
            let in_seg: Vec<_> = frames.iter().filter(|f| (a..b).contains(&f.0)).collect();
            let mut env_db: Vec<f32> = in_seg.iter().map(|f| f.1).collect();
            let mut voiced_env_db: Vec<f32> = in_seg.iter().filter(|f| f.2).map(|f| f.1).collect();
            env_db.sort_by(f32::total_cmp);
            voiced_env_db.sort_by(f32::total_cmp);
            let voiced_ratio = if in_seg.is_empty() {
                0.0
            } else {
                voiced_env_db.len() as f32 / in_seg.len() as f32
            };
            SegmentStats {
                label: seg.label,
                key: seg.key,
                env_db,
                voiced_env_db,
                voiced_ratio,
            }
        })
        .collect();

    let silence_top = silence_top(&stats);
    let clear = frames
        .iter()
        .map(|f| f.3 >= CLEAR_VOICE_SCORE && f.1 >= silence_top + CLEAR_VOICE_MARGIN_DB)
        .collect();
    (stats, clear)
}

fn silence_top(stats: &[SegmentStats]) -> f32 {
    stats
        .iter()
        .find(|s| s.key == "silence")
        .and_then(|s| s.env(0.99))
        .unwrap_or(-70.0)
}

fn simulate(samples: &[f32], sr: f32, cfg: &PipelineConfig, clear: &[bool]) -> Vec<SegmentResult> {
    let hop = (sr / HOPS_PER_SEC) as usize;
    let mut p = Pipeline::new(cfg, sr);
    let ranges: Vec<_> = (0..SEGMENTS.len()).map(|i| segment_range(i, sr)).collect();
    // 区間ごとの（開始回数, 発話中サンプル数, はっきり声の数, そのうち発話中の数）
    let mut acc = vec![(0u32, 0usize, 0usize, 0usize); SEGMENTS.len()];
    let mut si = 0;
    for (i, &x) in samples.iter().enumerate() {
        let tr = p.process(x);
        while si < ranges.len() && i >= ranges[si].1 {
            si += 1;
        }
        if si >= ranges.len() || i < ranges[si].0 {
            continue;
        }
        let a = &mut acc[si];
        if tr == Some(Transition::SpeechStart) {
            a.0 += 1;
        }
        let speaking = p.is_speaking();
        a.1 += speaking as usize;
        if i % hop == 0 && clear.get(i / hop).copied().unwrap_or(false) {
            a.2 += 1;
            a.3 += speaking as usize;
        }
    }
    acc.iter()
        .zip(&ranges)
        .zip(SEGMENTS)
        .map(
            |((&(starts, speaking, clear_n, clear_hit), &(a, b)), seg)| SegmentResult {
                starts,
                speaking: speaking as f32 / (b - a).max(1) as f32,
                recall: (seg.is_speech && clear_n >= 20).then(|| clear_hit as f32 / clear_n as f32),
            },
        )
        .collect()
}

fn round_db(db: f32) -> f32 {
    db.round().clamp(-70.0, -6.0)
}

struct Trial {
    enter: f32,
    on_db: f32,
    off_db: f32,
    per_segment: Vec<SegmentResult>,
}

impl Trial {
    fn segments(&self) -> impl Iterator<Item = (&Segment, &SegmentResult)> {
        SEGMENTS.iter().zip(&self.per_segment)
    }

    fn is_unwanted(seg: &Segment, quiet_target: bool) -> bool {
        !seg.is_speech || (!quiet_target && seg.key == "quiet")
    }

    /// 反応してはいけない区間での反応回数（前の区間からの持ち越しも 1 回と数える）
    fn unwanted(&self, quiet_target: bool) -> u32 {
        self.segments()
            .filter(|(s, _)| Self::is_unwanted(s, quiet_target))
            .map(|(_, r)| r.starts + (r.starts == 0 && r.reacted()) as u32)
            .sum()
    }

    fn recall(&self, key: &str) -> f32 {
        self.segments()
            .find(|(s, _)| s.key == key)
            .and_then(|(_, r)| r.recall)
            .unwrap_or(0.0)
            * 100.0
    }

    /// 小さいほど良い
    fn cost(&self, quiet_target: bool) -> f32 {
        let noise_time: f32 = self
            .segments()
            .filter(|(s, _)| Self::is_unwanted(s, quiet_target))
            .map(|(_, r)| r.speaking * 100.0)
            .sum();
        let gain = if quiet_target {
            0.6 * self.recall("quiet") + 0.4 * self.recall("normal")
        } else {
            self.recall("normal")
        };
        FALSE_PENALTY * self.unwanted(quiet_target) as f32 + noise_time - gain
    }
}

fn on_grid() -> impl Iterator<Item = f32> {
    let n = ((ON_DB_MAX - ON_DB_MIN) / ON_DB_STEP) as usize;
    (0..=n).map(|k| ON_DB_MIN + ON_DB_STEP * k as f32)
}

/// 候補の設定をすべて実際に判定へ通す（CPU コア数に合わせて並列実行）
fn run_trials(
    samples: &[f32],
    sr: f32,
    base: &PipelineConfig,
    clear: &[bool],
    silence_top: f32,
) -> Vec<Trial> {
    let combos: Vec<(f32, f32)> = match base.voicing {
        Some(_) => ENTER_GRID
            .iter()
            .flat_map(|&e| on_grid().map(move |on| (e, on)))
            .collect(),
        // 声らしさ判定が無効なら音量しきい値だけを探す
        None => on_grid().map(|on| (f32::NAN, on)).collect(),
    };
    let make = |&(enter, on): &(f32, f32)| {
        let mut cfg = *base;
        if let Some(v) = base.voicing {
            cfg.voicing = Some(VoicingConfig {
                enter,
                exit: (enter - 0.15).max(0.0),
                ..v
            });
        }
        let on_db = round_db(on);
        cfg.detector.on_db = on_db;
        cfg.detector.off_db = round_db((on_db - 8.0).max(silence_top + 3.0)).min(on_db);
        Trial {
            enter,
            on_db,
            off_db: cfg.detector.off_db,
            per_segment: simulate(samples, sr, &cfg, clear),
        }
    };

    let threads = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .min(combos.len());
    let chunk = combos.len().div_ceil(threads);
    std::thread::scope(|scope| {
        let handles: Vec<_> = combos
            .chunks(chunk)
            .map(|part| scope.spawn(move || part.iter().map(make).collect::<Vec<_>>()))
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().expect("解析スレッドが異常終了しました"))
            .collect()
    })
}

pub fn analyze(samples: &[f32], sr: f32, base: &PipelineConfig) -> Report {
    let (stats, clear) = collect_stats(samples, sr, base);
    let trials = run_trials(samples, sr, base, &clear, silence_top(&stats));

    let pick = |name: &'static str, quiet_target: bool| {
        let best = trials
            .iter()
            .min_by(|a, b| {
                a.cost(quiet_target)
                    .total_cmp(&b.cost(quiet_target))
                    // 同点なら声らしさの基準が低い方（検出が速い）
                    .then(a.enter.total_cmp(&b.enter))
            })
            .expect("候補が空です");
        let unwanted = best.unwanted(quiet_target);
        let note = (unwanted > 0).then(|| {
            format!("反応してほしくない区間で {unwanted} 回反応します（声に近い周期的な音が含まれている可能性があります）")
        });
        Simulation {
            name,
            on_db: best.on_db,
            off_db: best.off_db,
            voicing: (!best.enter.is_nan()).then_some(best.enter),
            note,
            quiet_target,
            per_segment: best.per_segment.clone(),
        }
    };
    let sims = vec![
        pick("A: 小声にも反応", true),
        pick("B: 普段の声だけに反応", false),
    ];
    Report {
        stats,
        sims,
        base: *base,
    }
}

fn fmt_db(v: Option<f32>) -> String {
    v.map_or("   -  ".into(), |d| format!("{d:6.1}"))
}

impl fmt::Display for Report {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "── 区間ごとの分析 ──")?;
        writeln!(
            f,
            "{:<8} {:>22}   {:>8}   {:>18}",
            "区間", "音量 dBFS (中央/90%/99%)", "声らしさ", "声の音量 (20%/80%)"
        )?;
        for s in &self.stats {
            writeln!(
                f,
                "{:<8} {} /{} /{}   {:>7.1}%   {} /{}",
                s.label,
                fmt_db(s.env(0.5)),
                fmt_db(s.env(0.9)),
                fmt_db(s.env(0.99)),
                s.voiced_ratio * 100.0,
                fmt_db(s.voiced_env(0.2)),
                fmt_db(s.voiced_env(0.8)),
            )?;
        }
        writeln!(f)?;
        writeln!(f, "── 推奨設定（実際に判定を通した結果）──")?;
        writeln!(
            f,
            "声の捕捉率 = はっきり声と分かる瞬間のうち、発話中と判定できた割合"
        )?;
        for sim in &self.sims {
            write!(
                f,
                "[{}]  --on-db {} --off-db {}",
                sim.name, sim.on_db, sim.off_db
            )?;
            match sim.voicing {
                Some(v) => writeln!(f, " --voicing {v}")?,
                None => writeln!(f)?,
            }
            if let Some(note) = &sim.note {
                writeln!(f, "    ※ {note}")?;
            }
            for (seg, r) in SEGMENTS.iter().zip(&sim.per_segment) {
                let verdict = match (sim.is_target(seg), r.reacted()) {
                    (false, false) | (true, true) => "◎",
                    (false, true) => "× 誤反応",
                    (true, false) => "× 無反応",
                };
                let recall = r.recall.map_or(String::new(), |v| {
                    format!("   声の捕捉率 {:>5.1}%", v * 100.0)
                });
                writeln!(
                    f,
                    "    {:<8} 反応 {:>3} 回   発話中 {:>5.1}%{recall}   {verdict}",
                    seg.label,
                    r.starts,
                    r.speaking * 100.0
                )?;
            }
        }
        if self.base.voicing.is_none() {
            writeln!(f, "\n（声らしさ判定は無効で分析しました）")?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::db_to_lin;
    use crate::pitch::tests::{clicks, noise, voice_like, with_floor};

    /// 手順どおりの合成録音: 無音 / 呼吸 / タイプ音 / 小声 / 普段の声
    fn synthetic(sr: f32) -> Vec<f32> {
        let mut out = vec![];
        for seg in SEGMENTS {
            let n = (seg.secs * sr) as usize;
            let part = match seg.key {
                "silence" => vec![0.0; n],
                "breath" => noise(db_to_lin(-30.0), n, 5),
                "typing" => clicks(db_to_lin(-15.0), n, sr),
                "quiet" => voice_like(160.0, db_to_lin(-38.0), n, sr),
                _ => voice_like(160.0, db_to_lin(-22.0), n, sr),
            };
            out.extend(part);
        }
        with_floor(&out)
    }

    #[test]
    fn recommends_thresholds_that_separate_noise_and_voice() {
        let sr = 48_000.0;
        let report = analyze(&synthetic(sr), sr, &PipelineConfig::default());
        println!("{report}");
        assert_eq!(report.sims.len(), 2);
        for sim in &report.sims {
            for (seg, r) in SEGMENTS.iter().zip(&sim.per_segment) {
                assert_eq!(
                    r.reacted(),
                    sim.is_target(seg),
                    "{} / {}: {r:?}",
                    sim.name,
                    seg.label
                );
            }
        }
    }
}
