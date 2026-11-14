// 描画ページ（OBS のブラウザソースで開く）。
// エンジンから WebSocket で届いた状態に合わせて透過画像を切り替え、まばたきもさせる。
//
// 絵が変わるときだけ描く（毎フレームは描き直さない）。OBS の負荷が軽く、
// 描き直しのタイミングによるちらつきも起きにくい。
//
// URL のオプション
//   ?debug    状態・接続・音量を左上に表示。キー 1〜4 で状態を手動で切り替え、B でまばたき
//   ?checker  背景を市松模様にする（ブラウザで透過を確認する用）
//   ?sync     遅延測定用。発話中は白、それ以外は黒で全体を塗る（cv-engine --measure-av で解析する）
//   ?engine=127.0.0.1:39540  エンジンの場所（通常は不要）
//   ?embed    設定画面の中のプレビュー用（エンジンへ描画の応答を返さない）

import { Application, Assets, Sprite, Texture } from 'pixi.js';
import 'pixi.js/prepare';

import { BlinkScheduler, type Eye } from './blink';

type AvatarState = 'idle' | 'talk' | 'away' | 'sleep';

const STATES: readonly AvatarState[] = ['idle', 'talk', 'away', 'sleep'];
const LABELS: Record<AvatarState, string> = { idle: '待機', talk: '発話', away: '放置', sleep: '寝落ち' };
/** 絵が用意されていない状態は、近い状態の絵で代用する */
const FALLBACK: Record<AvatarState, AvatarState | null> = { idle: null, talk: 'idle', away: 'idle', sleep: 'away' };

/** avatar.json の 1 状態ぶん。画像 1 枚だけなら文字列で書ける */
type StateEntry =
  | string
  | {
      image: string;
      /** まばたき用の絵（省略するとその状態ではまばたきしない） */
      blink?: { half?: string; closed: string };
    };

interface Manifest {
  states: Partial<Record<AvatarState, StateEntry>>;
}

/** 1 状態ぶんの絵 */
interface Look {
  open: Texture;
  half?: Texture;
  closed?: Texture;
}

/** 見た目の設定（設定画面で変える） */
interface DisplayConfig {
  blink: boolean;
  blinkRate: number;
  mirror: boolean;
}

type ServerMsg =
  | { type: 'hello'; version: number }
  | { type: 'state'; state: AvatarState; seq: number }
  | ({ type: 'config' } & DisplayConfig)
  | { type: 'reload' }
  | { type: 'meter'; db: number; voicing: number; voiced: boolean };

const PROTOCOL_VERSION = 1;
const RECONNECT_MS = 1000;
/** 切断がこれ以上続いたら待機の絵に戻す（短い再接続で絵がちらつかないように） */
const DISCONNECT_GRACE_MS = 2000;

const params = new URLSearchParams(location.search);
const debug = params.has('debug');
const syncMode = params.has('sync');
const embed = params.has('embed');
if (params.has('checker')) document.body.classList.add('checker');

const app = new Application();
const sprite = new Sprite();
const looks = new Map<AvatarState, Look>();
const blink = new BlinkScheduler(Math.random, performance.now());
const EMPTY_LOOK: Look = { open: Texture.EMPTY };

let current: AvatarState = 'idle';
let config: DisplayConfig = { blink: true, blinkRate: 1, mirror: false };
/** 素材を読み込み直すたびに増やす（ブラウザやPixiJSのキャッシュを避ける） */
let avatarVersion = 0;
let eye: Eye = 'open';
const stats = { changes: 0, reconnects: 0, blinks: 0, renders: 0 };

// ───────────────────────── 描画 ─────────────────────────

function lookFor(state: AvatarState): Look {
  for (let s: AvatarState | null = state; s; s = FALLBACK[s]) {
    const look = looks.get(s);
    if (look) return look;
  }
  return EMPTY_LOOK;
}

/** 画面に収まる最大サイズで、下端中央に置く */
function layout(): void {
  if (syncMode) return drawSync();
  const tex = sprite.texture;
  if (tex.width === 0 || tex.height === 0) return;
  const { width, height } = app.screen;
  const scale = Math.min(width / tex.width, height / tex.height);
  sprite.scale.set(config.mirror ? -scale : scale, scale);
  sprite.position.set(width / 2, height);
}

let frameRequested = false;
let wakeTimer: ReturnType<typeof setTimeout> | undefined;
/** 次の描画が終わったら返す ack */
let pendingAcks: number[] = [];
let sendAck: (seq: number) => void = () => {};

function requestFrame(): void {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(frame);
}

/** 遅延測定用: 発話中は白、それ以外は黒で全体を塗る */
function drawSync(): void {
  sprite.texture = Texture.WHITE;
  sprite.anchor.set(0, 0);
  sprite.position.set(0, 0);
  sprite.width = app.screen.width;
  sprite.height = app.screen.height;
  sprite.tint = current === 'talk' ? 0xffffff : 0x000000;
}

