//! マイク入力（WASAPI 共有モード）のストリーム。
//! オーディオスレッドのコールバックでは確保もロックもしない。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{FromSample, InputCallbackInfo, Sample, SampleFormat, SizedSample, StreamConfig};

use crate::detector::Transition;
use crate::dsp::lin_to_db;
use crate::pipeline::{Pipeline, PipelineConfig};

/// オーディオスレッド → 制御スレッドへ送るメッセージ（確保なしで送れるよう Copy 型）
#[derive(Clone, Copy, Debug)]
pub enum Msg {
    Meter {
        level_db: f32,
        env_db: f32,
        voicing: f32,
        voiced: bool,
        frames: u32,
    },
    /// `latency_us`: 音が入ってから判定までの遅延。`at`: 判定した時刻（QPC）
    Transition {
        kind: Transition,
        latency_us: u32,
        at: Duration,
    },
}

/// 現在時刻を QPC（WASAPI のタイムスタンプと同じ時計）で返す
pub fn qpc_now() -> Duration {
    use windows_sys::Win32::System::Performance::{
        QueryPerformanceCounter, QueryPerformanceFrequency,
    };
    let (mut count, mut freq) = (0i64, 0i64);
    // SAFETY: 出力用ポインタを渡すだけの Win32 API
    unsafe {
        QueryPerformanceCounter(&mut count);
        QueryPerformanceFrequency(&mut freq);
    }
    Duration::from_nanos((count as u128 * 1_000_000_000 / freq as u128) as u64)
}

/// オーディオコールバックで呼ばれる処理
pub trait Sink: Send + 'static {
    fn push<T>(&mut self, data: &[T], info: &InputCallbackInfo)
    where
        T: Sample,
        f32: FromSample<T>;
}

/// 開いたストリームと、その形式
pub struct Input {
    pub stream: cpal::Stream,
    pub name: String,
    pub sample_rate: u32,
    pub channels: usize,
    pub format: SampleFormat,
    /// ストリームが異常（デバイスが外れた等）になったら true
    pub failed: Arc<AtomicBool>,
}

/// デバイスの既定の形式を調べる
pub fn device_config(device: &cpal::Device) -> Result<(StreamConfig, SampleFormat)> {
    let supported = device
        .default_input_config()
        .context("入力設定を取得できません（他のアプリが占有していないか確認してください）")?;
    let format = supported.sample_format();
    Ok((supported.into(), format))
}

fn build<T, S: Sink>(
    device: &cpal::Device,
    config: StreamConfig,
    mut sink: S,
    failed: Arc<AtomicBool>,
) -> Result<cpal::Stream>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    // 開始直後の 1 回は WASAPI が先頭パケットに不連続フラグを立てるだけなので無視する
    let mut startup = true;
    let stream = device.build_input_stream::<T, _, _>(
        config,
        move |data, info| sink.push(data, info),
        move |err: cpal::Error| {
            if startup && matches!(err.kind(), cpal::ErrorKind::Xrun) {
                startup = false;
                return;
            }
            if matches!(err.kind(), cpal::ErrorKind::Xrun) {
                log::warn!("音声の取りこぼしがありました（{err}）");
            } else {
                log::error!("音声入力のエラー: {err}");
                failed.store(true, Ordering::SeqCst);
            }
        },
        None,
    )?;
    Ok(stream)
}

/// `device` からストリームを開いて再生を始める。`make` は (サンプルレート, チャンネル数) から処理を作る
pub fn open<S: Sink>(
    device: &cpal::Device,
    make: impl FnOnce(u32, usize) -> Result<S>,
) -> Result<Input> {
    let (config, format) = device_config(device)?;
    let sample_rate = config.sample_rate;
    let channels = config.channels as usize;
    let sink = make(sample_rate, channels)?;
    let failed = Arc::new(AtomicBool::new(false));
    let f = failed.clone();
    let stream = match format {
        SampleFormat::F32 => build::<f32, S>(device, config, sink, f),
        SampleFormat::I16 => build::<i16, S>(device, config, sink, f),
        SampleFormat::I32 => build::<i32, S>(device, config, sink, f),
        SampleFormat::U16 => build::<u16, S>(device, config, sink, f),
        SampleFormat::I8 => build::<i8, S>(device, config, sink, f),
        other => bail!("未対応のサンプル形式です: {other:?}"),
    }?;
    stream.play().context("音声入力を開始できません")?;
    Ok(Input {
        stream,
        name: crate::devices::label(device),
        sample_rate,
        channels,
        format,
        failed,
    })
}

