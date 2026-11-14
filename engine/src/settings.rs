//! 設定（%APPDATA%\character_viewer\settings.json）。
//!
//! 互換性のため:
//! - 項目が足りなければ既定値で補い、知らない項目は無視する（古い・新しい設定ファイルのどちらも読める）
//! - 読めない設定ファイルは settings.broken-<時刻>.json に退避して既定値で起動する
//! - 保存は一時ファイルに書いてから置き換える（書き込み中に落ちても壊れない）

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::avatar::AvatarConfig;
use crate::detector::DetectorConfig;
use crate::pipeline::PipelineConfig;
use crate::pitch::VoicingConfig;

pub const SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_PORT: u16 = 39540;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    pub audio: AudioSettings,
    pub avatar: AvatarSettings,
    pub display: DisplaySettings,
    pub camera: CameraSettings,
    /// 表情を切り替えるキー（表情の名前 → "Ctrl+Alt+Digit1" のようなキーの組み合わせ）。
    /// アプリとして動いているときに、ほかのアプリを使っている間も効く
    pub hotkeys: BTreeMap<String, String>,
    pub server: ServerSettings,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioSettings {
    /// 入力デバイス名。None なら Windows の既定のマイク
    pub device: Option<String>,
    /// 判定に使う入力チャンネル（1 始まり）
    pub channel: usize,
    /// 発話開始のしきい値（dBFS）
    pub on_db: f32,
    /// 発話終了のしきい値（dBFS）
    pub off_db: f32,
    /// 声が途切れてから発話終了とみなすまで（ms）
    pub hold_ms: f32,
    /// ハイパスフィルタ（Hz）。0 で無効
    pub hpf_hz: f32,
    /// 声らしさのしきい値（0〜1）。0 で無効
    pub voicing: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AvatarSettings {
    /// 無言がこの秒数続いたら「放置」。0 で無効
    pub away_secs: f32,
    /// 無言がこの秒数続いたら「寝落ち」。0 で無効
    pub sleep_secs: f32,
    /// イラスト素材のフォルダ。None ならプロジェクトの avatar フォルダ
    pub dir: Option<PathBuf>,
}

/// 描画ページの見た目（描画ページへそのまま送る）
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DisplaySettings {
    /// まばたきする
    pub blink: bool,
    /// まばたきの頻度（1 = 標準。2 なら 2 倍）
    pub blink_rate: f32,
    /// 左右反転
    pub mirror: bool,
}

/// カメラで顔の向き・表情を読み取る設定（読み取りは tracker ページが行う。renderer/src/tracker）
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CameraSettings {
    /// カメラを使う
    pub enabled: bool,
    /// カメラの名前。None なら既定のカメラ
    pub device: Option<String>,
    /// 鏡のように動かす（自分が右に傾くと、画面のキャラクターも画面の右に傾く）
    pub mirror: bool,
    /// 顔をこの角度（度）まで横に向けると、キャラクターがいっぱいまで横を向く
    pub yaw_range: f32,
    /// 上下の角度（度）
    pub pitch_range: f32,
    /// 頭の傾きの倍率
    pub roll_gain: f32,
    /// 視線を動かす
    pub gaze: bool,
    /// 目の開き具合・まばたきを読み取る
    pub eyes: bool,
    /// 眉・口の表情を読み取る
    pub expressions: bool,
    /// 表情の出やすさ（1 = 標準。大きいほど小さな動きで表情が変わる）
    pub sensitivity: f32,
    /// 基準（正面を向いて無表情のときの値）。設定画面で測って保存する
    pub neutral: Option<serde_json::Value>,
    /// 表情の大きさ（本人がその表情をしたときの値）。設定画面の「表情を覚えさせる」で測る
    pub ranges: Option<serde_json::Value>,
}

impl Default for CameraSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            device: None,
            mirror: true,
            yaw_range: 30.0,
            pitch_range: 20.0,
            roll_gain: 1.0,
            gaze: true,
            eyes: true,
            expressions: true,
            sensitivity: 1.0,
            neutral: None,
            ranges: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ServerSettings {
    /// 描画ページ・設定画面のポート（変更はアプリの再起動後に反映）
    pub port: u16,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            audio: AudioSettings::default(),
            avatar: AvatarSettings::default(),
            display: DisplaySettings::default(),
            camera: CameraSettings::default(),
            hotkeys: BTreeMap::new(),
            server: ServerSettings::default(),
        }
    }
}

