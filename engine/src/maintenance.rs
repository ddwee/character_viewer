//! メンテナンス: 部品のバージョン確認・更新の確認・安全な更新・元に戻す・PowerShell を開く。
//!
//! 更新そのものは tools\update.ps1 が新しいコンソールで行う（経過とエラーを利用者が見られる）。
//! 更新は「別の場所でビルドとテストが通ったときだけ差し替え、直前の版は bin.prev に残す」ので、
//! 互換性の問題で新しい版が動かなくても、今動いている版はそのまま残る。

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::process::{find_tool, hidden, open_powershell, output_text};

const QUICK: Duration = Duration::from_secs(20);
const NETWORK: Duration = Duration::from_secs(180);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolVersion {
    pub name: &'static str,
    pub role: &'static str,
    pub version: Option<String>,
    pub path: Option<PathBuf>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageVersion {
    pub name: String,
    pub kind: &'static str,
    pub version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Versions {
    pub app: String,
    pub commit: Option<String>,
    pub branch: Option<String>,
    pub dirty: bool,
    /// rust-toolchain.toml で固定している Rust の版
    pub pinned_rust: Option<String>,
    pub tools: Vec<ToolVersion>,
    pub packages: Vec<PackageVersion>,
    /// 前の版のバックアップ（元に戻せる）があるか
    pub has_backup: bool,
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").trim().to_string()
}

fn run(root: &Path, program: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut cmd = hidden(program);
    cmd.args(args).current_dir(root);
    match output_text(cmd, timeout)? {
        (true, text) => Ok(text),
        (false, text) => Err(text.trim().to_string()),
    }
}

fn tool(root: &Path, name: &'static str, role: &'static str, args: &[&str]) -> ToolVersion {
    let path = find_tool(name);
    let version = path
        .as_ref()
        .and_then(|_| run(root, name, args, QUICK).ok())
        .map(|t| {
            let line = first_line(&t);
            // "ffmpeg version 8.1-full_build-www.gyan.dev Copyright ..." → 先頭の 3 語
            if name == "ffmpeg" {
                line.split_whitespace()
                    .take(3)
                    .collect::<Vec<_>>()
                    .join(" ")
            } else {
                line
            }
        });
    ToolVersion {
        name,
        role,
        version,
        path,
    }
}

/// Cargo.lock から主要な Rust 部品の版を読む
fn cargo_packages(root: &Path) -> Vec<PackageVersion> {
    const KEY: [&str; 8] = [
        "tauri",
        "axum",
        "tokio",
        "cpal",
        "serde",
        "tower-http",
        "rtrb",
        "clap",
    ];
    let Ok(lock) = std::fs::read_to_string(root.join("Cargo.lock")) else {
        return vec![];
    };
    let mut out = vec![];
    let mut name = None;
    for line in lock.lines() {
        if let Some(v) = line.strip_prefix("name = ") {
            name = Some(v.trim_matches('"').to_string());
        } else if let (Some(v), Some(n)) = (line.strip_prefix("version = "), name.take())
            && KEY.contains(&n.as_str())
        {
            // 同じ部品が複数の版で入っていたら、新しいほう（Cargo.lock では後ろ）を表示する
            out.retain(|p: &PackageVersion| p.name != n);
            out.push(PackageVersion {
                name: n,
                kind: "Rust",
                version: v.trim_matches('"').to_string(),
            });
        }
    }
    out.sort_by_key(|p| KEY.iter().position(|k| *k == p.name));
    out
}

/// package-lock.json から主要な npm 部品の版を読む
fn npm_packages(root: &Path) -> Vec<PackageVersion> {
    const KEY: [&str; 4] = ["pixi.js", "preact", "vite", "typescript"];
    let Ok(text) = std::fs::read_to_string(root.join("renderer").join("package-lock.json")) else {
        return vec![];
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return vec![];
    };
    KEY.iter()
        .filter_map(|k| {
            let ver = v["packages"][format!("node_modules/{k}")]["version"].as_str()?;
            Some(PackageVersion {
                name: (*k).into(),
                kind: "npm",
                version: ver.into(),
            })
        })
        .collect()
}

pub fn pinned_rust(root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(root.join("rust-toolchain.toml")).ok()?;
    text.lines().find_map(|l| {
        l.trim().strip_prefix("channel").map(|v| {
            v.trim_start_matches([' ', '='])
                .trim()
                .trim_matches('"')
                .to_string()
        })
    })
}

pub fn versions(root: &Path) -> Versions {
    let git = |args: &[&str]| run(root, "git", args, QUICK).ok().map(|s| first_line(&s));
    Versions {
        app: env!("CARGO_PKG_VERSION").into(),
        commit: git(&["rev-parse", "--short", "HEAD"]),
        branch: git(&["rev-parse", "--abbrev-ref", "HEAD"]),
        dirty: git(&["status", "--porcelain", "--untracked-files=no"])
            .is_some_and(|s| !s.is_empty()),
        pinned_rust: pinned_rust(root),
        tools: vec![
            tool(root, "rustc", "Rust（音声エンジン・アプリ）", &["-V"]),
            tool(root, "cargo", "Rust のビルド", &["-V"]),
            tool(root, "rustup", "Rust の更新", &["-V"]),
            tool(
                root,
                "node",
                "Node.js（描画ページ・設定画面のビルド）",
                &["-v"],
            ),
            tool(root, "npm", "Node.js の部品管理", &["-v"]),
            tool(root, "git", "プロジェクトの更新", &["--version"]),
            tool(root, "ffmpeg", "録画の解析", &["-version"]),
        ],
        packages: [cargo_packages(root), npm_packages(root)].concat(),
        has_backup: root.join("bin.prev").is_dir(),
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitUpdate {
    pub upstream: Option<String>,
    pub behind: u32,
    pub ahead: u32,
    pub dirty: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustUpdate {
    pub current: Option<String>,
    pub latest: Option<String>,
    pub available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageUpdate {
    pub name: String,
    pub kind: &'static str,
    pub current: String,
    /// 互換性を保ったまま上げられる版（「ライブラリを更新」で入る）
    pub wanted: String,
    /// 最新版（大きな変更を含むことがあり、自動では上げない）
    pub latest: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub git: GitUpdate,
    pub rust: RustUpdate,
    pub packages: Vec<PackageUpdate>,
    pub errors: Vec<String>,
}

pub fn check_updates(root: &Path, progress: impl Fn(&str)) -> UpdateCheck {
    let mut c = UpdateCheck::default();

    progress("プロジェクト（GitHub）を確認しています");
    match run(root, "git", &["fetch", "--quiet"], NETWORK) {
        Ok(_) => {
            c.git.upstream = run(root, "git", &["rev-parse", "--abbrev-ref", "@{u}"], QUICK)
                .ok()
                .map(|s| first_line(&s));
            if c.git.upstream.is_some()
                && let Ok(t) = run(
                    root,
                    "git",
                    &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
                    QUICK,
                )
            {
                let mut it = t.split_whitespace().filter_map(|x| x.parse().ok());
                c.git.ahead = it.next().unwrap_or(0);
                c.git.behind = it.next().unwrap_or(0);
            }
            c.git.dirty = run(
                root,
                "git",
                &["status", "--porcelain", "--untracked-files=no"],
                QUICK,
            )
            .is_ok_and(|s| !s.trim().is_empty());
        }
        Err(e) => c
            .errors
            .push(format!("GitHub を確認できませんでした: {}", first_line(&e))),
    }

    progress("Rust を確認しています");
    match run(root, "rustup", &["check"], NETWORK) {
        // "stable-x86_64-pc-windows-msvc - Update available : 1.99.1 (...) -> 1.100.0 (...)"
        // "stable-x86_64-pc-windows-msvc - Up to date : 1.99.1 (...)"
        Ok(t) => {
            if let Some(line) = t.lines().find(|l| l.starts_with("stable")) {
                let vers: Vec<&str> = line
                    .split_whitespace()
                    .filter(|w| w.chars().next().is_some_and(|ch| ch.is_ascii_digit()))
                    .collect();
                c.rust.current = vers.first().map(|s| s.to_string());
                c.rust.available = line.contains("Update available");
                c.rust.latest = if c.rust.available {
                    vers.get(1).map(|s| s.to_string())
                } else {
                    c.rust.current.clone()
                };
            }
        }
        Err(e) => c
            .errors
            .push(format!("Rust を確認できませんでした: {}", first_line(&e))),
    }

    progress("Rust の部品を確認しています");
    match run(
        root,
        "cargo",
        &["update", "--dry-run", "--workspace", "--color", "never"],
        NETWORK,
    )
    .or_else(|_| {
        run(
            root,
            "cargo",
            &["update", "--dry-run", "--color", "never"],
            NETWORK,
        )
    }) {
        // "    Updating axum v0.8.9 -> v0.8.10"
        Ok(t) => {
            for line in t.lines() {
                let w: Vec<&str> = line.split_whitespace().collect();
                if w.len() >= 5 && w[0] == "Updating" && w[3] == "->" {
                    c.packages.push(PackageUpdate {
                        name: w[1].into(),
                        kind: "Rust",
                        current: w[2].trim_start_matches('v').into(),
                        wanted: w[4].trim_start_matches('v').into(),
                        latest: w
                            .get(5)
                            .map_or(w[4], |x| x.trim_matches(|ch| ch == '(' || ch == ')'))
                            .trim_start_matches("latest:")
                            .trim_start_matches('v')
                            .into(),
                    });
                }
            }
        }
        Err(e) => c.errors.push(format!(
            "Rust の部品を確認できませんでした: {}",
            first_line(&e)
        )),
    }

    progress("描画ページの部品（npm）を確認しています");
    let renderer = root.join("renderer");
    let mut cmd = hidden("npm");
    cmd.args(["outdated", "--json"]).current_dir(&renderer);
    // npm outdated は古い部品があると終了コード 1 を返すので、成否ではなく出力を見る
    match output_text(cmd, NETWORK) {
        Ok((_, text)) => {
            let json = text.find('{').map_or("{}", |i| &text[i..]);
            if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(json) {
                for (name, v) in map {
                    let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
                    c.packages.push(PackageUpdate {
                        name,
                        kind: "npm",
                        current: s("current"),
                        wanted: s("wanted"),
                        latest: s("latest"),
                    });
                }
            }
        }
        Err(e) => c
            .errors
            .push(format!("npm の部品を確認できませんでした: {e}")),
    }
    c
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UpdateOptions {
    /// プロジェクト（GitHub の最新）
    pub git: bool,
    /// Rust 本体
    pub rust: bool,
    /// Rust・npm の部品（互換性を保つ範囲）
    pub deps: bool,
}

fn script(root: &Path, name: &str) -> Result<PathBuf, String> {
    let p = root.join("tools").join(name);
    if p.is_file() {
        Ok(p)
    } else {
        Err(format!("{} が見つかりません", p.display()))
    }
}

/// 更新を新しいコンソールで始める（アプリは更新の最後に再起動される）
pub fn launch_update(root: &Path, o: UpdateOptions) -> Result<(), String> {
    let mut args = vec![];
    if o.git {
        args.push("-Git");
    }
    if o.rust {
        args.push("-Rust");
    }
    if o.deps {
        args.push("-Deps");
    }
    open_powershell(&script(root, "update.ps1")?, &args, root, false)
        .map_err(|e| format!("更新を始められません: {e}"))
}

/// 作り直し（更新なし）
pub fn launch_rebuild(root: &Path) -> Result<(), String> {
    open_powershell(&script(root, "update.ps1")?, &[], root, false)
        .map_err(|e| format!("作り直しを始められません: {e}"))
}

pub fn launch_rollback(root: &Path) -> Result<(), String> {
    open_powershell(&script(root, "rollback.ps1")?, &[], root, false)
        .map_err(|e| format!("元に戻せません: {e}"))
}

/// エラーの確認などに使う PowerShell を開く
pub fn open_terminal(root: &Path) -> Result<(), String> {
    open_powershell(&script(root, "terminal.ps1")?, &[], root, true)
        .map_err(|e| format!("PowerShell を開けません: {e}"))
}

pub fn install_ffmpeg(root: &Path) -> Result<(), String> {
    open_powershell(&script(root, "install-ffmpeg.ps1")?, &[], root, false)
        .map_err(|e| format!("インストールを始められません: {e}"))
}

pub fn open_folder(path: &Path) -> Result<(), String> {
    if !path.exists() {
        std::fs::create_dir_all(path).map_err(|e| format!("フォルダを作れません: {e}"))?;
    }
    std::process::Command::new("explorer.exe")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("フォルダを開けません: {e}"))
}

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_NAME: &str = "character_viewer";

/// Windows の起動時に自動で起動するか
pub fn autostart_enabled() -> bool {
    let mut cmd = hidden("reg.exe");
    cmd.args(["query", RUN_KEY, "/v", RUN_NAME]);
    matches!(output_text(cmd, QUICK), Ok((true, _)))
}

pub fn set_autostart(enabled: bool, exe: &Path) -> Result<(), String> {
    let mut cmd = hidden("reg.exe");
    if enabled {
        let value = format!("\"{}\" --minimized", exe.display());
        cmd.args([
            "add", RUN_KEY, "/v", RUN_NAME, "/t", "REG_SZ", "/d", &value, "/f",
        ]);
    } else {
        if !autostart_enabled() {
            return Ok(());
        }
        cmd.args(["delete", RUN_KEY, "/v", RUN_NAME, "/f"]);
    }
    match output_text(cmd, QUICK)? {
        (true, _) => Ok(()),
        (false, t) => Err(format!("自動起動の設定を変えられません: {}", t.trim())),
    }
}
