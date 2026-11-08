//! 有声判定（声帯振動による周期性があるか）。
//!
//! 声（母音・有声子音）は基本周波数をもつ周期的な波形になるが、
//! 息を吸う・吐く音やキーのタイプ音は周期性のない雑音になる。
//! この違いを NSDF（McLeod Pitch Method の正規化自己相関）で調べ、音量だけでは区別できない雑音を除外する。
//! NSDF は比べる 2 つの区間のエネルギー差にも罰則がかかるため、タイプ音のような減衰する短い音に強い。
//!
//! 処理の流れ: ローパス(1.5kHz) → 約 8kHz に間引き → 2.5ms ごとに直近 10ms の NSDF を計算

use crate::dsp::Biquad;

#[derive(Clone, Copy, Debug)]
pub struct VoicingConfig {
    /// NSDF がこれ以上なら「声らしい」（0〜1）
    pub enter: f32,
    /// 有声状態のとき、これを下回ったら無声に戻る
    pub exit: f32,
    /// 想定する声の高さの下限・上限（Hz）
    pub f0_min: f32,
    pub f0_max: f32,
    /// 有声と確定するまでに連続して enter を超える必要がある判定回数（1 回 = 2.5ms）
    pub confirm_hops: u32,
}

impl Default for VoicingConfig {
    fn default() -> Self {
        Self { enter: 0.6, exit: 0.45, f0_min: 70.0, f0_max: 600.0, confirm_hops: 3 }
    }
}

const TARGET_RATE: f32 = 8_000.0;
const WINDOW_MS: f32 = 10.0;
const HOP_MS: f32 = 2.5;
const LPF_HZ: f32 = 1_500.0;

pub struct Voicing {
    cfg: VoicingConfig,
    lp: [Biquad; 2],
    factor: u32,
    phase: u32,
    ring: Vec<f32>,
    scratch: Vec<f32>,
    pos: usize,
    filled: usize,
    window: usize,
    tau_min: usize,
    tau_max: usize,
    hop: usize,
    since_hop: usize,
    score: f32,
    voiced: bool,
    run: u32,
}

impl Voicing {
    pub fn new(cfg: VoicingConfig, sample_rate: f32) -> Self {
        let factor = (sample_rate / TARGET_RATE).floor().max(1.0) as u32;
        let rate = sample_rate / factor as f32;
        let window = (WINDOW_MS * 0.001 * rate).round() as usize;
        let tau_min = (rate / cfg.f0_max).floor().max(2.0) as usize;
        let tau_max = (rate / cfg.f0_min).ceil() as usize;
        let hop = (HOP_MS * 0.001 * rate).round().max(1.0) as usize;
        let n = window + tau_max;
        let fc = LPF_HZ.min(rate * 0.4);
        // 2 段で 4 次バターワース
        let lp = [Biquad::lowpass(fc, sample_rate, 0.5412), Biquad::lowpass(fc, sample_rate, 1.3066)];
        Self {
            cfg,
            lp,
            factor,
            phase: 0,
            ring: vec![0.0; n],
            scratch: vec![0.0; n],
            pos: 0,
            filled: 0,
            window,
            tau_min,
            tau_max,
            hop,
            since_hop: 0,
            score: 0.0,
            voiced: false,
            run: 0,
        }
    }

    /// 1 サンプル入力し、現在の有声状態を返す。
    #[inline]
    pub fn process(&mut self, x: f32) -> bool {
        let y0 = self.lp[0].process(x);
        let y = self.lp[1].process(y0);
        self.phase += 1;
        if self.phase < self.factor {
            return self.voiced;
        }
        self.phase = 0;

        let n = self.ring.len();
        self.ring[self.pos] = y;
        self.pos = (self.pos + 1) % n;
        self.filled = (self.filled + 1).min(n);
        self.since_hop += 1;
        if self.since_hop < self.hop || self.filled < n {
            return self.voiced;
        }
        self.since_hop = 0;

        self.score = self.nsdf_max();
        if self.voiced {
            if self.score < self.cfg.exit {
                self.voiced = false;
                self.run = 0;
            }
        } else if self.score >= self.cfg.enter {
            self.run += 1;
            if self.run >= self.cfg.confirm_hops {
                self.voiced = true;
            }
        } else {
            self.run = 0;
        }
        self.voiced
    }