function drawAvatar(now: number, look: Look): void {
  const prevEye = eye;
  eye = look.closed && config.blink ? blink.update(now, look.half !== undefined) : 'open';
  if (prevEye === 'open' && eye !== 'open') stats.blinks++;

  const tex = (eye === 'closed' && look.closed) || (eye === 'half' && (look.half ?? look.closed)) || look.open;
  if (sprite.texture !== tex) {
    sprite.texture = tex;
    layout();
  }
}

function frame(now: number): void {
  frameRequested = false;
  const look = lookFor(current);
  if (syncMode) drawSync();
  else drawAvatar(now, look);
  app.render();
  stats.renders++;

  // 描き終えたので、エンジンに「描画した」と返す（遅延の測定用）
  for (const seq of pendingAcks) sendAck(seq);
  pendingAcks = [];

  // 次に描くべき時刻まで眠る（まばたき中は毎フレーム描く）
  clearTimeout(wakeTimer);
  if (!syncMode && look.closed && config.blink) {
    const wakeAt = blink.wakeAt();
    if (wakeAt <= now) requestFrame();
    else wakeTimer = setTimeout(requestFrame, wakeAt - now);
  }
}

function show(state: AvatarState): void {
  const prev = current;
  if (prev === state) return;
  current = state;

  const now = performance.now();
  blink.setTalking(state === 'talk');
  // まばたきできない絵（寝落ちなど）から戻ったら、予定を立て直す
  if (!lookFor(prev).closed && lookFor(state).closed) blink.reschedule(now);
  // 話し終わり・目覚めは、まばたきが起きやすい区切り
  if ((prev === 'talk' && state === 'idle') || ((prev === 'away' || prev === 'sleep') && state === 'talk')) {
    blink.cue(now);
  }
  overlay.render();
  requestFrame();
}

async function loadTexture(file: string): Promise<Texture> {
  const tex = await Assets.load<Texture>({ src: `avatar/${file}?v=${avatarVersion}`, alias: `${file}?v=${avatarVersion}` });
  // 縮小表示でも荒れないように（素材は表示サイズより大きく描く前提）
  tex.source.autoGenerateMipmaps = true;
  tex.source.scaleMode = 'linear';
  return tex;
}

async function loadLook(entry: StateEntry): Promise<Look> {
  if (typeof entry === 'string') return { open: await loadTexture(entry) };
  const [open, half, closed] = await Promise.all([
    loadTexture(entry.image),
    entry.blink?.half ? loadTexture(entry.blink.half) : undefined,
    entry.blink?.closed ? loadTexture(entry.blink.closed) : undefined,
  ]);
  return { open, half, closed };
}

/**
 * 素材を読み込む。読み込み直しのときは、新しい絵がすべて揃ってから入れ替える
 * （途中で失敗したら今の絵のまま）
 */
