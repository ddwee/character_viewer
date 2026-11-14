//! OBS の録画から「声」と「絵の切り替え」のずれ（視聴者が見る遅延）を測る。
//!
//! 録画には、描画ページを `?sync` で開いたブラウザソース（発話中は白、それ以外は黒の四角）を
//! 映しておく。映像からその四角が白になった時刻を、音声から声の立ち上がりを探し、差を取る。
//!
//! 映像・音声のデコード（ffmpeg）は呼び出し側が行い、ここは純粋な解析だけを持つ。

use std::fmt;

/// 縮小したグレースケールの映像フレーム列
pub struct VideoFrames {
    pub width: usize,
    pub height: usize,
    /// 各フレームの表示時刻（秒）
    pub times: Vec<f64>,
    /// フレームごとの輝度（width * height バイト × フレーム数）
    pub luma: Vec<u8>,
}

impl VideoFrames {
    fn cells(&self) -> usize {
        self.width * self.height
    }

    fn len(&self) -> usize {
        self.times.len()
    }

    fn frame(&self, i: usize) -> &[u8] {
        &self.luma[i * self.cells()..(i + 1) * self.cells()]
    }
}

/// 声が始まってから絵が切り替わるまでの 1 回ぶん
#[derive(Clone, Copy, Debug)]
pub struct Event {
    /// 声の立ち上がり（秒）
    pub voice_at: f64,
    /// 絵が切り替わったフレーム（秒）
    pub picture_at: f64,
}

impl Event {
    /// ずれ（ms）。正なら絵が声より遅れている
    pub fn offset_ms(&self) -> f64 {
        (self.picture_at - self.voice_at) * 1000.0
    }
}

pub struct AvReport {
    pub fps: f64,
    /// 測定用の四角が見つかったセルの数（全 `width * height` 中）
    pub marker_cells: usize,
    /// 声の大きさと直前の雑音の差（dB, 各回の中央値）
    pub snr_db: f32,
    pub events: Vec<Event>,
    /// 絵は切り替わったが、直前に声が見つからなかった回数（誤反応・録音レベル不足）
    pub unmatched: usize,
}

#[derive(Debug, PartialEq)]
pub enum AvError {
    /// 録画に測定用の四角が映っていない
    NoMarker,
    /// 四角が白になった回数が少なすぎる
    TooFewChanges(usize),
    /// 声と対応づけられた回数が少なすぎる
    TooFewMatches(usize),
}

impl fmt::Display for AvError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoMarker => write!(
                f,
                "録画に測定用の四角（?sync のブラウザソース）が見つかりません。白黒が切り替わる様子が録画に映っているか確認してください"
            ),
            Self::TooFewChanges(n) => write!(f, "四角が白になった回数が {n} 回しかありません。短く区切って 10 回以上声を出してください"),
            Self::TooFewMatches(n) => write!(
                f,
                "声と絵の切り替えを対応づけられたのが {n} 回だけでした。録画の音声トラックにマイクが入っているか確認してください"
            ),
        }
    }
}

impl std::error::Error for AvError {}

/// 四角とみなす明暗の差（0〜255）
const MARKER_MIN_RANGE: u8 = 150;
/// 声の立ち上がり: その回の声のピークからこれだけ下（dB）を超えた瞬間
const ONSET_BELOW_PEAK_DB: f32 = 15.0;
/// 立ち上がりは、直前の雑音よりこれだけ大きい（dB）
const ONSET_ABOVE_FLOOR_DB: f32 = 10.0;
/// 立ち上がりの前に必要な静かな時間（ms）
const QUIET_BEFORE_MS: usize = 30;
/// 切り替えの前後で声を探す範囲（ms）。前は遅延、後ろは録画の音声が遅れている場合
const SEARCH_BEFORE_MS: usize = 600;
const PEAK_BEFORE_MS: usize = 300;
const PEAK_AFTER_MS: usize = 250;
/// 直前の雑音を測る範囲（切り替えの何 ms 前から何 ms 前まで）
const FLOOR_FROM_MS: usize = 800;
const FLOOR_TO_MS: usize = 350;
const MIN_EVENTS: usize = 5;

