//! ログ。`log` クレートのマクロ（`log::info!` など）で書いたものを
//! - 日付ごとのファイル（%APPDATA%\character_viewer\logs\cv-YYYYMMDD.log）
//! - 設定画面に出すための直近のログ（メモリ上、最大 2000 行）
//! - 必要なら標準出力
//!
//! に書く。異常終了（panic）もログに残す。

use std::collections::VecDeque;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

const KEEP_LINES: usize = 2000;
/// これより古いログファイルは起動時に消す（日数）
const KEEP_DAYS: u64 = 14;

#[derive(Clone, Debug, Serialize)]
pub struct LogLine {
    pub seq: u64,
    /// "2026-11-08 14:25:06"
    pub time: String,
    /// "error" / "warn" / "info"
    pub level: &'static str,
    pub message: String,
}

struct Inner {
    lines: VecDeque<LogLine>,
    seq: u64,
    file: Option<(String, std::fs::File)>,
}

struct Logger {
    dir: Option<PathBuf>,
    stdout: bool,
    inner: Mutex<Inner>,
}

static LOGGER: OnceLock<Logger> = OnceLock::new();

/// ログを有効にする。`dir` が None ならファイルには書かない
pub fn init(dir: Option<PathBuf>, stdout: bool) {
    if let Some(d) = &dir {
        let _ = std::fs::create_dir_all(d);
        remove_old(d);
    }
    let logger = LOGGER.get_or_init(|| Logger {
        dir,
        stdout,
        inner: Mutex::new(Inner {
            lines: VecDeque::new(),
            seq: 0,
            file: None,
        }),
    });
    if log::set_logger(logger).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        log::error!(
            "異常終了（{}）: {info}",
            thread.name().unwrap_or("名前なし")
        );
        prev(info);
    }));
}

/// `after` より新しいログ（`after` = 0 なら全部）
pub fn recent(after: u64) -> Vec<LogLine> {
    LOGGER.get().map_or(vec![], |l| {
        l.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .lines
            .iter()
            .filter(|x| x.seq > after)
            .cloned()
            .collect()
    })
}

pub fn log_dir() -> Option<PathBuf> {
    LOGGER.get().and_then(|l| l.dir.clone())
}

/// 今日のログファイル
pub fn today_file() -> Option<PathBuf> {
    let (date, _) = now_local();
    log_dir().map(|d| d.join(format!("cv-{}.log", date.replace('-', ""))))
}

fn remove_old(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let limit = std::time::Duration::from_secs(KEEP_DAYS * 86_400);
    for e in entries.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > limit);
        if old && e.file_name().to_string_lossy().ends_with(".log") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// 現地時刻（"YYYY-MM-DD", "HH:MM:SS"）
pub(crate) fn now_local() -> (String, String) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::SYSTEMTIME;
        use windows_sys::Win32::System::SystemInformation::GetLocalTime;
        // SAFETY: 出力用の構造体を渡すだけ
        let t = unsafe {
            let mut t: SYSTEMTIME = std::mem::zeroed();
            GetLocalTime(&mut t);
            t
        };
        (
            format!("{:04}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay),
            format!("{:02}:{:02}:{:02}", t.wHour, t.wMinute, t.wSecond),
        )
    }
    #[cfg(not(windows))]
    {
        let s = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        (
            "1970-01-01".into(),
            format!("{:02}:{:02}:{:02}", s / 3600 % 24, s / 60 % 60, s % 60),
        )
    }
}

impl log::Log for Logger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        // 依存ライブラリの細かいログは出さない（警告以上だけ）
        m.level() <= log::Level::Warn || m.target().starts_with("cv_")
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let level = match record.level() {
            log::Level::Error => "error",
            log::Level::Warn => "warn",
            _ => "info",
        };
        let (date, time) = now_local();
        let message = record.args().to_string();
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.seq += 1;
        let line = LogLine {
            seq: inner.seq,
            time: format!("{date} {time}"),
            level,
            message,
        };

        let text = format!("{} [{:<5}] {}\n", line.time, line.level, line.message);
        if self.stdout {
            print!("{text}");
        }
        if let Some(dir) = &self.dir {
            if inner.file.as_ref().is_none_or(|(d, _)| *d != date) {
                let path = dir.join(format!("cv-{}.log", date.replace('-', "")));
                inner.file = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                    .ok()
                    .map(|f| (date.clone(), f));
            }
            if let Some((_, f)) = inner.file.as_mut() {
                let _ = f.write_all(text.as_bytes());
            }
        }
        inner.lines.push_back(line);
        if inner.lines.len() > KEEP_LINES {
            inner.lines.pop_front();
        }
    }

    fn flush(&self) {}
}
