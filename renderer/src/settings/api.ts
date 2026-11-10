// エンジンの設定 API（engine/src/api.rs）を呼ぶ。

export type AvatarState = 'idle' | 'talk' | 'away' | 'sleep';

export interface Settings {
  version: number;
  audio: {
    device: string | null;
    channel: number;
    onDb: number;
    offDb: number;
    holdMs: number;
    hpfHz: number;
    voicing: number;
  };
  avatar: { awaySecs: number; sleepSecs: number; dir: string | null };
  display: { blink: boolean; blinkRate: number; mirror: boolean };
  server: { port: number };
}

export interface Info {
  version: string;
  port: number;
  root: string;
  settingsPath: string;
  logDir: string | null;
  logFile: string | null;
  avatarDir: string;
  defaultAvatarDir: string;
  rendererBuilt: boolean;
  ffmpeg: boolean;
  notices: string[];
  obsUrl: string;
  settingsUrl: string;
  isApp: boolean;
}

export interface Summary {
  count: number;
  avg: number;
  min: number;
  max: number;
}

export interface CalSegmentResult {
  label: string;
  target: boolean;
  reacted: boolean;
  starts: number;
  recall: number | null;
}

export interface CalOption {
  name: string;
  quietTarget: boolean;
  onDb: number;
  offDb: number;
  voicing: number;
  note: string | null;
  segments: CalSegmentResult[];
}

export interface CalibrationStatus {
  phase: 'countdown' | 'recording' | 'analyzing' | 'done' | 'error';
  segments: { label: string; prompt: string; secs: number }[];
  segment: number;
  remainingSecs: number;
  progress: number;
  levelDb: number;
  result: { options: CalOption[]; wav: string | null } | null;
  error: string | null;
}

export interface Status {
  state: AvatarState;
  speaking: boolean;
  silentSecs: number | null;
  levelDb: number;
  envDb: number;
  voicing: number;
  voiced: boolean;
  input: { name: string; sampleRate: number; channels: number; format: string; bufferFrames: number } | null;
  inputError: string | null;
  clients: number;
  latency: {
    detect: Summary;
    display: Summary;
    total: Summary;
    recent: { state: AvatarState; detectMs: number | null; displayMs: number | null }[];
  };
  calibration: CalibrationStatus | null;
}

export interface Device {
  index: number;
  name: string;
  isDefault: boolean;
  channels: number;
  sampleRate: number;
  format: string;
}

export interface SlotView {
  slot: 'image' | 'half' | 'closed';
  label: string;
  file: string | null;
  missing: boolean;
}

export interface AvatarView {
  dir: string;
  exists: boolean;
  states: { state: AvatarState; label: string; slots: SlotView[] }[];
  /** avatar.json に rig（パーツを重ねてボーンで動かす設定）がある */
  rig: boolean;
  error: string | null;
}

export interface Job<T = unknown> {
  id: number;
  kind: string;
  status: 'running' | 'done' | 'error';
  progress: string | null;
  result: T | null;
  error: string | null;
}

export interface LogLine {
  seq: number;
  time: string;
  level: 'error' | 'warn' | 'info';
  message: string;
}

export const STATE_LABELS: Record<AvatarState, string> = { idle: '待機', talk: '発話', away: '放置', sleep: '寝落ち' };

export class ApiError extends Error {}

async function call<T>(method: string, path: string, body?: unknown, raw?: Blob): Promise<T> {
  const headers: Record<string, string> = { 'X-CV': '1' };
  let payload: BodyInit | undefined;
  if (raw) {
    payload = raw;
    headers['Content-Type'] = raw.type || 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, cache: 'no-store' });
  } catch {
    throw new ApiError('エンジンに接続できません。アプリが起動しているか確認してください');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.error ?? `エラー（${res.status}）`);
  return data as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T = { ok: true }>(path: string, body: unknown = {}) => call<T>('POST', path, body),
  put: <T = { ok: true }>(path: string, body: unknown) => call<T>('PUT', path, body),
  del: <T = { ok: true }>(path: string) => call<T>('DELETE', path),
  upload: <T>(path: string, file: Blob) => call<T>('PUT', path, undefined, file),
};

/** 裏で動く処理を始めて、終わるまで待つ */
export async function runJob<T>(path: string, body: unknown, onProgress?: (p: string) => void): Promise<T> {
  const { job } = await api.post<{ job: number }>(path, body);
  for (;;) {
    await new Promise((r) => setTimeout(r, 400));
    const j = await api.get<Job<T>>(`/api/jobs/${job}`);
    if (j.progress && onProgress) onProgress(j.progress);
    if (j.status === 'done') return j.result as T;
    if (j.status === 'error') throw new ApiError(j.error ?? '失敗しました');
  }
}
