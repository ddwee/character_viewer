//! いまのアバターの絵（透過 PNG）を保存する。動画のサムネイル作りなどに使う。
//!
//! 絵は描画ページが素材の解像度で作り、設定画面から送られてくる。
//! 保存先は Windows の「ピクチャ」の中の `character_viewer` フォルダ
//! （素材のフォルダに置くと、監視が反応して素材を読み込み直してしまうため）。

use std::io::Write;
use std::path::{Path, PathBuf};

/// 受け付ける大きさの上限（4000×6000 の透過 PNG でも収まる）
pub const MAX_BYTES: usize = 128 * 1024 * 1024;

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// 保存先のフォルダ
pub fn dir() -> PathBuf {
    pictures_dir().join("character_viewer")
}

/// PNG を保存して、そのパスを返す。`label` はファイル名の末尾に付ける（状態の名前など）
pub fn save(bytes: &[u8], label: Option<&str>) -> Result<PathBuf, String> {
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err("PNG ではありません".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err("画像が大きすぎます（128MB まで）".into());
    }
    let dir = dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("フォルダを作れません（{}）: {e}", dir.display()))?;
    let base = file_stem(&crate::logging::now_local(), label);
    write_new(&dir, &base, bytes)
}

/// `avatar-20261111-153012-idle` のような名前（日付と時刻は "YYYY-MM-DD", "HH:MM:SS"）
fn file_stem((date, time): &(String, String), label: Option<&str>) -> String {
    let digits = |s: &str| s.chars().filter(char::is_ascii_digit).collect::<String>();
    let mut name = format!("avatar-{}-{}", digits(date), digits(time));
    // ファイル名に使える英数字だけ残す
    let label: String = label
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(16)
        .collect();
    if !label.is_empty() {
        name.push('-');
        name.push_str(&label);
    }
    name
}

/// 同じ名前のファイルがあれば `-2`, `-3`… を付けて、上書きせずに書く
fn write_new(dir: &Path, base: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    for n in 1..1000 {
        let path = match n {
            1 => dir.join(format!("{base}.png")),
            _ => dir.join(format!("{base}-{n}.png")),
        };
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut f) => {
                if let Err(e) = f.write_all(bytes).and_then(|()| f.flush()) {
                    drop(f);
                    let _ = std::fs::remove_file(&path);
                    return Err(format!("画像を保存できません: {e}"));
                }
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("画像を保存できません（{}）: {e}", path.display())),
        }
    }
    Err("同じ名前のファイルが多すぎます".into())
}

/// Windows の「ピクチャ」フォルダ（OneDrive などへ移していてもその場所）
fn pictures_dir() -> PathBuf {
    #[cfg(windows)]
    if let Some(p) = known_pictures() {
        return p;
    }
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    home.join("Pictures")
}

#[cfg(windows)]
fn known_pictures() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{FOLDERID_Pictures, SHGetKnownFolderPath};

    let mut raw: *mut u16 = std::ptr::null_mut();
    // SAFETY: 受け取った文字列は NUL 終端。失敗しても成功しても CoTaskMemFree で解放する
    unsafe {
        let hr = SHGetKnownFolderPath(&FOLDERID_Pictures, 0, std::ptr::null_mut(), &mut raw);
        let path = if hr >= 0 && !raw.is_null() {
            let len = (0..).take_while(|&i| *raw.add(i) != 0).count();
            let s = std::ffi::OsString::from_wide(std::slice::from_raw_parts(raw, len));
            Some(PathBuf::from(s))
        } else {
            None
        };
        CoTaskMemFree(raw as *const _);
        path.filter(|p| p.is_dir())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stem_has_time_and_safe_label() {
        let t = ("2026-11-11".to_string(), "09:05:03".to_string());
        assert_eq!(file_stem(&t, None), "avatar-20261111-090503");
        assert_eq!(file_stem(&t, Some("talk")), "avatar-20261111-090503-talk");
        assert_eq!(file_stem(&t, Some("../x y")), "avatar-20261111-090503-xy");
    }

    #[test]
    fn never_overwrites() {
        let dir = std::env::temp_dir().join(format!("cv-snapshot-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = write_new(&dir, "x", b"1").unwrap();
        let b = write_new(&dir, "x", b"2").unwrap();
        assert_eq!(a.file_name().unwrap(), "x.png");
        assert_eq!(b.file_name().unwrap(), "x-2.png");
        assert_eq!(std::fs::read(&a).unwrap(), b"1");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_non_png() {
        assert!(save(b"not a png", None).is_err());
    }

    #[test]
    fn finds_pictures_dir() {
        assert!(dir().ends_with("character_viewer"));
    }
}