impl Default for AudioSettings {
    /// 既定値は 2026-11-07 のキャリブレーション結果（小声にも反応・雑音で誤反応 0 回）
    fn default() -> Self {
        Self {
            device: None,
            channel: 1,
            on_db: -32.0,
            off_db: -40.0,
            hold_ms: 250.0,
            hpf_hz: 80.0,
            voicing: 0.75,
        }
    }
}

impl Default for AvatarSettings {
    fn default() -> Self {
        Self {
            away_secs: 6.0,
            sleep_secs: 12.0,
            dir: None,
        }
    }
}

impl Default for DisplaySettings {
    fn default() -> Self {
        Self {
            blink: true,
            blink_rate: 1.0,
            mirror: false,
        }
    }
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self { port: DEFAULT_PORT }
    }
}

impl Settings {
    /// 読み込む。2 つ目は利用者に伝えるべき注意（設定ファイルが壊れていた等）
    pub fn load(path: &Path) -> (Self, Option<String>) {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (Self::default(), None),
            Err(e) => {
                return (
                    Self::default(),
                    Some(format!(
                        "設定ファイルを読めませんでした（{e}）。既定値で起動します"
                    )),
                );
            }
        };
        match serde_json::from_str::<Self>(text.trim_start_matches('\u{feff}')) {
            Ok(mut s) => {
                let note = s.sanitize();
                (s, note)
            }
            Err(e) => {
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs());
                let backup = path.with_file_name(format!("settings.broken-{stamp}.json"));
                let _ = std::fs::rename(path, &backup);
                (
                    Self::default(),
                    Some(format!(
                        "設定ファイルが壊れていたため既定値で起動しました（{e}）。元のファイルは {} に退避しました",
                        backup.display()
                    )),
                )
            }
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(
            &tmp,
            serde_json::to_string_pretty(self).expect("設定は必ず JSON にできる"),
        )?;
        std::fs::rename(&tmp, path)
    }

    /// 範囲外の値を直す。直したら説明を返す
    fn sanitize(&mut self) -> Option<String> {
        let before = self.clone();
        self.version = SCHEMA_VERSION;
        let a = &mut self.audio;
        a.channel = a.channel.max(1);
        a.on_db = a.on_db.clamp(-80.0, 0.0);
        a.off_db = a.off_db.clamp(-90.0, a.on_db);
        a.hold_ms = a.hold_ms.clamp(0.0, 3000.0);
        a.hpf_hz = a.hpf_hz.clamp(0.0, 500.0);
        a.voicing = a.voicing.clamp(0.0, 0.99);
        let v = &mut self.avatar;
        v.away_secs = v.away_secs.clamp(0.0, 86_400.0);
        v.sleep_secs = v.sleep_secs.clamp(0.0, 86_400.0);
        let d = &mut self.display;
        d.blink_rate = d.blink_rate.clamp(0.2, 5.0);
        let c = &mut self.camera;
        c.yaw_range = c.yaw_range.clamp(5.0, 90.0);
        c.pitch_range = c.pitch_range.clamp(5.0, 90.0);
        c.roll_gain = c.roll_gain.clamp(0.0, 3.0);
        c.sensitivity = c.sensitivity.clamp(0.3, 3.0);
        self.hotkeys
            .retain(|name, keys| !name.is_empty() && !keys.is_empty() && keys.len() <= 64);
        if self.server.port < 1024 {
            self.server.port = DEFAULT_PORT;
        }
        (before.audio != self.audio
            || before.avatar != self.avatar
            || before.display != self.display
            || before.camera != self.camera
            || before.hotkeys != self.hotkeys
            || before.server != self.server)
            .then(|| "設定ファイルに範囲外の値があったため直しました".to_string())
    }

    /// 保存してよい設定か調べる
    pub fn validate(&self) -> Result<(), String> {
        let a = &self.audio;
        if a.channel == 0 {
            return Err("チャンネルは 1 以上にしてください".into());
        }
        if a.off_db > a.on_db {
            return Err("「話し終わりの音量」は「話し始めの音量」以下にしてください".into());
        }
        if !(-80.0..=0.0).contains(&a.on_db) {
            return Err("話し始めの音量は -80〜0 dB にしてください".into());
        }
        if !(0.0..1.0).contains(&a.voicing) {
            return Err("声らしさは 0〜0.99 にしてください".into());
        }
        let v = &self.avatar;
        if v.away_secs < 0.0 || v.sleep_secs < 0.0 {
            return Err("秒数は 0 以上にしてください".into());
        }
        if v.away_secs > 0.0 && v.sleep_secs > 0.0 && v.sleep_secs <= v.away_secs {
            return Err("「寝落ち」までの秒数は「放置」までより長くしてください".into());
        }
        if !(0.2..=5.0).contains(&self.display.blink_rate) {
            return Err("まばたきの頻度は 0.2〜5 倍にしてください".into());
        }
        let c = &self.camera;
        if !(5.0..=90.0).contains(&c.yaw_range) || !(5.0..=90.0).contains(&c.pitch_range) {
            return Err("顔の向きの角度は 5〜90 度にしてください".into());
        }
        if !(0.0..=3.0).contains(&c.roll_gain) || !(0.3..=3.0).contains(&c.sensitivity) {
            return Err("カメラの倍率が範囲外です".into());
        }
        if self.hotkeys.len() > 64
            || self
                .hotkeys
                .iter()
                .any(|(n, k)| n.is_empty() || k.is_empty() || k.len() > 64)
        {
            return Err("キーの割り当てが正しくありません".into());
        }
        if self.server.port < 1024 {
            return Err("ポートは 1024 以上にしてください".into());
        }
        Ok(())
    }

    pub fn pipeline_config(&self) -> PipelineConfig {
        let a = &self.audio;
        PipelineConfig {
            detector: DetectorConfig {
                on_db: a.on_db,
                off_db: a.off_db,
                hold_ms: a.hold_ms,
                ..Default::default()
            },
            hpf_hz: a.hpf_hz,
            voicing: (a.voicing > 0.0).then(|| VoicingConfig {
                enter: a.voicing,
                exit: (a.voicing - 0.15).max(0.0),
                ..Default::default()
            }),
        }
    }

    pub fn avatar_config(&self) -> AvatarConfig {
        let secs = |s: f32| (s > 0.0).then(|| Duration::from_secs_f32(s));
        AvatarConfig {
            away_after: secs(self.avatar.away_secs),
            sleep_after: secs(self.avatar.sleep_secs),
        }
    }
}

