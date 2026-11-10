// 描画ページ（OBS のブラウザソースで開く）。
// エンジンから WebSocket で届いた状態に合わせて絵を変える。表示のしかたは素材によって 2 通り:
//
// - 1 枚絵: 状態ごとの透過画像を切り替え、まばたきもさせる。
//   絵が変わるときだけ描く（毎フレームは描き直さない）。OBS の負荷が軽く、ちらつきも起きにくい
// - パーツ（avatar.json に rig があるとき）: パーツを重ね、ボーンで動かす（呼吸・頭の揺れ・髪の揺れ・口パク・まばたき）。
//   動き続けるので毎フレーム描く。口の開き具合はエンジンから約 100 回/秒で届く音量で決める
//
// URL のオプション
//   ?debug    状態・接続・音量を左上に表示。キー 1〜4 で状態を手動で切り替え（発話は声のまね付き）、B でまばたき
//   ?checker  背景を市松模様にする（ブラウザで透過を確認する用）
//   ?sync     遅延測定用。発話中は白、それ以外は黒で全体を塗る（cv-engine --measure-av で解析する）
//   ?engine=127.0.0.1:39540  エンジンの場所（通常は不要）
//   ?embed    設定画面の中のプレビュー用（エンジンへ描画の応答を返さない）

import { Application, Assets, Sprite, Texture } from 'pixi.js';
import 'pixi.js/prepare';

import { BlinkScheduler, type Eye } from './blink';
import { parseRig, rigImages, type Rig } from './rig/manifest';
import { Animator } from './rig/motion';
import { MouthController, type Mouth } from './rig/mouth';
import { RigView } from './rig/view';

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
  states?: Partial<Record<AvatarState, StateEntry>>;
  /** パーツを重ねてボーンで動かす設定（あれば states は使わない） */
  rig?: unknown;
}

/** 1 状態ぶんの絵 */
interface Look {
  open: Texture;
  half?: Texture;
  closed?: Texture;
}

