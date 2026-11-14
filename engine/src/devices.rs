//! 入力デバイス（マイク）の一覧と選択。

use anyhow::{Context, Result, bail};
use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    /// 一覧での番号（1 始まり）
    pub index: usize,
    pub name: String,
    pub is_default: bool,
    pub channels: u16,
    pub sample_rate: u32,
    pub format: String,
}

pub fn label(device: &cpal::Device) -> String {
    device
        .description()
        .map(|d| d.name().to_string())
        .or_else(|_| device.id().map(|id| id.to_string()))
        .unwrap_or_else(|_| "(名前不明)".into())
}

pub fn list() -> Result<Vec<DeviceInfo>> {
    let host = cpal::default_host();
    let default_id = host.default_input_device().and_then(|d| d.id().ok());
    Ok(host
        .input_devices()?
        .enumerate()
        .map(|(i, d)| {
            let cfg = d.default_input_config().ok();
            DeviceInfo {
                index: i + 1,
                name: label(&d),
                is_default: d.id().ok() == default_id,
                channels: cfg.as_ref().map_or(0, |c| c.channels()),
                sample_rate: cfg.as_ref().map_or(0, |c| c.sample_rate()),
                format: cfg
                    .as_ref()
                    .map_or(String::new(), |c| format!("{:?}", c.sample_format())),
            }
        })
        .collect())
}

/// デバイスを選ぶ。`query` は名前（完全一致を優先、なければ部分一致）か一覧の番号。None なら既定のマイク
pub fn select(query: Option<&str>) -> Result<cpal::Device> {
    let host = cpal::default_host();
    let Some(query) = query else {
        return host
            .default_input_device()
            .context("既定の入力デバイスが見つかりません");
    };
    let devices: Vec<_> = host.input_devices()?.collect();
    if let Some(i) = devices.iter().position(|d| label(d) == query) {
        return Ok(devices.into_iter().nth(i).expect("位置は確認済み"));
    }
    if let Ok(n) = query.parse::<usize>() {
        return devices
            .into_iter()
            .nth(n.wrapping_sub(1))
            .with_context(|| format!("デバイス番号 {n} は存在しません"));
    }
    let q = query.to_lowercase();
    let mut hits: Vec<_> = devices
        .into_iter()
        .filter(|d| label(d).to_lowercase().contains(&q))
        .collect();
    match hits.len() {
        0 => bail!(
            "「{query}」が見つかりません（接続を確認するか、設定画面でマイクを選び直してください）"
        ),
        1 => Ok(hits.remove(0)),
        _ => bail!("「{query}」に一致するデバイスが複数あります"),
    }
}
