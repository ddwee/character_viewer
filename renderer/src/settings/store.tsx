// 設定画面の共有データ: 設定（変更すると少し待ってから自動保存）、状態、音量、通知。

import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';

import { api, type Info, type Settings, type Status } from './api';

// ───────────── 通知（画面右下） ─────────────

export interface Toast {
  id: number;
  kind: 'ok' | 'error' | 'info';
  text: string;
}

let toastId = 0;
const toastListeners = new Set<(t: Toast[]) => void>();
let toasts: Toast[] = [];

export function toast(text: string, kind: Toast['kind'] = 'ok'): void {
  const t = { id: ++toastId, kind, text };
  toasts = [...toasts, t].slice(-4);
  toastListeners.forEach((l) => l(toasts));
  setTimeout(
    () => {
      toasts = toasts.filter((x) => x.id !== t.id);
      toastListeners.forEach((l) => l(toasts));
    },
    kind === 'error' ? 8000 : 2500,
  );
}

export function useToasts(): Toast[] {
  const [list, setList] = useState(toasts);
  useEffect(() => {
    toastListeners.add(setList);
    return () => void toastListeners.delete(setList);
  }, []);
  return list;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ───────────── 設定 ─────────────

interface SettingsCtx {
  settings: Settings | null;
  /** 変更する（画面にはすぐ反映し、少し待ってからまとめて保存） */
  update: (f: (s: Settings) => void) => void;
  /** 保存が終わるまで待つ */
  flush: () => Promise<void>;
  replace: (s: Settings) => void;
  saving: boolean;
  error: string | null;
  info: Info | null;
  reloadInfo: () => void;
}

const Ctx = createContext<SettingsCtx | null>(null);

export function SettingsProvider({ children }: { children: ComponentChildren }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef<Settings | null>(null);
  const inflight = useRef<Promise<void>>(Promise.resolve());

  const reloadInfo = useCallback(() => {
    api.get<Info>('/api/info').then(setInfo).catch(() => {});
  }, []);

  useEffect(() => {
    api.get<Settings>('/api/settings').then((s) => {
      latest.current = s;
      setSettings(s);
    });
    reloadInfo();
  }, []);

  const save = useCallback(async () => {
    const s = latest.current;
    if (!s) return;
    setSaving(true);
    try {
      const r = await api.put<{ settings: Settings; restartRequired: boolean }>('/api/settings', s);
      setError(null);
      if (r.restartRequired) toast('ポートの変更は、アプリを再起動すると反映されます', 'info');
    } catch (e) {
      setError(errorText(e));
      toast(errorText(e), 'error');
    } finally {
      setSaving(false);
    }
  }, []);

  const update = useCallback((f: (s: Settings) => void) => {
    if (!latest.current) return;
    const next = structuredClone(latest.current);
    f(next);
    latest.current = next;
    setSettings(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      inflight.current = inflight.current.then(save);
    }, 350);
  }, []);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
      inflight.current = inflight.current.then(save);
    }
    await inflight.current;
  }, []);

  const replace = useCallback((s: Settings) => {
    latest.current = s;
    setSettings(s);
  }, []);

  return <Ctx.Provider value={{ settings, update, flush, replace, saving, error, info, reloadInfo }}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('SettingsProvider の外で使われています');
  return c;
}

// ───────────── 状態（定期的に取得） ─────────────

export function useStatus(intervalMs = 400): Status | null {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await api.get<Status>('/api/status');
        if (alive) setStatus(s);
      } catch {
        if (alive) setStatus(null);
      }
      if (alive) timer = setTimeout(tick, document.hidden ? 2000 : intervalMs);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [intervalMs]);
  return status;
}

// ───────────── 音量（WebSocket で約 30 回/秒） ─────────────

export interface Meter {
  db: number;
  voicing: number;
  voiced: boolean;
  connected: boolean;
}

export function useMeter(): Meter {
  const [m, setM] = useState<Meter>({ db: -120, voicing: 0, voiced: false, connected: false });
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const open = () => {
      ws = new WebSocket(`ws://${location.host}/ws?role=monitor`);
      ws.onopen = () => ws?.send(JSON.stringify({ type: 'subscribe', meter: true }));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'meter') setM({ db: msg.db, voicing: msg.voicing, voiced: msg.voiced, connected: true });
      };
      ws.onclose = () => {
        setM((x) => ({ ...x, connected: false }));
        if (!closed) retry = setTimeout(open, 1500);
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);
  return m;
}