/// 設定・ログ・録音などを置くフォルダ（%APPDATA%\character_viewer）
pub fn data_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("character_viewer")
}

pub fn settings_path() -> PathBuf {
    data_dir().join("settings.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cv-settings-test-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    #[test]
    fn missing_file_gives_defaults() {
        let (s, note) = Settings::load(&tmp("missing"));
        assert_eq!(s, Settings::default());
        assert!(note.is_none());
    }

    #[test]
    fn roundtrip() {
        let p = tmp("roundtrip");
        let mut s = Settings::default();
        s.audio.on_db = -36.0;
        s.audio.device = Some("ライン (PLATANE1 1/2)".into());
        s.save(&p).unwrap();
        assert_eq!(Settings::load(&p).0, s);
    }

    #[test]
    fn old_or_new_files_still_load() {
        let p = tmp("compat");
        // 項目が欠けた古い形式と、知らない項目がある新しい形式
        std::fs::write(
            &p,
            r#"{"audio":{"onDb":-30},"future":{"x":1},"display":{"blink":false,"newThing":3}}"#,
        )
        .unwrap();
        let (s, _) = Settings::load(&p);
        assert_eq!(s.audio.on_db, -30.0);
        assert_eq!(s.audio.off_db, AudioSettings::default().off_db);
        assert!(!s.display.blink);
        assert_eq!(s.server.port, DEFAULT_PORT);
        // カメラの設定がない古いファイルは、カメラを使わない設定になる
        assert_eq!(s.camera, CameraSettings::default());
        assert!(!s.camera.enabled && s.camera.mirror);
    }

    #[test]
    fn broken_file_is_backed_up() {
        let p = tmp("broken");
        std::fs::write(&p, "{ これは JSON ではない").unwrap();
        let (s, note) = Settings::load(&p);
        assert_eq!(s, Settings::default());
        assert!(note.unwrap().contains("退避"));
        assert!(!p.exists());
    }

    #[test]
    fn validation_catches_inconsistent_values() {
        let mut s = Settings::default();
        assert!(s.validate().is_ok());
        s.audio.off_db = -20.0;
        assert!(s.validate().is_err());
        s = Settings::default();
        s.avatar.sleep_secs = 3.0;
        assert!(s.validate().is_err());
    }
}
