//! 入力デバイスが WASAPI の低遅延共有モード（IAudioClient3）で使える最小周期を調べる。
//! cpal は 10ms 固定の従来モードしか使わないため、さらに縮められるかをここで確認する。
//!
//! 実行: cargo run --release --example probe_latency

use windows::Win32::Media::Audio::{
    DEVICE_STATE_ACTIVE, IAudioClient3, IMMDeviceEnumerator, MMDeviceEnumerator, eCapture,
};
use windows::Win32::System::Com::{CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx};

fn main() -> windows::core::Result<()> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let devices = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)?;

        for i in 0..devices.GetCount()? {
            let device = devices.Item(i)?;
            let client: IAudioClient3 = device.Activate(CLSCTX_ALL, None)?;
            let fmt = client.GetMixFormat()?;
            let (sr, ch) = ((*fmt).nSamplesPerSec, (*fmt).nChannels);

            let (mut default, mut fundamental, mut min, mut max) = (0u32, 0u32, 0u32, 0u32);
            client.GetSharedModeEnginePeriod(fmt, &mut default, &mut fundamental, &mut min, &mut max)?;

            let ms = |frames: u32| frames as f64 * 1000.0 / sr as f64;
            println!("デバイス {}: {ch}ch / {sr}Hz", i + 1);
            println!("  既定周期 : {default} frames ({:.2} ms)", ms(default));
            println!("  最小周期 : {min} frames ({:.2} ms)", ms(min));
            println!("  最大周期 : {max} frames ({:.2} ms)", ms(max));
            println!("  刻み     : {fundamental} frames ({:.2} ms)", ms(fundamental));
            if min < default {
                println!("  → 低遅延共有モードに対応。最小 {:.2} ms まで縮められます", ms(min));
            } else {
                println!("  → 低遅延共有モード非対応（ドライバが 10ms 固定）");
            }
        }
    }
    Ok(())
}
