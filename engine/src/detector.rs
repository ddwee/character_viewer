//! 発話検出器。1 サンプルごとに呼ばれ、発話開始・終了の瞬間を返す。
//!
//! - 立ち上がりは即座に反応する（エンベロープの attack は 1ms 程度）
//! - しきい値は ON と OFF を別にする（ヒステリシス）ことで境界付近のパタパタを防ぐ
//! - OFF 側は「しきい値を下回った状態が hold_ms 続いたら」終了にする。単語の切れ目で絵が戻らない
//! - 開始・継続ともに「声らしい（有声）」ことを条件にする。息やタイプ音では開始せず、
//!   話し終わった後のタイプ音で発話状態が延長されることもない

use crate::dsp::db_to_lin;

#[derive(Clone, Copy, Debug)]
pub struct DetectorConfig {
    /// これを上回ったら発話開始（dBFS, エンベロープ値）
    pub on_db: f32,
    /// これを下回った状態が hold_ms 続いたら発話終了（dBFS）
    pub off_db: f32,
    pub hold_ms: f32,
    /// エンベロープの立ち上がり時定数
    pub attack_ms: f32,
    /// エンベロープの減衰時定数
    pub release_ms: f32,
}

impl Default for DetectorConfig {
    fn default() -> Self {
        Self { on_db: -42.0, off_db: -50.0, hold_ms: 250.0, attack_ms: 1.0, release_ms: 40.0 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transition {
    SpeechStart,
    SpeechEnd,
}

#[derive(Clone, Debug)]
pub struct Detector {
    on_lin: f32,
    off_lin: f32,
    hold_samples: u32,
    attack_coef: f32,
    release_coef: f32,
    env: f32,
    speaking: bool,
    below_count: u32,
}

fn one_pole_coef(time_ms: f32, sample_rate: f32) -> f32 {
    if time_ms <= 0.0 {
        0.0
    } else {
        (-1.0 / (time_ms * 0.001 * sample_rate)).exp()
    }
}

impl Detector {
    pub fn new(cfg: DetectorConfig, sample_rate: f32) -> Self {
        assert!(cfg.off_db <= cfg.on_db, "off_db は on_db 以下にしてください");
        Self {
            on_lin: db_to_lin(cfg.on_db),
            off_lin: db_to_lin(cfg.off_db),
            hold_samples: (cfg.hold_ms * 0.001 * sample_rate).round() as u32,
            attack_coef: one_pole_coef(cfg.attack_ms, sample_rate),
            release_coef: one_pole_coef(cfg.release_ms, sample_rate),
            env: 0.0,
            speaking: false,
            below_count: 0,
        }
    }

    /// `level` は整流済み（>= 0）の振幅、`voiced` は有声判定の結果。
    #[inline]
    pub fn process(&mut self, level: f32, voiced: bool) -> Option<Transition> {
        let coef = if level > self.env { self.attack_coef } else { self.release_coef };
        self.env = coef * self.env + (1.0 - coef) * level;

        if !self.speaking {
            if voiced && self.env >= self.on_lin {
                self.speaking = true;
                self.below_count = 0;
                return Some(Transition::SpeechStart);
            }
        } else if voiced && self.env >= self.off_lin {
            self.below_count = 0;
        } else {
            self.below_count += 1;
            if self.below_count >= self.hold_samples {
                self.speaking = false;
                return Some(Transition::SpeechEnd);
            }
        }
        None
    }

    pub fn envelope(&self) -> f32 {
        self.env
    }

    pub fn is_speaking(&self) -> bool {
        self.speaking
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    /// 振幅 amp の 200Hz 正弦波を n サンプル流し、遷移とその位置を集める
    fn feed(det: &mut Detector, amp: f32, n: usize, offset: usize, out: &mut Vec<(usize, Transition)>) {
        for i in 0..n {
            let t = (offset + i) as f32 / SR;
            let x = amp * (2.0 * std::f32::consts::PI * 200.0 * t).sin();
            if let Some(tr) = det.process(x.abs(), true) {
                out.push((offset + i, tr));
            }
        }
    }

    #[test]
    fn silence_never_triggers() {
        let mut det = Detector::new(DetectorConfig::default(), SR);
        let mut ev = vec![];
        feed(&mut det, 0.0, 48_000, 0, &mut ev);
        assert!(ev.is_empty());
    }

    #[test]
    fn onset_is_fast() {
        let mut det = Detector::new(DetectorConfig::default(), SR);
        let mut ev = vec![];
        feed(&mut det, 0.1, 4_800, 0, &mut ev); // -20dBFS の声
        let (pos, tr) = ev[0];
        assert_eq!(tr, Transition::SpeechStart);
        let ms = pos as f32 / SR * 1000.0;
        assert!(ms < 3.0, "立ち上がり検出は 3ms 以内であるべき: {ms}ms");
    }

    #[test]
    fn short_gap_keeps_speaking_long_gap_ends() {
        let cfg = DetectorConfig::default();
        let mut det = Detector::new(cfg, SR);
        let mut ev = vec![];
        let mut off = 0;
        feed(&mut det, 0.1, 9_600, off, &mut ev);
        off += 9_600;
        // 100ms の息継ぎ（hold 250ms より短い）
        feed(&mut det, 0.0, 4_800, off, &mut ev);
        off += 4_800;
        feed(&mut det, 0.1, 9_600, off, &mut ev);
        off += 9_600;
        assert_eq!(ev.len(), 1, "短い切れ目では終了しない: {ev:?}");

        // 1 秒の無音
        let silence_start = off;
        feed(&mut det, 0.0, 48_000, off, &mut ev);
        assert_eq!(ev.len(), 2);
        let (pos, tr) = ev[1];
        assert_eq!(tr, Transition::SpeechEnd);
        let ms = (pos - silence_start) as f32 / SR * 1000.0;
        assert!(ms >= cfg.hold_ms && ms < cfg.hold_ms + 300.0, "終了は hold 経過後: {ms}ms");
    }

    #[test]
    fn hysteresis_ignores_level_between_thresholds() {
        let cfg = DetectorConfig::default(); // ON -42, OFF -50
        let mut det = Detector::new(cfg, SR);
        let mut ev = vec![];
        // ピーク -40dBFS の正弦波 → エンベロープは ON を超える
        feed(&mut det, db_to_lin(-36.0), 9_600, 0, &mut ev);
        assert_eq!(ev.len(), 1);
        // ON と OFF の間（約 -46dB）に下がっても終了しない
        feed(&mut det, db_to_lin(-42.0), 48_000, 9_600, &mut ev);
        assert_eq!(ev.len(), 1, "ヒステリシス範囲では状態を保つ: {ev:?}");
    }
}

#[cfg(test)]
mod voicing_gate_tests {
    use super::*;

    #[test]
    fn unvoiced_never_starts_and_does_not_extend() {
        let mut det = Detector::new(DetectorConfig::default(), 48_000.0);
        for _ in 0..48_000 {
            assert_eq!(det.process(0.3, false), None, "大きくても無声なら開始しない");
        }
        assert_eq!(det.process(0.3, true), Some(Transition::SpeechStart));
        // 話し終わった後に大きな無声音（タイプ音）が続いても、hold 経過で終了する
        let mut ended = None;
        for i in 0..48_000 {
            if det.process(0.3, false) == Some(Transition::SpeechEnd) {
                ended = Some(i);
                break;
            }
        }
        let ms = ended.expect("終了するべき") as f32 / 48.0;
        assert!((249.0..=251.0).contains(&ms), "{ms}ms");
    }
}