    /// 直近の窓と、tau だけ過去の窓との NSDF の最大値。
    /// NSDF(tau) = 2Σ x_t·x_{t-tau} / Σ (x_t² + x_{t-tau}²)
    fn nsdf_max(&mut self) -> f32 {
        let n = self.ring.len();
        let head = n - self.pos;
        self.scratch[..head].copy_from_slice(&self.ring[self.pos..]);
        self.scratch[head..].copy_from_slice(&self.ring[..self.pos]);
        let x = &self.scratch;

        let cur = &x[n - self.window..];
        let e_cur: f32 = cur.iter().map(|v| v * v).sum();
        if e_cur < 1e-12 {
            return 0.0;
        }
        let mut best = 0.0f32;
        for tau in self.tau_min..=self.tau_max {
            let past = &x[n - self.window - tau..n - tau];
            let (mut num, mut e_past) = (0.0f32, 0.0f32);
            for (c, p) in cur.iter().zip(past) {
                num += c * p;
                e_past += p * p;
            }
            let denom = e_cur + e_past;
            if denom > 0.0 {
                best = best.max(2.0 * num / denom);
            }
        }
        best
    }

    /// 直近の声らしさ（0〜1）
    pub fn score(&self) -> f32 {
        self.score
    }

    pub fn is_voiced(&self) -> bool {
        self.voiced
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// 倍音を含む声に近い信号
    pub fn voice_like(f0: f32, amp: f32, n: usize, sr: f32) -> Vec<f32> {
        (0..n)
            .map(|i| {
                let t = i as f32 / sr;
                (1..=6)
                    .map(|k| (2.0 * std::f32::consts::PI * f0 * k as f32 * t).sin() / k as f32)
                    .sum::<f32>()
                    * amp
                    * 0.5
            })
            .collect()
    }

    /// 決定的な白色雑音（息の音の代わり）
    pub fn noise(amp: f32, n: usize, seed: u32) -> Vec<f32> {
        let mut s = seed;
        (0..n)
            .map(|_| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((s >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0) * amp
            })
            .collect()
    }

    /// タイプ音の代わり: 120ms ごとのクリック（減衰する高域の鳴き + 低域の打撃）
    pub fn clicks(amp: f32, n: usize, sr: f32) -> Vec<f32> {
        let period = (0.12 * sr) as usize;
        let rnd = noise(1.0, n, 7);
        (0..n)
            .map(|i| {
                let t = (i % period) as f32 / sr;
                let decay = (-t / 0.003).exp();
                amp * decay * (0.6 * rnd[i] + 0.4 * (2.0 * std::f32::consts::PI * 3_000.0 * t).sin())
            })
            .collect()
    }

    /// 実測した無音時の雑音（約 -65dBFS）を重ねる
    pub fn with_floor(sig: &[f32]) -> Vec<f32> {
        let floor = noise(crate::dsp::db_to_lin(-62.0), sig.len(), 99);
        sig.iter().zip(&floor).map(|(a, b)| a + b).collect()
    }

    fn voiced_ratio(sig: &[f32], sr: f32) -> f32 {
        let sig = with_floor(sig);
        let mut v = Voicing::new(VoicingConfig::default(), sr);
        let skip = (0.05 * sr) as usize;
        let mut voiced = 0;
        for (i, &x) in sig.iter().enumerate() {
            if v.process(x) && i >= skip {
                voiced += 1;
            }
        }
        voiced as f32 / (sig.len() - skip) as f32
    }

    #[test]
    fn voice_is_voiced_at_various_pitches_and_rates() {
        for sr in [48_000.0, 96_000.0, 192_000.0] {
            for f0 in [90.0, 150.0, 250.0, 450.0] {
                let r = voiced_ratio(&voice_like(f0, 0.1, sr as usize / 2, sr), sr);
                assert!(r > 0.95, "f0={f0} sr={sr}: 有声率 {r}");
            }
        }
    }

    #[test]
    fn breath_and_typing_are_not_voiced() {
        for sr in [48_000.0, 192_000.0] {
            let r = voiced_ratio(&noise(0.1, sr as usize * 2, 1), sr);
            assert!(r < 0.005, "sr={sr} 雑音の有声率 {r}");
            let r = voiced_ratio(&clicks(0.3, sr as usize * 2, sr), sr);
            assert!(r < 0.005, "sr={sr} クリックの有声率 {r}");
        }
    }
}