/// 映像から、四角が白になった時刻の一覧を返す
pub fn picture_rises(video: &VideoFrames) -> Result<(Vec<f64>, usize), AvError> {
    let n = video.len();
    let cells = video.cells();
    if n < 2 {
        return Err(AvError::NoMarker);
    }
    let mut lo = vec![u8::MAX; cells];
    let mut hi = vec![0u8; cells];
    for i in 0..n {
        for (c, &v) in video.frame(i).iter().enumerate() {
            lo[c] = lo[c].min(v);
            hi[c] = hi[c].max(v);
        }
    }
    // 明暗の差が大きく、ほぼ 2 値（暗いか明るいか）のセルが四角の候補
    let candidates: Vec<usize> = (0..cells)
        .filter(|&c| hi[c].saturating_sub(lo[c]) >= MARKER_MIN_RANGE)
        .filter(|&c| {
            let (l, h) = (lo[c] as i32, hi[c] as i32);
            let margin = (h - l) / 4;
            let two_level = (0..n).filter(|&i| {
                let v = video.frame(i)[c] as i32;
                v <= l + margin || v >= h - margin
            });
            two_level.count() * 10 >= n * 9
        })
        .collect();
    // 各セルの明暗をビット列にする
    let words = n.div_ceil(64);
    let bits: Vec<Vec<u64>> = candidates
        .iter()
        .map(|&c| {
            let mut b = vec![0u64; words];
            for i in 0..n {
                if video.frame(i)[c] as i32 * 2 > lo[c] as i32 + hi[c] as i32 {
                    b[i / 64] |= 1 << (i % 64);
                }
            }
            b
        })
        .collect();
    let rises_of = |b: &[u64]| (1..n).filter(|&i| bit(b, i) && !bit(b, i - 1)).count();
    // 何度も白黒を繰り返すセルのうち、互いにほぼ同じタイミングで切り替わる最大の集まりを四角とみなす
    // （背景にたまたま白黒の部分があっても、四角と同じタイミングでは変わらない）
    let flipping: Vec<usize> = (0..candidates.len()).filter(|&k| rises_of(&bits[k]) >= MIN_EVENTS).collect();
    let tolerance = (n / 50).max(2) as u32;
    let agree = |a: usize, b: usize| bits[a].iter().zip(&bits[b]).map(|(x, y)| (x ^ y).count_ones()).sum::<u32>() <= tolerance;
    let best = flipping
        .iter()
        .map(|&a| flipping.iter().copied().filter(|&b| agree(a, b)).collect::<Vec<_>>())
        .max_by_key(Vec::len)
        .ok_or(AvError::NoMarker)?;

    // 四角のセルの多数決で明暗を決める
    let bright = |i: usize| best.iter().filter(|&&k| bit(&bits[k], i)).count() * 2 > best.len();
    let mut rises = vec![];
    let mut prev = bright(0);
    for i in 1..n {
        let b = bright(i);
        if b && !prev {
            rises.push(video.times[i]);
        }
        prev = b;
    }
    Ok((rises, best.len()))
}

fn bit(b: &[u64], i: usize) -> bool {
    b[i / 64] >> (i % 64) & 1 == 1
}

/// 音声の 1ms ごとのピーク（dBFS）
fn level_per_ms(samples: &[f32], sr: f32) -> Vec<f32> {
    let block = ((sr / 1000.0).round() as usize).max(1);
    samples.chunks(block).map(|b| crate::dsp::lin_to_db(b.iter().fold(0.0f32, |m, x| m.max(x.abs())))).collect()
}