/** パーツで動かす素材 */
interface RigAvatar {
  rig: Rig;
  view: RigView;
  animator: Animator;
  /** ファイル名 → テクスチャ（rig だけ変わったときは使い回す） */
  textures: Map<string, Texture>;
  /** 読み込んだ rig の JSON（変わっていなければ組み直さない） */
  source: string;
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
  /** images が false なら変わったのは avatar.json だけ（古いエンジンは images を送らない） */
  | { type: 'reload'; images?: boolean }
  | { type: 'meter'; db: number; voicing: number; voiced: boolean }
  | { type: 'level'; db: number };

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
const mouth = new MouthController();
/** パーツで動かす素材（1 枚絵のときは null） */
let rigAvatar: RigAvatar | null = null;
/** 前のフレームの時刻（パーツの動き用） */
let lastFrameAt: number | null = null;
/** 発話をプレビュー・デバッグで試しているとき、声のまねをする（エンジンの音量の代わり） */
let simulateVoice = false;
let mouthShape: Mouth = 'closed';

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

/** パーツが動いてはみ出さないよう、上と左右に空けておく割合 */
const RIG_MARGIN = 0.03;

/** 画面に収まる最大サイズで、下端中央に置く */
function layout(): void {
  if (syncMode) return drawSync();
  if (rigAvatar) {
    const [w, h] = rigAvatar.view.size;
    const root = rigAvatar.view.root;
    const { width, height } = app.screen;
    const scale = Math.min(width / (w * (1 + 2 * RIG_MARGIN)), height / (h * (1 + RIG_MARGIN)));
    root.pivot.set(w / 2, h);
    root.scale.set(config.mirror ? -scale : scale, scale);
    root.position.set(width / 2, height);
    return;
  }
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

/** 声のまね（1 秒に 5 回ほど口が開閉する音量） */
function fakeLevel(now: number): number {
  const t = now / 1000;
  return -18 - 24 * (1 - Math.abs(Math.sin(Math.PI * 2.6 * t)) * (0.75 + 0.25 * Math.sin(t * 1.7)));
}

/** その状態でまばたきするか */
function blinksIn(state: AvatarState): boolean {
  if (!config.blink) return false;
  if (rigAvatar) return rigAvatar.view.canBlink && !rigAvatar.animator.eyesFor(state);
  return !!lookFor(state).closed;
}

function drawRig(now: number, av: RigAvatar): void {
  const dt = lastFrameAt === null ? 0 : (now - lastFrameAt) / 1000;
  lastFrameAt = now;

  if (simulateVoice && current === 'talk') mouth.level(fakeLevel(now), now);
  mouthShape = mouth.update(now);

  const prevEye = eye;
  // 状態で目を固定するとき（寝落ちなど）は表情の絵、そうでなければ瞬き
  const fixed = av.animator.eyesFor(current);
  eye = fixed ?? (blinksIn(current) ? blink.update(now, av.view.hasHalfEyes) : 'open');
  if (prevEye === 'open' && eye !== 'open' && !fixed) stats.blinks++;

  av.animator.update({ t: now / 1000, dt, state: current, mouth: current === 'talk' ? mouth.amount : 0 });
  av.view.update(av.animator.skeleton, mouthShape, eye, fixed === undefined);
}

function frame(now: number): void {
  frameRequested = false;
  const look = lookFor(current);
  if (syncMode) drawSync();
  else if (rigAvatar) drawRig(now, rigAvatar);
  else drawAvatar(now, look);
  app.render();
  stats.renders++;

  // 描き終えたので、エンジンに「描画した」と返す（遅延の測定用）
  for (const seq of pendingAcks) sendAck(seq);
  pendingAcks = [];

  // パーツで動かすときは毎フレーム描く
  clearTimeout(wakeTimer);
  if (!syncMode && rigAvatar) {
    requestFrame();
    return;
  }
  lastFrameAt = null;
  // 次に描くべき時刻まで眠る（まばたき中は毎フレーム描く）
  if (!syncMode && look.closed && config.blink) {
    const wakeAt = blink.wakeAt();
    if (wakeAt <= now) requestFrame();
    else wakeTimer = setTimeout(requestFrame, wakeAt - now);
  }
}

/** 状態を変える。`simulated` はプレビュー・デバッグで試すとき（発話なら声のまねをする） */
function show(state: AvatarState, simulated = false): void {
  simulateVoice = simulated;
  const prev = current;
  if (prev === state) return;
  current = state;

  const now = performance.now();
  blink.setTalking(state === 'talk');
  mouth.setTalking(state === 'talk', now);
  // まばたきできない絵（寝落ちなど）から戻ったら、予定を立て直す
  if (!blinksIn(prev) && blinksIn(state)) blink.reschedule(now);
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
 * パーツの素材を用意する。`reuse` にある画像は読み直さずに使う（rig だけ変わったとき）。
 * 新しく読んだ画像は GPU へ送るところまで済ませる
 */
async function loadRig(raw: unknown, reuse?: Map<string, Texture>): Promise<RigAvatar> {
  const rig = parseRig(raw);
  const files = rigImages(rig);
  const textures = new Map<string, Texture>();
  const fresh: Texture[] = [];
  await Promise.all(
    files.map(async (f) => {
      let t = reuse?.get(f);
      if (!t) fresh.push((t = await loadTexture(f)));
      textures.set(f, t);
    }),
  );
  await app.renderer.prepare.upload(fresh);
  return { rig, view: new RigView(rig, textures), animator: new Animator(rig), textures, source: JSON.stringify(raw) };
}

/** 入れ替える前の絵を、描き替えたあとで GPU とキャッシュから外す（新しい絵でも使うものは残す） */
function retireOld(oldLooks: Texture[], oldRig: RigAvatar | null): void {
  requestAnimationFrame(() => {
    const keep = new Set<Texture | undefined>([...looks.values()].flatMap((l) => [l.open, l.half, l.closed]));
    for (const t of rigAvatar?.textures.values() ?? []) keep.add(t);
    for (const t of oldLooks) if (!keep.has(t)) t.destroy(true);
    if (oldRig) {
      oldRig.view.destroy();
      for (const t of oldRig.textures.values()) if (!keep.has(t)) t.destroy(true);
    }
  });
}

/**
 * 素材を読み込む。読み込み直しのときは、新しい絵がすべて揃ってから入れ替える
 * （途中で失敗したら今の絵のまま）。
 * `images` が false なら avatar.json だけが変わったので、パーツの画像は読み直さない
 */
async function loadAvatar(images = true): Promise<void> {
  avatarVersion++;
  const res = await fetch(`avatar/avatar.json?v=${avatarVersion}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`avatar/avatar.json を読み込めません（${res.status}）`);
  const manifest = (await res.json()) as Manifest;

  const textures = (m: Map<AvatarState, Look>) => [...m.values()].flatMap((l) => [l.open, l.half, l.closed]).filter((t): t is Texture => !!t);

  if (manifest.rig !== undefined) {
    // 同じ rig なら何もしない（設定画面の保存と、フォルダの監視で 2 回通知が来る）
    if (!images && rigAvatar?.source === JSON.stringify(manifest.rig)) return;
    const next = await loadRig(manifest.rig, images ? undefined : rigAvatar?.textures);
    const oldLooks = textures(looks);
    const oldRig = rigAvatar;
    looks.clear();
    oldRig?.view.root.removeFromParent();
    sprite.visible = false;
    rigAvatar = next;
    app.stage.addChild(next.view.root);
    lastFrameAt = null;
    layout();
    overlay.clearError();
    subscribe();
    requestFrame();
    retireOld(oldLooks, oldRig);
    return;
  }

  const next = new Map<AvatarState, Look>();
  await Promise.all(
    STATES.map(async (state) => {
      const entry = manifest.states?.[state];
      if (entry) next.set(state, await loadLook(entry));
    }),
  );
  if (!next.has('idle')) throw new Error('待機の絵が設定されていません（設定画面の「画像」で設定してください）');

  // 切り替えた瞬間にカクつかないよう、全画像を先に GPU へ送っておく
  await app.renderer.prepare.upload(textures(next));

  const old = textures(looks);
  const oldRig = rigAvatar;
  oldRig?.view.root.removeFromParent();
  rigAvatar = null;
  sprite.visible = true;
  looks.clear();
  for (const [k, v] of next) looks.set(k, v);
  sprite.texture = Texture.EMPTY;
  overlay.clearError();
  subscribe();
  requestFrame();
  retireOld(old, oldRig);
}

let reloading: Promise<void> | null = null;
/** 読み込み中に届いた通知（次に読み込み直すときに画像も読み直すか） */
let reloadAgain: { images: boolean } | null = null;

/** 素材が変わったという通知で読み込み直す（連続した通知はまとめる） */
function reloadAvatar(images = true): void {
  if (reloading) {
    reloadAgain = { images: images || (reloadAgain?.images ?? false) };
    return;
  }
  reloading = loadAvatar(images)
    .catch((e) => overlay.error(e instanceof Error ? e.message : String(e)))
    .finally(() => {
      reloading = null;
      const again = reloadAgain;
      reloadAgain = null;
      if (again) reloadAvatar(again.images);
    });
}

// ───────────────────────── エンジンとの接続 ─────────────────────────

function engineUrl(): string {
  const host = params.get('engine') ?? location.host;
  // 設定画面のプレビューは「表示側」として数えない（OBS の接続数に混ざらないように）
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws${embed ? '?role=monitor' : ''}`;
}

let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
/** 音量の購読を送り直す（素材がパーツかどうかで、口用の音量が要るかが変わる） */
let subscribe: () => void = () => {};

function connect(): void {
  const ws = new WebSocket(engineUrl());
  const send = (msg: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

  ws.onopen = () => {
    clearTimeout(disconnectTimer);
    if (!embed) sendAck = (seq) => send({ type: 'ack', seq });
    overlay.connected(true);
    subscribe = () => send({ type: 'subscribe', meter: debug, level: rigAvatar !== null });
    if (debug || rigAvatar) subscribe();
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
        if (rigAvatar) layout();
        requestFrame();
        break;
      }
      case 'reload':
        if (!syncMode) reloadAvatar(msg.images ?? true);
        break;
      case 'meter':
        overlay.meter(msg.db, msg.voicing, msg.voiced);
        break;
      case 'level':
        if (!simulateVoice) mouth.level(msg.db, performance.now());
        break;
    }
  };

  ws.onclose = () => {
    subscribe = () => {};
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
      `状態 : ${LABELS[current]}（${current}）${rigAvatar ? `  口 ${mouthShape} / 目 ${eye}` : ''}`,
      level,
      `回数 : 切替 ${stats.changes} / 再接続 ${stats.reconnects} / まばたき ${stats.blinks} / 描画 ${stats.renders}`,
      'キー 1〜4 で状態を切り替え（発話は声のまね付き）、B でまばたき',
    ]
      .filter(Boolean)
      .join('\n');
  };

  if (debug) {
    el.hidden = false;
    window.addEventListener('keydown', (e) => {
      const state = STATES[Number(e.key) - 1];
      if (state) show(state, true);
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
      if (m.type === 'preview-state' && m.state && STATES.includes(m.state)) show(m.state, true);
      if (m.type === 'preview-blink') {
        blink.blinkNow(performance.now());
        requestFrame();
      }
    });
  }
}

main();
