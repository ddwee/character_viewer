//! 時間のかかる処理（録画の解析・更新の確認など）を裏で動かし、設定画面から進み具合を見られるようにする。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;

const KEEP: usize = 30;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: u64,
    pub kind: String,
    /// running / done / error
    pub status: &'static str,
    pub progress: Option<String>,
    pub result: Option<Value>,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct Jobs {
    next: AtomicU64,
    map: Mutex<BTreeMap<u64, Job>>,
}

/// 処理の中から進み具合を伝える
pub struct Progress {
    jobs: Arc<Jobs>,
    id: u64,
}

impl Progress {
    pub fn set(&self, text: impl Into<String>) {
        if let Some(j) = self.jobs.lock().get_mut(&self.id) {
            j.progress = Some(text.into());
        }
    }
}

impl Jobs {
    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<u64, Job>> {
        self.map.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn spawn<F>(self: &Arc<Self>, kind: &str, f: F) -> u64
    where
        F: FnOnce(&Progress) -> Result<Value, String> + Send + 'static,
    {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        {
            let mut map = self.lock();
            map.insert(
                id,
                Job {
                    id,
                    kind: kind.into(),
                    status: "running",
                    progress: None,
                    result: None,
                    error: None,
                },
            );
            while map.len() > KEEP {
                let oldest = *map.keys().next().expect("空ではない");
                map.remove(&oldest);
            }
        }
        let jobs = self.clone();
        let kind = kind.to_string();
        std::thread::spawn(move || {
            let progress = Progress {
                jobs: jobs.clone(),
                id,
            };
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&progress)))
                .unwrap_or_else(|_| {
                    Err("処理中にエラーが起きました。ログを確認してください".into())
                });
            if let Err(e) = &outcome {
                log::warn!("{kind} が失敗しました: {e}");
            }
            if let Some(j) = jobs.lock().get_mut(&id) {
                match outcome {
                    Ok(v) => {
                        j.status = "done";
                        j.result = Some(v);
                    }
                    Err(e) => {
                        j.status = "error";
                        j.error = Some(e);
                    }
                }
            }
        });
        id
    }

    pub fn get(&self, id: u64) -> Option<Job> {
        self.lock().get(&id).cloned()
    }
}
