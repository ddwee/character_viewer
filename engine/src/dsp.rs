//! 軽量な信号処理部品。オーディオコールバック内で使うため、確保・ロック・重い処理はしない。

/// 2次のバイクアッドフィルタ（RBJ Audio EQ Cookbook, Transposed Direct Form II）。
#[derive(Clone, Copy, Debug)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn normalized(b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) -> Self {
        Self { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, z1: 0.0, z2: 0.0 }
    }

    fn params(cutoff_hz: f32, sample_rate: f32, q: f32) -> (f32, f32) {
        let w0 = 2.0 * std::f32::consts::PI * (cutoff_hz / sample_rate);
        let (sin_w0, cos_w0) = w0.sin_cos();
        (cos_w0, sin_w0 / (2.0 * q))
    }

    /// ハイパス。コンデンサーマイクが拾う低域ノイズ（空調・机の振動・ハム）を除く。
    pub fn highpass(cutoff_hz: f32, sample_rate: f32, q: f32) -> Self {
        let (c, alpha) = Self::params(cutoff_hz, sample_rate, q);
        Self::normalized((1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }

    /// ローパス。
    pub fn lowpass(cutoff_hz: f32, sample_rate: f32, q: f32) -> Self {
        let (c, alpha) = Self::params(cutoff_hz, sample_rate, q);
        Self::normalized((1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }

    /// 素通し。
    pub fn identity() -> Self {
        Self { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0, z1: 0.0, z2: 0.0 }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// 線形振幅を dBFS に変換する（0 は下限値に丸める）。
#[inline]
pub fn lin_to_db(x: f32) -> f32 {
    20.0 * x.max(1e-6).log10()
}

#[inline]
pub fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn steady_peak(mut f: Biquad, freq: f32, sr: f32) -> f32 {
        let mut peak = 0.0f32;
        for n in 0..(sr as usize) {
            let x = (2.0 * std::f32::consts::PI * freq * n as f32 / sr).sin();
            let y = f.process(x);
            if n > sr as usize / 2 {
                peak = peak.max(y.abs());
            }
        }
        peak
    }

    #[test]
    fn highpass_cuts_rumble_keeps_voice() {
        let sr = 48_000.0;
        let hp = Biquad::highpass(80.0, sr, std::f32::consts::FRAC_1_SQRT_2);
        assert!(steady_peak(hp, 20.0, sr) < 0.1, "20Hz は十分に減衰する");
        assert!(steady_peak(hp, 1_000.0, sr) > 0.98, "1kHz（声の帯域）は通る");
    }

    #[test]
    fn lowpass_at_high_sample_rate() {
        let sr = 192_000.0;
        let lp = Biquad::lowpass(1_500.0, sr, std::f32::consts::FRAC_1_SQRT_2);
        assert!(steady_peak(lp, 200.0, sr) > 0.98);
        assert!(steady_peak(lp, 12_000.0, sr) < 0.03);
    }

    #[test]
    fn db_roundtrip() {
        for db in [-60.0f32, -40.0, -6.0, 0.0] {
            assert!((lin_to_db(db_to_lin(db)) - db).abs() < 1e-3);
        }
    }
}
