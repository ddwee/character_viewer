//! イラスト素材（avatar.json と画像）の読み書き。
//!
//! 設定画面で画像を選ぶと、素材フォルダに `idle.png` / `idle_half.png` / `idle_closed.png` のような
//! 決まった名前でコピーし、avatar.json を書き換える。知らない項目は消さずに残す。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const STATES: [(&str, &str); 4] = [
    ("idle", "待機"),
    ("talk", "発話"),
    ("away", "放置"),
    ("sleep", "寝落ち"),
];
pub const SLOTS: [(&str, &str); 3] = [("image", "通常"), ("half", "半目"), ("closed", "閉じ目")];
const EXTENSIONS: [&str; 7] = ["png", "webp", "jpg", "jpeg", "svg", "avif", "gif"];
pub const MAX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
enum Entry {
    Simple(String),
    Full {
        image: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        blink: Option<Blink>,
        #[serde(flatten)]
        other: BTreeMap<String, Value>,
    },
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Blink {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    half: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    closed: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Manifest {
    #[serde(default)]
    states: BTreeMap<String, Entry>,
    #[serde(flatten)]
    other: BTreeMap<String, Value>,
}

impl Entry {
    fn get(&self, slot: &str) -> Option<&str> {
        match (self, slot) {
            (Self::Simple(s), "image") => Some(s),
            (Self::Full { image, .. }, "image") => Some(image),
            (Self::Full { blink: Some(b), .. }, "half") => b.half.as_deref(),
            (Self::Full { blink: Some(b), .. }, "closed") => b.closed.as_deref(),
            _ => None,
        }
    }

    /// 単純な形に戻せるなら戻す
    fn normalize(self) -> Self {
        match self {
            Self::Full {
                image,
                blink,
                other,
            } if other.is_empty()
                && blink
                    .as_ref()
                    .is_none_or(|b| b.half.is_none() && b.closed.is_none()) =>
            {
                Self::Simple(image)
            }
            e => e,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotView {
    pub slot: &'static str,
    pub label: &'static str,
    /// avatar フォルダからの相対パス
    pub file: Option<String>,
    /// ファイルが見つからない
    pub missing: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateView {
    pub state: &'static str,
    pub label: &'static str,
    pub slots: Vec<SlotView>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarView {
    pub dir: PathBuf,
    pub exists: bool,
    pub states: Vec<StateView>,
    pub error: Option<String>,
}

fn manifest_path(dir: &Path) -> PathBuf {
    dir.join("avatar.json")
}

fn load(dir: &Path) -> Result<Manifest, String> {
    match std::fs::read_to_string(manifest_path(dir)) {
        Ok(t) => serde_json::from_str(t.trim_start_matches('\u{feff}'))
            .map_err(|e| format!("avatar.json を読めません: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Manifest::default()),
        Err(e) => Err(format!("avatar.json を読めません: {e}")),
    }
}

fn save(dir: &Path, m: &Manifest) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("フォルダを作れません: {e}"))?;
    let tmp = dir.join("avatar.json.tmp");
    let text = serde_json::to_string_pretty(m).expect("必ず JSON にできる") + "\n";
    std::fs::write(&tmp, text).map_err(|e| format!("avatar.json を保存できません: {e}"))?;
    std::fs::rename(&tmp, manifest_path(dir))
        .map_err(|e| format!("avatar.json を保存できません: {e}"))
}

pub fn view(dir: &Path) -> AvatarView {
    let (m, error) = match load(dir) {
        Ok(m) => (m, None),
        Err(e) => (Manifest::default(), Some(e)),
    };
    let states = STATES
        .iter()
        .map(|&(state, label)| StateView {
            state,
            label,
            slots: SLOTS
                .iter()
                .map(|&(slot, slot_label)| {
                    let file = m
                        .states
                        .get(state)
                        .and_then(|e| e.get(slot))
                        .map(str::to_string);
                    let missing = file.as_ref().is_some_and(|f| !dir.join(f).is_file());
                    SlotView {
                        slot,
                        label: slot_label,
                        file,
                        missing,
                    }
                })
                .collect(),
        })
        .collect();
    AvatarView {
        dir: dir.to_path_buf(),
        exists: dir.is_dir(),
        states,
        error,
    }
}

fn check(state: &str, slot: &str) -> Result<(), String> {
    if !STATES.iter().any(|s| s.0 == state) {
        return Err(format!("不明な状態です: {state}"));
    }
    if !SLOTS.iter().any(|s| s.0 == slot) {
        return Err(format!("不明な画像の種類です: {slot}"));
    }
    Ok(())
}

/// 画像を素材フォルダに保存して avatar.json に登録する。戻り値は保存したファイル名
pub fn set_slot(
    dir: &Path,
    state: &str,
    slot: &str,
    original_name: &str,
    bytes: &[u8],
) -> Result<String, String> {
    check(state, slot)?;
    if bytes.is_empty() {
        return Err("空のファイルです".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err("ファイルが大きすぎます（64MB まで）".into());
    }
    let ext = Path::new(original_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    if !EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "対応していない形式です（{}）",
            EXTENSIONS.join(" / ")
        ));
    }
    let mut m = load(dir)?;
    if slot != "image"
        && m.states
            .get(state)
            .and_then(|e| e.get("image"))
            .is_none_or(str::is_empty)
    {
        return Err("先に通常の絵を設定してください".into());
    }
    let base = if slot == "image" {
        state.to_string()
    } else {
        format!("{state}_{slot}")
    };
    let file = format!("{base}.{ext}");
    std::fs::create_dir_all(dir).map_err(|e| format!("フォルダを作れません: {e}"))?;
    let tmp = dir.join(format!("{file}.tmp"));
    std::fs::write(&tmp, bytes).map_err(|e| format!("画像を保存できません: {e}"))?;
    std::fs::rename(&tmp, dir.join(&file)).map_err(|e| format!("画像を保存できません: {e}"))?;

    let entry = m.states.remove(state);
    let (mut image, mut blink, other) = match entry {
        Some(Entry::Simple(s)) => (Some(s), Blink::default(), BTreeMap::new()),
        Some(Entry::Full {
            image,
            blink,
            other,
        }) => (Some(image), blink.unwrap_or_default(), other),
        None => (None, Blink::default(), BTreeMap::new()),
    };
    match slot {
        "image" => image = Some(file.clone()),
        "half" => blink.half = Some(file.clone()),
        _ => blink.closed = Some(file.clone()),
    }
    let image = image.unwrap_or_else(|| file.clone());
    m.states.insert(
        state.into(),
        Entry::Full {
            image,
            blink: Some(blink),
            other,
        }
        .normalize(),
    );
    save(dir, &m)?;
    Ok(file)
}

/// 登録を外す（画像ファイルは消さない）
pub fn clear_slot(dir: &Path, state: &str, slot: &str) -> Result<(), String> {
    check(state, slot)?;
    if state == "idle" && slot == "image" {
        return Err("待機の絵は外せません（差し替えてください）".into());
    }
    let mut m = load(dir)?;
    if slot == "image" {
        m.states.remove(state);
    } else if let Some(Entry::Full {
        image,
        blink,
        other,
    }) = m.states.remove(state)
    {
        let mut b = blink.unwrap_or_default();
        if slot == "half" {
            b.half = None;
        } else {
            b.closed = None;
        }
        m.states.insert(
            state.into(),
            Entry::Full {
                image,
                blink: Some(b),
                other,
            }
            .normalize(),
        );
    } else if let Some(e) = load(dir)?.states.remove(state) {
        m.states.insert(state.into(), e);
    }
    save(dir, &m)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cv-avatar-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn set_and_clear_slots() {
        let d = tmp("slots");
        set_slot(&d, "idle", "image", "my idle.PNG", b"x").unwrap();
        assert_eq!(
            view(&d).states[0].slots[0].file.as_deref(),
            Some("idle.png")
        );
        set_slot(&d, "idle", "closed", "c.png", b"y").unwrap();
        set_slot(&d, "idle", "half", "h.webp", b"z").unwrap();
        let text = std::fs::read_to_string(d.join("avatar.json")).unwrap();
        assert!(
            text.contains("idle_closed.png") && text.contains("idle_half.webp"),
            "{text}"
        );
        clear_slot(&d, "idle", "half").unwrap();
        clear_slot(&d, "idle", "closed").unwrap();
        // まばたきがなくなったら単純な形に戻る
        let v: Value =
            serde_json::from_str(&std::fs::read_to_string(d.join("avatar.json")).unwrap()).unwrap();
        assert_eq!(v["states"]["idle"], "idle.png");
        assert!(clear_slot(&d, "idle", "image").is_err());
    }

    #[test]
    fn keeps_unknown_fields_and_rejects_bad_input() {
        let d = tmp("unknown");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(
            d.join("avatar.json"),
            r#"{"states":{"talk":{"image":"t.png","layer":3}},"future":true}"#,
        )
        .unwrap();
        set_slot(&d, "talk", "closed", "c.png", b"y").unwrap();
        let v: Value =
            serde_json::from_str(&std::fs::read_to_string(d.join("avatar.json")).unwrap()).unwrap();
        assert_eq!(v["future"], true);
        assert_eq!(v["states"]["talk"]["layer"], 3);
        assert_eq!(v["states"]["talk"]["blink"]["closed"], "talk_closed.png");
        assert!(set_slot(&d, "talk", "image", "evil.exe", b"x").is_err());
        assert!(set_slot(&d, "../x", "image", "a.png", b"x").is_err());
    }
}
