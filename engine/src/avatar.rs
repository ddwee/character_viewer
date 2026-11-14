//! 表示する絵の状態（待機 / 発話 / 放置 / 寝落ち）を決める。
//!
//! 発話判定（`detector`）の開始・終了と経過時間だけから決まる純粋なロジック。
//! 時刻は呼び出し側が渡すので、実時間でも録音の再生でも同じように動く。

use std::time::Duration;

use serde::Serialize;

use crate::detector::Transition;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AvatarState {
    /// 待機（喋っていない）
    #[default]
    Idle,
    /// 発話中
    Talk,
    /// しばらく無言
    Away,
    /// 長く無言
    Sleep,
}

impl AvatarState {
    pub fn label(self) -> &'static str {
        match self {
            Self::Idle => "待機",
            Self::Talk => "発話",
            Self::Away => "放置",
            Self::Sleep => "寝落ち",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct AvatarConfig {
    /// 無音が始まってから「放置」になるまで。None で無効
    pub away_after: Option<Duration>,
    /// 無音が始まってから「寝落ち」になるまで。None で無効
    pub sleep_after: Option<Duration>,
}

impl Default for AvatarConfig {
    fn default() -> Self {
        Self {
            away_after: Some(Duration::from_secs(6)),
            sleep_after: Some(Duration::from_secs(12)),
        }
    }
}

pub struct AvatarMachine {
    cfg: AvatarConfig,
    state: AvatarState,
    /// 無音が始まった時刻（発話中は None）
    silent_since: Option<Duration>,
}

impl AvatarMachine {
    pub fn new(cfg: AvatarConfig, now: Duration) -> Self {
        Self {
            cfg,
            state: AvatarState::Idle,
            silent_since: Some(now),
        }
    }

    pub fn state(&self) -> AvatarState {
        self.state
    }

    /// 放置・寝落ちまでの秒数を変える（次の `tick` から反映）
    pub fn set_config(&mut self, cfg: AvatarConfig) {
        self.cfg = cfg;
    }

    /// 無音が続いている時間（発話中は None）
    pub fn silent_for(&self, now: Duration) -> Option<Duration> {
        self.silent_since.map(|s| now.saturating_sub(s))
    }

    /// 発話の開始・終了を反映する。状態が変わったら新しい状態を返す
    pub fn on_transition(&mut self, kind: Transition, now: Duration) -> Option<AvatarState> {
        match kind {
            Transition::SpeechStart => self.silent_since = None,
            Transition::SpeechEnd => self.silent_since = Some(now),
        }
        self.tick(now)
    }

    /// 経過時間を反映する。状態が変わったら新しい状態を返す
    pub fn tick(&mut self, now: Duration) -> Option<AvatarState> {
        let next = match self.silent_for(now) {
            None => AvatarState::Talk,
            Some(d) if self.cfg.sleep_after.is_some_and(|t| d >= t) => AvatarState::Sleep,
            Some(d) if self.cfg.away_after.is_some_and(|t| d >= t) => AvatarState::Away,
            Some(_) => AvatarState::Idle,
        };
        (next != self.state).then(|| {
            self.state = next;
            next
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(secs: f32) -> Duration {
        Duration::from_secs_f32(secs)
    }

    fn machine() -> AvatarMachine {
        AvatarMachine::new(
            AvatarConfig {
                away_after: Some(s(30.0)),
                sleep_after: Some(s(180.0)),
            },
            s(0.0),
        )
    }

    #[test]
    fn silence_goes_idle_then_away_then_sleep() {
        let mut m = machine();
        assert_eq!(m.state(), AvatarState::Idle);
        assert_eq!(m.tick(s(29.9)), None);
        assert_eq!(m.tick(s(30.0)), Some(AvatarState::Away));
        assert_eq!(m.tick(s(100.0)), None);
        assert_eq!(m.tick(s(180.0)), Some(AvatarState::Sleep));
    }

    #[test]
    fn speech_wakes_up_immediately_from_any_state() {
        let mut m = machine();
        m.tick(s(200.0));
        assert_eq!(m.state(), AvatarState::Sleep);
        assert_eq!(
            m.on_transition(Transition::SpeechStart, s(200.0)),
            Some(AvatarState::Talk)
        );
        // 喋っている間は時間が経っても発話のまま
        assert_eq!(m.tick(s(500.0)), None);
        assert_eq!(
            m.on_transition(Transition::SpeechEnd, s(500.0)),
            Some(AvatarState::Idle)
        );
        // 無音の時間は発話終了から数え直す
        assert_eq!(m.tick(s(529.0)), None);
        assert_eq!(m.tick(s(530.0)), Some(AvatarState::Away));
    }

    #[test]
    fn disabled_timers_stay_idle() {
        let mut m = AvatarMachine::new(
            AvatarConfig {
                away_after: None,
                sleep_after: None,
            },
            s(0.0),
        );
        assert_eq!(m.tick(s(10_000.0)), None);
        assert_eq!(m.state(), AvatarState::Idle);
    }

    #[test]
    fn sleep_without_away() {
        let mut m = AvatarMachine::new(
            AvatarConfig {
                away_after: None,
                sleep_after: Some(s(60.0)),
            },
            s(0.0),
        );
        assert_eq!(m.tick(s(59.0)), None);
        assert_eq!(m.tick(s(60.0)), Some(AvatarState::Sleep));
    }
}