async function loadAvatar(): Promise<void> {
  avatarVersion++;
  const res = await fetch(`avatar/avatar.json?v=${avatarVersion}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`avatar/avatar.json を読み込めません（${res.status}）`);
  const manifest = (await res.json()) as Manifest;

  const next = new Map<AvatarState, Look>();
  await Promise.all(
    STATES.map(async (state) => {
      const entry = manifest.states?.[state];
      if (entry) next.set(state, await loadLook(entry));
    }),
  );
  if (!next.has('idle')) throw new Error('待機の絵が設定されていません（設定画面の「画像」で設定してください）');

  // 切り替えた瞬間にカクつかないよう、全画像を先に GPU へ送っておく
  const textures = (m: Map<AvatarState, Look>) => [...m.values()].flatMap((l) => [l.open, l.half, l.closed]).filter((t): t is Texture => !!t);
  await app.renderer.prepare.upload(textures(next));

  const old = textures(looks);
  looks.clear();
  for (const [k, v] of next) looks.set(k, v);
  sprite.texture = Texture.EMPTY;
  overlay.clearError();
  requestFrame();
  // 古い絵を GPU とキャッシュから外す（描き替えたあとで）
  requestAnimationFrame(() => {
    for (const t of old) if (!textures(looks).includes(t)) t.destroy(true);
  });
}

let reloading: Promise<void> | null = null;
let reloadAgain = false;

/** 素材が変わったという通知で読み込み直す（連続した通知はまとめる） */
function reloadAvatar(): void {
  if (reloading) {
    reloadAgain = true;
    return;
  }
  reloading = loadAvatar()
    .catch((e) => overlay.error(e instanceof Error ? e.message : String(e)))
    .finally(() => {
      reloading = null;
      if (reloadAgain) {
        reloadAgain = false;
        reloadAvatar();
      }
    });
}

// ───────────────────────── エンジンとの接続 ─────────────────────────

function engineUrl(): string {
  const host = params.get('engine') ?? location.host;
  // 設定画面のプレビューは「表示側」として数えない（OBS の接続数に混ざらないように）
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws${embed ? '?role=monitor' : ''}`;
}

let disconnectTimer: ReturnType<typeof setTimeout> | undefined;

function connect(): void {
  const ws = new WebSocket(engineUrl());
  const send = (msg: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

  ws.onopen = () => {
    clearTimeout(disconnectTimer);
    if (!embed) sendAck = (seq) => send({ type: 'ack', seq });
    overlay.connected(true);
    if (debug) send({ type: 'subscribe', meter: true });
  };

  ws.onmessage = (ev: MessageEvent<string>) => {
    const msg = JSON.parse(ev.data) as ServerMsg;
    switch (msg.type) {
      case 'hello':
        if (msg.version !== PROTOCOL_VERSION) {
          overlay.error(`エンジンと描画ページの版が違います（${msg.version} / ${PROTOCOL_VERSION}）`);
        }
        break;
      case 'state':
        if (msg.state !== current) stats.changes++;
        show(msg.state);
        pendingAcks.push(msg.seq);
        requestFrame();
        break;
      case 'config': {
        const { type: _, ...c } = msg;
        config = c;
        blink.setRate(config.blinkRate);
        blink.reschedule(performance.now());
        sprite.texture = Texture.EMPTY; // 反転などを反映させるため配置し直す
        requestFrame();
        break;
      }
      case 'reload':
        if (!syncMode) reloadAvatar();
        break;
      case 'meter':
        overlay.meter(msg.db, msg.voicing, msg.voiced);
        break;
    }
  };

  ws.onclose = () => {
    overlay.connected(false);
    // 短い切断ではそのまま。続くようなら喋りっぱなしにならないよう待機に戻す
    clearTimeout(disconnectTimer);
    disconnectTimer = setTimeout(() => show('idle'), DISCONNECT_GRACE_MS);
    setTimeout(() => {
      stats.reconnects++;
      connect();
    }, RECONNECT_MS);
  };
}

// ───────────────────────── デバッグ表示 ─────────────────────────

const overlay = (() => {
  const el = document.getElementById('overlay')!;
  const errorEl = document.getElementById('error')!;
  let conn = false;
  let level = '';

  const render = () => {
    if (!debug) return;
    el.textContent = [
      `接続 : ${conn ? '○ エンジンと接続中' : '× 未接続（再接続を試行中）'}`,
      `状態 : ${LABELS[current]}（${current}）`,
      level,
      `回数 : 切替 ${stats.changes} / 再接続 ${stats.reconnects} / まばたき ${stats.blinks} / 描画 ${stats.renders}`,
      'キー 1〜4 で状態を切り替え、B でまばたき',
    ]
      .filter(Boolean)
      .join('\n');
  };

  if (debug) {
    el.hidden = false;
    window.addEventListener('keydown', (e) => {
      const state = STATES[Number(e.key) - 1];
      if (state) show(state);
      if (e.key === 'b' || e.key === 'B') {
        blink.blinkNow(performance.now());
        requestFrame();
      }
    });
    // 回数の表示を 1 秒ごとに更新
    setInterval(render, 1000);
  }

  return {
    render,
    connected(v: boolean) {
      conn = v;
      render();
    },
    meter(db: number, voicing: number, voiced: boolean) {
      const bar = '#'.repeat(Math.round(Math.max(0, Math.min(1, (db + 70) / 70)) * 30)).padEnd(30, '-');
      level = `音量 : [${bar}] ${db.toFixed(1)} dB  声らしさ ${voicing.toFixed(2)}${voiced ? ' ♪' : ''}`;
      render();
    },
    clearError() {
      errorEl.hidden = true;
      errorEl.textContent = '';
    },
    error(message: string) {
      // OBS のプレビューでも気づけるよう、エラーは常に表示する
      errorEl.hidden = false;
      errorEl.textContent = message;
      console.error(message);
    },
  };
})();

// ───────────────────────── 起動 ─────────────────────────

async function main(): Promise<void> {
  await app.init({
    // 自動の描画ループは使わず、絵が変わるときだけ app.render() する
    autoStart: false,
    backgroundAlpha: 0,
    resizeTo: window,
    antialias: false,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    preference: 'webgl',
    powerPreference: 'high-performance',
  });
  app.ticker.stop();
  document.body.appendChild(app.canvas);

  sprite.anchor.set(0.5, 1);
  app.stage.addChild(sprite);
  app.renderer.on('resize', () => {
    layout();
    requestFrame();
  });

  if (!syncMode) {
    try {
      await loadAvatar();
    } catch (e) {
      overlay.error(e instanceof Error ? e.message : String(e));
    }
  }
  blink.reschedule(performance.now());
  overlay.render();
  requestFrame();
  connect();

  // 設定画面のプレビューから、状態やまばたきを試す（この画面の中だけ。OBS の表示には影響しない）
  if (embed) {
    window.addEventListener('message', (e: MessageEvent) => {
      if (e.origin !== location.origin) return;
      const m = e.data as { type?: string; state?: AvatarState };
      if (m.type === 'preview-state' && m.state && STATES.includes(m.state)) show(m.state);
      if (m.type === 'preview-blink') {
        blink.blinkNow(performance.now());
        requestFrame();
      }
    });
  }
}

main();
