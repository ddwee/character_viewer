//! 外部コマンド（ffmpeg・cargo・git など）の実行。
//! アプリから実行しても黒いウィンドウがちらつかないようにし、
//! アプリ起動後にインストールされた道具も見つけられるよう、よくある場所も探す。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt as _;

/// ウィンドウを出さない（GUI アプリからコンソールアプリを呼ぶとき）
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// 新しいコンソールウィンドウで開く（PowerShell を利用者に見せるとき）
#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

/// 道具の実行ファイルを探す（PATH → よくあるインストール先）
pub fn find_tool(name: &str) -> Option<PathBuf> {
    let names = [format!("{name}.exe"), format!("{name}.cmd")];
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    if let Some(home) = env("USERPROFILE") {
        dirs.push(home.join(".cargo").join("bin"));
    }
    if let Some(local) = env("LOCALAPPDATA") {
        dirs.push(local.join("Microsoft").join("WinGet").join("Links"));
        // winget でインストールした ffmpeg（PATH が反映される前でも見つける）
        if let Ok(entries) =
            std::fs::read_dir(local.join("Microsoft").join("WinGet").join("Packages"))
        {
            for e in entries
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with("Gyan.FFmpeg"))
            {
                if let Ok(inner) = std::fs::read_dir(e.path()) {
                    dirs.extend(inner.flatten().map(|i| i.path().join("bin")));
                }
            }
        }
    }
    if let Some(pf) = env("ProgramFiles") {
        dirs.push(pf.join("nodejs"));
        dirs.push(pf.join("Git").join("cmd"));
    }
    dirs.into_iter()
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| p.is_file())
}

/// ウィンドウを出さずに実行するコマンド
pub fn hidden(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let program = program.as_ref();
    let resolved = Path::new(program)
        .file_stem()
        .and_then(|s| s.to_str())
        .and_then(find_tool);
    let mut cmd = Command::new(resolved.as_deref().map_or(program, |p| p.as_os_str()));
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdin(std::process::Stdio::null());
    cmd
}

/// 新しいコンソールウィンドウで PowerShell スクリプトを実行する（利用者に経過とエラーを見せる）
pub fn open_powershell(
    script: &Path,
    args: &[&str],
    workdir: &Path,
    keep_open: bool,
) -> std::io::Result<()> {
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"]);
    if keep_open {
        cmd.arg("-NoExit");
    }
    cmd.arg("-File").arg(script).args(args).current_dir(workdir);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NEW_CONSOLE);
    cmd.spawn().map(|_| ())
}

/// コマンドを実行し、標準出力と標準エラーをまとめた文字列を返す（時間がかかりすぎたら打ち切る）
pub fn output_text(mut cmd: Command, timeout: Duration) -> Result<(bool, String), String> {
    use std::io::Read as _;
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("実行できません: {e}"))?;
    let mut out = child.stdout.take().expect("パイプにしてある");
    let mut err = child.stderr.take().expect("パイプにしてある");
    let t_out = std::thread::spawn(move || {
        let mut v = vec![];
        let _ = out.read_to_end(&mut v);
        v
    });
    let t_err = std::thread::spawn(move || {
        let mut v = vec![];
        let _ = err.read_to_end(&mut v);
        v
    });
    let start = std::time::Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            return Err(format!("{} 秒以内に終わりませんでした", timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    let mut text = String::from_utf8_lossy(&t_out.join().unwrap_or_default()).into_owned();
    let e = String::from_utf8_lossy(&t_err.join().unwrap_or_default()).into_owned();
    if !e.trim().is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&e);
    }
    Ok((status.success(), text))
}