/// 絵の切り替え（`pic` 秒）の前後で、声の立ち上がりを探す。
/// 録画全体ではなく、その回の声の大きさと直前の雑音から基準を決めるので、
/// 雑音が途中で変わったり、ノイズ除去・コンプレッサーで音量が変わっていても揃って測れる。
/// 戻り値は（立ち上がりの時刻, 声と雑音の差 dB）
fn onset_near(level: &[f32], start: f64, pic: f64) -> Option<(f64, f32)> {
    let i = ((pic - start) * 1000.0).round();
    if i < (FLOOR_FROM_MS as f64) || i + PEAK_AFTER_MS as f64 >= level.len() as f64 {
        return None;
    }
    let i = i as usize;
    let (pk, peak) = level[i - PEAK_BEFORE_MS..i + PEAK_AFTER_MS]
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map(|(k, &v)| (i - PEAK_BEFORE_MS + k, v))?;
    let mut before = level[i - FLOOR_FROM_MS..i - FLOOR_TO_MS].to_vec();
    before.sort_by(f32::total_cmp);
    let floor = before[before.len() / 2];
    if peak - floor < ONSET_BELOW_PEAK_DB {
        return None; // 声がはっきりしない
    }
    let thr = (peak - ONSET_BELOW_PEAK_DB).max(floor + ONSET_ABOVE_FLOOR_DB);
    // ピークからさかのぼり、基準を下回る静かな区間が続いたところの直後を立ち上がりとする
    let mut quiet = 0;
    for j in (i - SEARCH_BEFORE_MS..pk).rev() {
        if level[j] < thr {
            quiet += 1;
            if quiet >= QUIET_BEFORE_MS {
                return Some((start + (j + QUIET_BEFORE_MS) as f64 / 1000.0, peak - floor));
            }
        } else {
            quiet = 0;
        }
    }
    None
}

/// 録画の映像・音声から、声と絵の切り替えのずれを測る
pub fn analyze(video: &VideoFrames, samples: &[f32], sr: f32, audio_start: f64) -> Result<AvReport, AvError> {
    let (rises, marker_cells) = picture_rises(video)?;
    if rises.len() < MIN_EVENTS {
        return Err(AvError::TooFewChanges(rises.len()));
    }
    let level = level_per_ms(samples, sr);

    let mut events = vec![];
    let mut snrs = vec![];
    for &pic in &rises {
        if let Some((voice, snr)) = onset_near(&level, audio_start, pic) {
            events.push(Event { voice_at: voice, picture_at: pic });
            snrs.push(snr);
        }
    }
    let unmatched = rises.len() - events.len();
    if events.len() < MIN_EVENTS {
        return Err(AvError::TooFewMatches(events.len()));
    }

    let span = video.times.last().unwrap() - video.times[0];
    let fps = if span > 0.0 { (video.len() - 1) as f64 / span } else { 0.0 };
    snrs.sort_by(f32::total_cmp);
    let snr_db = snrs[snrs.len() / 2];
    Ok(AvReport { fps, marker_cells, snr_db, events, unmatched })
}

impl AvReport {
    /// ずれ（ms）を小さい順に
    pub fn sorted_offsets(&self) -> Vec<f64> {
        let mut v: Vec<f64> = self.events.iter().map(Event::offset_ms).collect();
        v.sort_by(f64::total_cmp);
        v
    }

    pub fn median_ms(&self) -> f64 {
        let v = self.sorted_offsets();
        let n = v.len();
        if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2.0 }
    }

    /// 10% 点と 90% 点（ms）
    pub fn spread_ms(&self) -> (f64, f64) {
        let v = self.sorted_offsets();
        let p = |q: f64| v[((v.len() - 1) as f64 * q).round() as usize];
        (p(0.1), p(0.9))
    }
}