/// 発話判定をして、結果を制御スレッドへ送る
pub struct Processor {
    pub pipeline: Pipeline,
    pub channel: usize,
    pub channels: usize,
    pub sample_rate: f32,
    pub tx: rtrb::Producer<Msg>,
    /// 発話の開始・終了をすぐ処理させるために起こす制御スレッド
    pub control: std::thread::Thread,
}

impl Processor {
    pub fn new(
        cfg: &PipelineConfig,
        sample_rate: u32,
        channels: usize,
        channel: usize,
        tx: rtrb::Producer<Msg>,
    ) -> Result<Self> {
        if channel == 0 || channel > channels {
            bail!("チャンネル {channel} はありません（このデバイスは {channels} チャンネル）");
        }
        Ok(Self {
            pipeline: Pipeline::new(cfg, sample_rate as f32),
            channel: channel - 1,
            channels,
            sample_rate: sample_rate as f32,
            tx,
            control: std::thread::current(),
        })
    }
}

impl Sink for Processor {
    fn push<T>(&mut self, data: &[T], info: &InputCallbackInfo)
    where
        T: Sample,
        f32: FromSample<T>,
    {
        // cpal の callback 時刻はデバイス時計の位置なので、実時間は QPC で自前に取る
        let capture = Duration::from_nanos(info.timestamp().capture.as_nanos() as u64);
        let now = qpc_now();
        let cap_to_cb = now.saturating_sub(capture);
        let frames = data.len() / self.channels;
        let mut peak = 0.0f32;

        for (i, frame) in data.chunks_exact(self.channels).enumerate() {
            let x = frame[self.channel].to_sample::<f32>();
            peak = peak.max(x.abs());
            if let Some(kind) = self.pipeline.process(x) {
                // WASAPI の capture 時刻は実測上「パケットが揃った時刻」（≒末尾フレーム）を指す。
                // よって i 番目のフレームは、末尾までの (frames - i) / sr 秒だけ待たされている。
                // ※ ADC・USB 転送などハードウェア側の遅延（数 ms）はソフトからは測れないため含まない
                let wait = Duration::from_secs_f32((frames - i) as f32 / self.sample_rate);
                let latency = cap_to_cb + wait;
                let _ = self.tx.push(Msg::Transition {
                    kind,
                    latency_us: latency.as_micros() as u32,
                    at: now,
                });
                // 制御スレッドを待たせずに起こす（ロックも確保もしない）
                self.control.unpark();
            }
        }

        let _ = self.tx.push(Msg::Meter {
            level_db: lin_to_db(peak),
            env_db: lin_to_db(self.pipeline.envelope()),
            voicing: self.pipeline.voicing_score(),
            voiced: self.pipeline.is_voiced(),
            frames: frames as u32,
        });
        // 喋っている間は音量もすぐ届ける（口の開き具合に使う）。
        // 起こさないと Windows のスリープの細かさ（約 15.6ms）ごとにしか送れない
        if self.pipeline.is_speaking() {
            self.control.unpark();
        }
    }
}

/// 指定チャンネルのサンプルをそのまま送る（キャリブレーション録音用）
pub struct Recorder {
    pub channel: usize,
    pub channels: usize,
    pub tx: rtrb::Producer<f32>,
}

impl Sink for Recorder {
    fn push<T>(&mut self, data: &[T], _info: &InputCallbackInfo)
    where
        T: Sample,
        f32: FromSample<T>,
    {
        for frame in data.chunks_exact(self.channels) {
            let _ = self.tx.push(frame[self.channel].to_sample::<f32>());
        }
    }
}

pub fn write_wav(path: &std::path::Path, samples: &[f32], sr: u32) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: sr,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut w = hound::WavWriter::create(path, spec)
        .with_context(|| format!("{} を作成できません", path.display()))?;
    for &x in samples {
        w.write_sample(x)?;
    }
    w.finalize()?;
    Ok(())
}

pub fn read_wav(path: &std::path::Path) -> Result<(Vec<f32>, f32)> {
    let mut r =
        hound::WavReader::open(path).with_context(|| format!("{} を開けません", path.display()))?;
    let spec = r.spec();
    let ch = spec.channels as usize;
    let all: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().collect::<Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1u64 << (spec.bits_per_sample - 1)) as f32;
            r.samples::<i32>()
                .map(|s| s.map(|v| v as f32 * scale))
                .collect::<Result<_, _>>()?
        }
    };
    // 複数チャンネルなら 1 チャンネル目を使う
    Ok((
        all.into_iter().step_by(ch).collect(),
        spec.sample_rate as f32,
    ))
}
