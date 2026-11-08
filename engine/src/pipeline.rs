//! 1 チャンネル分の判定処理一式: ハイパス → 有声判定 → 発話検出。
//! リアルタイム処理・キャリブレーション・録音ファイルの解析で同じものを使う。

use crate::detector::{Detector, DetectorConfig, Transition};
use crate::dsp::Biquad;
use crate::pitch::{Voicing, VoicingConfig};

#[derive(Clone, Copy, Debug)]
pub struct PipelineConfig {
    pub detector: DetectorConfig,
    /// ハイパスのカットオフ（Hz）。0 以下で無効
    pub hpf_hz: f32,
    /// None なら有声判定を使わず音量だけで判定する
    pub voicing: Option<VoicingConfig>,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            detector: DetectorConfig::default(),
            hpf_hz: 80.0,
            voicing: Some(VoicingConfig::default()),
        }
    }
}

pub struct Pipeline {
    hpf: Biquad,
    voicing: Option<Voicing>,
    detector: Detector,
}

impl Pipeline {
    pub fn new(cfg: &PipelineConfig, sample_rate: f32) -> Self {
        let hpf = if cfg.hpf_hz > 0.0 {
            Biquad::highpass(cfg.hpf_hz, sample_rate, std::f32::consts::FRAC_1_SQRT_2)
        } else {
            Biquad::identity()
        };
        Self {
            hpf,
            voicing: cfg.voicing.map(|v| Voicing::new(v, sample_rate)),
            detector: Detector::new(cfg.detector, sample_rate),
        }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> Option<Transition> {
        let y = self.hpf.process(x);
        let voiced = match &mut self.voicing {
            Some(v) => v.process(y),
            None => true,
        };
        self.detector.process(y.abs(), voiced)
    }

    /// 音量エンベロープ（線形）
    pub fn envelope(&self) -> f32 {
        self.detector.envelope()
    }

    /// 声らしさ（0〜1）。有声判定なしなら 1
    pub fn voicing_score(&self) -> f32 {
        self.voicing.as_ref().map_or(1.0, |v| v.score())
    }

    pub fn is_voiced(&self) -> bool {
        self.voicing.as_ref().is_none_or(|v| v.is_voiced())
    }

    pub fn is_speaking(&self) -> bool {
        self.detector.is_speaking()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pitch::tests::{clicks, noise, voice_like, with_floor};

    fn starts(sig: &[f32], sr: f32, cfg: &PipelineConfig) -> Vec<usize> {
        let sig = with_floor(sig);
        let mut p = Pipeline::new(cfg, sr);
        sig.iter()
            .enumerate()
            .filter_map(|(i, &x)| (p.process(x) == Some(Transition::SpeechStart)).then_some(i))
            .collect()
    }

    #[test]
    fn loud_breath_and_typing_do_not_trigger() {
        let cfg = PipelineConfig::default();
        for sr in [48_000.0, 192_000.0] {
            for seed in 1..=3 {
                let s = starts(&noise(0.2, sr as usize * 5, seed), sr, &cfg);
                assert!(
                    s.is_empty(),
                    "sr={sr} 息（-14dBFS 相当の雑音）: {} 回反応",
                    s.len()
                );
            }
            let s = starts(&clicks(0.5, sr as usize * 5, sr), sr, &cfg);
            assert!(s.is_empty(), "sr={sr} タイプ音: {} 回反応", s.len());
        }
    }

    #[test]
    fn voice_onset_latency() {
        for sr in [48_000.0f32, 192_000.0] {
            for f0 in [100.0, 200.0, 350.0] {
                let mut sig = vec![0.0; sr as usize / 2];
                let onset = sig.len();
                sig.extend(voice_like(f0, 0.05, sr as usize / 2, sr));
                let s = starts(&sig, sr, &PipelineConfig::default());
                assert_eq!(s.len(), 1, "f0={f0}");
                let ms = (s[0] - onset) as f32 / sr * 1000.0;
                println!("sr={sr} f0={f0}: 検出まで {ms:.1}ms");
                assert!(ms < 25.0, "sr={sr} f0={f0}: 検出まで {ms}ms");
            }
        }
    }
}