impl fmt::Display for AvReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let v = self.sorted_offsets();
        let p = |q: f64| v[((v.len() - 1) as f64 * q).round() as usize];
        writeln!(f, "── 声と絵のずれ（録画で実測）──")?;
        writeln!(f, "映像 {:.1} fps / 測定用の四角 {} セル / 声と雑音の差 {:.0} dB", self.fps, self.marker_cells, self.snr_db)?;
        writeln!(f, "測定回数 : {} 回（声が見つからなかった切り替え {} 回）", v.len(), self.unmatched)?;
        writeln!(
            f,
            "ずれ     : 中央値 {:.1} ms / 最小 {:.1} ms / 最大 {:.1} ms（10〜90% は {:.1}〜{:.1} ms）",
            self.median_ms(),
            v[0],
            v[v.len() - 1],
            p(0.1),
            p(0.9)
        )?;
        writeln!(f, "         （正の値 = 絵が声より遅れている。映像 1 フレームは {:.1} ms）", 1000.0 / self.fps.max(1.0))?;
        write!(f, "\n各回 : ")?;
        for e in &self.events {
            write!(f, "{:.0} ", e.offset_ms())?;
        }
        writeln!(f, "ms")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 指定時刻に四角が白くなる映像と、指定時刻に声が始まる音声を作る
    fn synth(voice: &[f64], delay: f64, fps: f64, secs: f64) -> (VideoFrames, Vec<f32>, f32) {
        let (w, h) = (16, 9);
        let n = (secs * fps) as usize;
        let mut luma = Vec::with_capacity(n * w * h);
        let mut times = vec![];
        for i in 0..n {
            let t = i as f64 / fps;
            times.push(t);
            // 声が始まって delay 後から 0.4 秒間「発話中」
            let talking = voice.iter().any(|&v| t >= v + delay && t < v + delay + 0.4);
            for c in 0..w * h {
                // 左上 4x3 セルが四角、ほかはゆっくり変わる背景
                let in_marker = c % w < 4 && c / w < 3;
                luma.push(if in_marker {
                    if talking { 250 } else { 5 }
                } else {
                    (100.0 + 40.0 * (t * 0.3 + c as f64).sin()) as u8
                });
            }
        }
        let sr = 48_000.0f32;
        let mut audio = vec![0.0f32; (secs * sr as f64) as usize];
        let mut seed = 1u32;
        for (i, x) in audio.iter_mut().enumerate() {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = (seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5;
            *x = noise * 0.002; // 約 -54 dBFS の雑音
            let t = i as f64 / sr as f64;
            if voice.iter().any(|&v| t >= v && t < v + 0.3) {
                *x += 0.2 * (2.0 * std::f64::consts::PI * 150.0 * t).sin() as f32;
            }
        }
        (VideoFrames { width: w, height: h, times, luma }, audio, sr)
    }

    #[test]
    fn measures_known_delay_within_one_frame() {
        let voice: Vec<f64> = (0..12).map(|i| 1.0 + i as f64 * 1.3 + (i % 3) as f64 * 0.11).collect();
        for delay in [0.030, 0.045, 0.080] {
            let (video, audio, sr) = synth(&voice, delay, 60.0, 18.0);
            let r = analyze(&video, &audio, sr, 0.0).unwrap();
            assert_eq!(r.events.len(), voice.len());
            assert_eq!(r.marker_cells, 12);
            // フレーム単位に丸められるので、誤差は 1 フレーム（16.7ms）未満
            let m = r.median_ms();
            assert!((m - delay * 1000.0).abs() < 1000.0 / 60.0, "delay {delay}: median {m}");
            assert!(r.sorted_offsets().iter().all(|&o| o >= delay * 1000.0 - 1.0 && o < delay * 1000.0 + 17.0));
        }
    }

    #[test]
    fn audio_start_offset_is_respected() {
        let voice: Vec<f64> = (0..8).map(|i| 1.0 + i as f64 * 1.5).collect();
        let (video, audio, sr) = synth(&voice, 0.05, 60.0, 14.0);
        // 音声が映像より 0.1 秒遅く始まっていたら（＝音声の時刻は +0.1 されている）、ずれは 0.1 秒減る
        let r = analyze(&video, &audio, sr, 0.1).unwrap();
        assert!((r.median_ms() - (50.0 - 100.0)).abs() < 17.0, "median {}", r.median_ms());
    }

    #[test]
    fn no_marker_is_reported() {
        let (mut video, audio, sr) = synth(&[1.0, 2.0], 0.05, 60.0, 4.0);
        video.luma.iter_mut().for_each(|v| *v = 100);
        assert_eq!(analyze(&video, &audio, sr, 0.0).err(), Some(AvError::NoMarker));
    }
}
