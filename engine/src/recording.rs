//! OBS の録画を ffmpeg で読み、声と絵のずれを測る（解析そのものは [`crate::av_sync`]）。

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{Context, Result, bail};
use serde::Serialize;

use crate::av_sync::{self, AvReport, VideoFrames};
use crate::process::{find_tool, hidden};

/// 映像を縮小するサイズ（16:9。1920x1080 なら 1 セル 30x30 ピクセル）
const AV_WIDTH: usize = 64;
const AV_HEIGHT: usize = 36;

pub fn ffmpeg_available() -> bool {
    find_tool("ffmpeg").is_some() && find_tool("ffprobe").is_some()
}

fn ffmpeg() -> Result<std::process::Command> {
    if !ffmpeg_available() {
        bail!(
            "ffmpeg が見つかりません。設定画面の「ffmpeg をインストール」か、PowerShell で winget install Gyan.FFmpeg を実行してください（無料）"
        );
    }
    let mut cmd = hidden("ffmpeg");
    cmd.args(["-v", "error", "-nostdin"]);
    Ok(cmd)
}

/// 音声トラックをモノラル f32 で読む。戻り値は（サンプル, サンプルレート）。
/// 先頭のサンプルが録画の時刻 0 になるよう、足りない分は無音で埋める
pub fn decode_audio(path: &Path, track: usize) -> Result<(Vec<f32>, f32)> {
    let stream = format!("a:{}", track.saturating_sub(1));
    let mut probe = hidden("ffprobe");
    probe.args([
        "-v",
        "error",
        "-select_streams",
        &stream,
        "-show_entries",
        "stream=sample_rate",
        "-of",
        "default=noprint_wrappers=1",
    ]);
    let out = probe
        .arg(path)
        .output()
        .context("ffprobe を実行できません")?;
    let text = String::from_utf8_lossy(&out.stdout);
    let field = |key: &str| {
        text.lines().find_map(|l| {
            l.strip_prefix(key)?
                .strip_prefix('=')
                .map(str::trim)
                .map(str::to_string)
        })
    };
    let sr: f32 = field("sample_rate")
        .and_then(|v| v.parse().ok())
        .with_context(|| format!("音声トラック {track} がありません"))?;

    let mut cmd = ffmpeg()?;
    // ストリームの開始時刻の情報はエンコーダの先頭無音（AAC で約 21ms）を含むことがあり当てにならない。
    // デコードした音声そのものの時刻（-copyts）を使い、時刻 0 まで無音で埋めて映像と同じ時間軸にそろえる
    cmd.args(["-copyts", "-i"]).arg(path).args([
        "-map",
        &format!("0:{stream}"),
        "-af",
        "aresample=async=1:first_pts=0",
        "-ac",
        "1",
        "-c:a",
        "pcm_f32le",
        "-f",
        "f32le",
        "-",
    ]);
    let out = cmd.output().context("ffmpeg を実行できません")?;
    if !out.status.success() {
        bail!(
            "音声を読めません: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let samples = out
        .stdout
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    Ok((samples, sr))
}

/// 映像を縮小グレースケールで読み、各フレームの表示時刻（元の録画の時刻）も取る
pub fn decode_video(path: &Path) -> Result<VideoFrames> {
    use std::io::{BufRead, Read};
    let mut cmd = ffmpeg()?;
    // 時刻は showinfo が stderr に出す pts_time を使う（-copyts で元の時刻のまま）
    cmd.args(["-v", "info", "-nostats", "-copyts", "-i"])
        .arg(path)
        .args([
            "-map",
            "0:v:0",
            "-vf",
            &format!("scale={AV_WIDTH}:{AV_HEIGHT}:flags=area,format=gray,showinfo"),
            "-fps_mode",
            "passthrough",
            "-f",
            "rawvideo",
            "-",
        ]);
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("ffmpeg を実行できません")?;
    let stderr = child.stderr.take().expect("stderr はパイプにしてある");
    let times_thread = std::thread::spawn(move || {
        let mut times = vec![];
        let mut log = String::new();
        for line in std::io::BufReader::new(stderr)
            .lines()
            .map_while(Result::ok)
        {
            if let Some(rest) = line.split("pts_time:").nth(1) {
                if line.contains("showinfo")
                    && let Some(t) = rest
                        .split_whitespace()
                        .next()
                        .and_then(|v| v.parse::<f64>().ok())
                {
                    times.push(t);
                }
            } else if line.contains("rror") {
                log.push_str(&line);
                log.push('\n');
            }
        }
        (times, log)
    });
    let mut luma = vec![];
    child
        .stdout
        .take()
        .expect("stdout はパイプにしてある")
        .read_to_end(&mut luma)?;
    let status = child.wait()?;
    let (times, log) = times_thread.join().expect("stderr の読み取りスレッド");
    if !status.success() {
        bail!("映像を読めません: {}", log.trim());
    }
    let frames = luma.len() / (AV_WIDTH * AV_HEIGHT);
    if frames != times.len() {
        bail!(
            "映像のフレーム数（{frames}）と時刻の数（{}）が合いません",
            times.len()
        );
    }
    Ok(VideoFrames {
        width: AV_WIDTH,
        height: AV_HEIGHT,
        times,
        luma,
    })
}

pub fn measure(path: &Path, track: usize) -> Result<AvReport> {
    let (samples, sr) = decode_audio(path, track)?;
    let video = decode_video(path)?;
    Ok(av_sync::analyze(&video, &samples, sr, 0.0)?)
}

/// 測定結果から、OBS での調整方法を文章にする。
/// 目安は ITU-R BT.1359: 音が映像より 45ms 以上先だと気づかれやすく、音が後なら 125ms までは気づかれにくい
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Advice {
    /// ok / adjust / warn
    pub level: &'static str,
    pub verdict: String,
    pub details: Vec<String>,
}

pub fn advice(report: &AvReport) -> Advice {
    let median = report.median_ms();
    let (p10, p90) = report.spread_ms();
    let round5 = |v: f64| ((v / 5.0).round() * 5.0) as i32;
    let mut details = vec![];
    let (level, verdict) = if median >= 0.0 {
        if median <= 20.0 {
            (
                "ok",
                format!(
                    "絵が声より {median:.0} ms 遅れています。1 フレーム程度なので調整は不要です"
                ),
            )
        } else {
            details.push(format!(
                "ぴったり揃えるには、OBS の音声ミキサーでマイクの「⋮」→「オーディオの詳細プロパティ」→「同期オフセット」を今の値より {} ms 増やします",
                round5(median)
            ));
            (
                if median > 45.0 { "adjust" } else { "ok" },
                format!("絵が声より {median:.0} ms 遅れています（声が先に聞こえる）"),
            )
        }
    } else {
        let lead = -median;
        details.push("マイクのノイズ除去などのフィルタは処理に時間がかかり、録画の音声だけが遅れます。OBS はその遅れを補正しないので、絵のほうが先になります".into());
        details.push(format!(
            "ぴったり揃えたいときは、描画のブラウザソースに「フィルタ」→「レンダリング遅延」を追加して {} ms にします。マイクの同期オフセットは増やさないでください",
            round5(lead)
        ));
        if lead <= 125.0 {
            (
                "ok",
                format!(
                    "絵が声より {lead:.0} ms 早く出ています。この向きは 125 ms までは視聴者にほぼ気づかれないので、このままで問題ありません"
                ),
            )
        } else {
            (
                "warn",
                format!("絵が声より {lead:.0} ms 早く出ています。気づかれやすい大きさです"),
            )
        }
    };
    if p90 - p10 > 60.0 {
        details.push(format!(
            "回ごとのばらつきが大きめです（10〜90% で {p10:.0}〜{p90:.0} ms）。声がゆっくり大きくなる出だしでは、話し始めの音量のしきい値を超えるまで時間がかかります"
        ));
    }
    Advice {
        level,
        verdict,
        details,
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFile {
    pub path: PathBuf,
    pub name: String,
    pub size_mb: f64,
    /// 何分前に更新されたか
    pub minutes_ago: f64,
}

/// OBS の録画フォルダ（全プロファイル）にある最近の録画
pub fn recent_recordings(limit: usize) -> Vec<RecordingFile> {
    let mut dirs: Vec<PathBuf> = vec![];
    let profiles = std::env::var_os("APPDATA").map(|a| {
        PathBuf::from(a)
            .join("obs-studio")
            .join("basic")
            .join("profiles")
    });
    if let Some(Ok(entries)) = profiles.map(std::fs::read_dir) {
        for e in entries.flatten() {
            let Ok(ini) = std::fs::read_to_string(e.path().join("basic.ini")) else {
                continue;
            };
            for line in ini.lines() {
                if let Some(v) = line
                    .strip_prefix("RecFilePath=")
                    .or_else(|| line.strip_prefix("FilePath="))
                {
                    let p = PathBuf::from(v.replace("\\\\", "\\"));
                    if !dirs.contains(&p) {
                        dirs.push(p);
                    }
                }
            }
        }
    }
    if let Some(v) = std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("Videos"))
        && !dirs.contains(&v)
    {
        dirs.push(v);
    }
    let mut files: Vec<(SystemTime, RecordingFile)> = dirs
        .iter()
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flat_map(|rd| rd.flatten())
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_lowercase();
            [".mp4", ".mkv", ".mov", ".flv", ".ts", ".m4v"]
                .iter()
                .any(|x| n.ends_with(x))
        })
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            let t = m.modified().ok()?;
            Some((
                t,
                RecordingFile {
                    name: e.file_name().to_string_lossy().into_owned(),
                    path: e.path(),
                    size_mb: m.len() as f64 / 1_048_576.0,
                    minutes_ago: t.elapsed().map_or(0.0, |d| d.as_secs_f64() / 60.0),
                },
            ))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.into_iter().take(limit).map(|(_, f)| f).collect()
}
