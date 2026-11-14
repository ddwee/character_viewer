// カメラで読み取った顔を、キャラクターの動きに変える。描画に依存しない純粋なロジック。
//
// 流れ:
//   カメラ → 顔の読み取り（tracker ページ。MediaPipe）→ 生の値（RawFace）
//     → 本人に合わせて整えた値（FaceMsg。toFaceMsg）→ エンジン経由で描画ページへ
//     → 顔の向き・視線・スロットの値（Tracked。FaceTracker）
//
// - 生の値は「本人から見た左右」で持つ（left = 本人の左目）
// - FaceMsg と Tracked は「絵の左右」で持つ（eyeL = 絵の左側の目）。鏡のように動かすかどうかは toFaceMsg で決める
// - 表情の大きさは人によって大きく違う（ふつうの顔でも眉が「上がっている」と読まれる人もいる）ので、
//   本人の「ふつうの顔」（基準）と「その表情をした顔」（表情の大きさ）の間を 0〜1 にして使う
// - 絵が細かく切り替わってちらつかないよう、表情は 3 段階で落ち着かせる:
//     1. 値をなめらかにする（読み取りの細かい揺れを取る）
//     2. しきい値に幅を持たせる（入るときと出るときの境目を変える）
//     3. 切り替えたら、しばらくは同じ絵を保つ
//   まばたき（目を閉じる）だけは、遅れないようにすぐ反映する

import type { SlotValues } from './face.ts';
import type { HeadPose } from './motion.ts';
import type { Mouth } from './mouth.ts';

/** 顔の読み取りの生の値（本人から見た左右。角度は度、ほかは 0〜1） */
export interface RawFace {
  /** 顔の向き。yaw は本人が左を向くと正、pitch は上を向くと正、roll は本人の左肩へ傾けると正 */
  yaw: number;
  pitch: number;
  roll: number;
  /** 目を閉じている度合い */
  blinkL: number;
  blinkR: number;
  /** 目を見開いている度合い */
  wideL: number;
  wideR: number;
  /** 視線。lookX は本人の左を見ると正、lookY は下を見ると正（-1〜1） */
  lookX: number;
  lookY: number;
  /** 眉の外側を上げている / 眉を下げている / 眉の内側を上げている */
  browUpL: number;
  browUpR: number;
  browDownL: number;
  browDownR: number;
  browIn: number;
  smile: number;
  frown: number;
  /** あごを開けている */
  jaw: number;
  /** 口をすぼめている（う） */
  pucker: number;
  /** 口を横に引いている（い） */
  stretch: number;
  /** 唇のすき間（上唇と下唇の内側の距離 ÷ 顔の高さ）。小さな口の動きも拾える */
  lips: number;
}

export const RAW_KEYS: readonly (keyof RawFace)[] = [
  'yaw', 'pitch', 'roll', 'blinkL', 'blinkR', 'wideL', 'wideR', 'lookX', 'lookY',
  'browUpL', 'browUpR', 'browDownL', 'browDownR', 'browIn', 'smile', 'frown', 'jaw', 'pucker', 'stretch', 'lips',
];

/** カメラの設定（設定画面の「カメラ」。engine/src/settings.rs の CameraSettings） */
export interface CameraConfig {
  enabled: boolean;
  device: string | null;
  mirror: boolean;
  yawRange: number;
  pitchRange: number;
  rollGain: number;
  gaze: boolean;
  eyes: boolean;
  expressions: boolean;
  sensitivity: number;
  /** 基準（正面を向いて無表情のときの生の値） */
  neutral: Partial<RawFace> | null;
  /** 表情の大きさ（本人がその表情をしたときの生の値。設定画面の「表情を覚えさせる」で測る） */
  ranges: Partial<RawFace> | null;
}

/** 描画ページへ送る値（絵の左右）。読み取らない項目は入れない */
export interface FaceMsg {
  type: 'face';
  /** 顔が見つかっている */
  ok: boolean;
  /** 顔の向き（-1〜1。yaw は絵の右を向くと正、pitch は下を向くと正） */
  yaw?: number;
  pitch?: number;
  /** 傾き（度。時計回りが正） */
  roll?: number;
  /** 視線（-1〜1。右, 下が正） */
  gx?: number;
  gy?: number;
  /** 目の開き具合（0 = 閉じている、1 = ふつう、2 = 見開いている） */
  eyeL?: number;
  eyeR?: number;
  /** 眉（-1 = 下げている、+1 = 上げている） */
  browL?: number;
  browR?: number;
  /** 眉の内側だけが上がっている（困り顔。0〜1） */
  browIn?: number;
  smile?: number;
  frown?: number;
  /** 口の開き（0〜1。唇のすき間とあごの開きの大きいほう） */
  jaw?: number;
  pucker?: number;
  stretch?: number;
  /** 状況（顔が見つからない理由など。設定画面に表示する） */
  status?: string;
  /** 1 秒あたりの読み取り回数 */
  fps?: number;
  /** 生の値（設定画面で基準や表情の大きさを測るのに使う） */
  raw?: RawFace;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** 小数 3 桁に丸める（+ 0 は -0 を 0 にするため） */
const round = (v: number) => Math.round(v * 1000) / 1000 + 0;

type RawKey = keyof RawFace;

/** 基準を測っていないときの「ふつうの顔」の値（ここにない項目は 0） */
const DEFAULT_NEUTRAL: Partial<Record<RawKey, number>> = { blinkL: 0.08, blinkR: 0.08, lips: 0.012 };

/**
 * 表情の大きさを測っていないときの「その表情をした顔」の値（基準 n から決める）。
 * 値の出方は項目ごとに違う（への字口は強くしても 0.3 程度、など）
 */
const DEFAULT_FULL: Partial<Record<RawKey, (n: number) => number>> = {
  blinkL: (n) => Math.max(n + 0.2, 0.6),
  blinkR: (n) => Math.max(n + 0.2, 0.6),
  wideL: (n) => n + 0.4,
  wideR: (n) => n + 0.4,
  browUpL: (n) => n + (1 - n) * 0.6,
  browUpR: (n) => n + (1 - n) * 0.6,
  browDownL: (n) => n + 0.45,
  browDownR: (n) => n + 0.45,
  browIn: (n) => n + (1 - n) * 0.6,
  smile: (n) => n + 0.6,
  frown: (n) => n + 0.3,
  jaw: (n) => n + 0.5,
  pucker: (n) => n + (1 - n) * 0.6,
  stretch: (n) => n + 0.35,
  lips: (n) => n + 0.1,
};

/** 測った「表情の大きさ」のうち、この割合まで動かせば 1（いっぱい）とみなす。毎回めいっぱい動かさなくても届くように */
const REACH = 0.85;
/** 基準と表情の差がこれより小さければ、測り損ねとみなして既定値を使う */
const MIN_SPAN = 0.04;

/** 生の値を、本人の「基準 → その表情」の間で 0〜1 に直す */
function normalizer(raw: RawFace, cfg: CameraConfig): (key: RawKey, gain?: number) => number {
  const neutral = cfg.neutral ?? {};
  const ranges = cfg.ranges ?? {};
  return (key, gain = 1) => {
    const n = neutral[key] ?? DEFAULT_NEUTRAL[key] ?? 0;
    const measured = ranges[key];
    const full = measured !== undefined && measured - n >= MIN_SPAN ? n + (measured - n) * REACH : (DEFAULT_FULL[key]?.(n) ?? 1);
    return clamp(((raw[key] - n) / Math.max(MIN_SPAN, full - n)) * gain, 0, 1);
  };
}

/** 生の値を、本人に合わせて整えて、絵の左右に直す */
export function toFaceMsg(raw: RawFace, cfg: CameraConfig): FaceMsg {
  const n = cfg.neutral ?? {};
  const s = cfg.sensitivity;
  const norm = normalizer(raw, cfg);
  // 鏡のように動かす: 本人の左 = 絵の左。そうでなければ、向かい合った相手のように左右が入れ替わる
  const side = cfg.mirror ? -1 : 1;
  const msg: FaceMsg = {
    type: 'face',
    ok: true,
    yaw: round(clamp((side * (raw.yaw - (n.yaw ?? 0))) / cfg.yawRange, -1, 1)),
    pitch: round(clamp(-(raw.pitch - (n.pitch ?? 0)) / cfg.pitchRange, -1, 1)),
    roll: round(clamp(side * (raw.roll - (n.roll ?? 0)) * cfg.rollGain, -45, 45)),
  };
  if (cfg.gaze) {
    msg.gx = round(clamp(side * (raw.lookX - (n.lookX ?? 0)) * 1.6, -1, 1));
    msg.gy = round(clamp((raw.lookY - (n.lookY ?? 0)) * 1.6, -1, 1));
  }
  if (cfg.eyes) {
    const open = (blink: RawKey, wide: RawKey) => {
      const closed = norm(blink);
      return round(closed > 0.1 ? 1 - closed : 1 + norm(wide, s));
    };
    const left = open('blinkL', 'wideL');
    const right = open('blinkR', 'wideR');
    [msg.eyeL, msg.eyeR] = cfg.mirror ? [left, right] : [right, left];
  }
  if (cfg.expressions) {
    const left = round(norm('browUpL', s) - norm('browDownL', s));
    const right = round(norm('browUpR', s) - norm('browDownR', s));
    [msg.browL, msg.browR] = cfg.mirror ? [left, right] : [right, left];
    msg.browIn = round(norm('browIn', s));
    msg.smile = round(norm('smile', s));
    msg.frown = round(norm('frown', s));
    // 口の開きは、唇のすき間を主に使う（自然に喋るときの小さな動きは、あごの値にはほとんど出ない）
    msg.jaw = round(Math.max(norm('lips'), norm('jaw')));
    msg.pucker = round(norm('pucker', s));
    msg.stretch = round(norm('stretch', s));
  }
  return msg;
}

/** 生の値の平均（基準を測るとき） */
export function averageRaw(samples: readonly RawFace[]): RawFace | null {
  if (samples.length === 0) return null;
  const out = {} as RawFace;
  for (const k of RAW_KEYS) out[k] = round(samples.reduce((sum, r) => sum + (r[k] ?? 0), 0) / samples.length);
  return out;
}

/**
 * 表情の大きさを測る: その表情をしている間の値のうち、大きいほうから 2 割の位置の値。
 * 最大値そのものは一瞬の読み取りの揺れを拾いやすいので使わない
 */
export function peakRaw(samples: readonly RawFace[], keys: readonly RawKey[]): Partial<RawFace> | null {
  if (samples.length === 0) return null;
  const out: Partial<RawFace> = {};
  for (const k of keys) {
    const sorted = samples.map((r) => r[k] ?? 0).sort((a, b) => a - b);
    out[k] = round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.8))]);
  }
  return out;
}

// ───────────────────────── ちらつきを抑える部品 ─────────────────────────

/** 値をなめらかにする（`tauMs` で約 63% 追いつく） */
class Smooth {
  private value: number | null = null;
  private readonly tauMs: number;

  constructor(tauMs: number) {
    this.tauMs = tauMs;
  }

  update(v: number, dtMs: number): number {
    // 最初の値と、間が空いたあとの値は、そのまま使う
    if (this.value === null || !(dtMs > 0) || dtMs > STALE_MS) this.value = v;
    else this.value += (v - this.value) * (1 - Math.exp(-dtMs / this.tauMs));
    return this.value;
  }
}

/** しきい値に幅を持たせたスイッチ（`on` 以上で入り、`off` 未満で切れる） */
class Latch {
  private state = false;
  private readonly on: number;
  private readonly off: number;

  constructor(on: number, off: number) {
    this.on = on;
    this.off = off;
  }

  update(v: number): boolean {
    this.state = this.state ? v >= this.off : v >= this.on;
    return this.state;
  }
}

/** 切り替えたら、しばらくは同じ値を保つ */
class Held<T> {
  value: T;
  private since = -Infinity;

  constructor(initial: T) {
    this.value = initial;
  }

  /** `holdMs` は、今の値を最低どれだけ保つか（0 ならすぐ切り替える） */
  update(next: T, now: number, holdMs: number): T {
    if (next !== this.value && now - this.since >= holdMs) {
      this.value = next;
      this.since = now;
    }
    return this.value;
  }
}

/** 目 1 つぶんの形（閉じ → 半目 → ふつう → 見開き） */
class EyeLatch {
  private readonly closed = new Latch(0.72, 0.55); // 「閉じている度合い」で見る
  private readonly half = new Latch(0.42, 0.25);
  private readonly wide = new Latch(1.55, 1.3);
  private readonly held = new Held('open');

  update(open: number, now: number): string {
    const shut = 1 - Math.min(1, open);
    const closed = this.closed.update(shut);
    const half = this.half.update(shut);
    const wide = this.wide.update(open);
    const next = closed ? 'closed' : half ? 'half' : wide ? 'wide' : 'open';
    // 閉じるのはすぐ（まばたきを遅らせない）。開くのも速く。半目・見開きとの行き来はゆっくり
    const hold = next === 'closed' ? 0 : EYE_HOLD_MS[this.held.value] ?? 120;
    return this.held.update(next, now, hold);
  }
}

/** 目の形を最低これだけ保つ（ms） */
const EYE_HOLD_MS: Record<string, number> = { closed: 40, half: 70, open: 140, wide: 250 };

/** 眉の形（左右そろえて決める） */
class BrowLatch {
  private readonly up = new Latch(0.5, 0.3);
  private readonly angry = new Latch(0.5, 0.3);
  private readonly worried = new Latch(0.55, 0.35);
  private readonly held = new Held('normal');

  /** `smile` は笑顔の度合い。笑うと眉も下がって読み取られるので、その分は「怒り」に数えない */
  update(brow: number, inner: number, smile: number, now: number): string {
    const up = this.up.update(brow);
    const angry = this.angry.update(-brow - smile * 1.2);
    // 困り顔: 眉の内側だけが上がっている（眉全体を上げたときは「上げる」）
    const worried = this.worried.update(inner - Math.max(0, brow) * 0.8);
    return this.held.update(angry ? 'angry' : up ? 'up' : worried ? 'worried' : 'normal', now, EXPRESSION_HOLD_MS);
  }
}

/** カメラで見た口の開き（声が出ていないときに使う）。本人の動きの大きさに合わせる */
class MouthOpen {
  /** 最近のいちばん大きな開き。これを基準にした割合で見る（小さく喋る人でも、開き・半開きが出る） */
  private peak: number = MOUTH.peakFloor;
  private readonly held = new Held<Mouth>('closed');

  update(open: number, dtMs: number, now: number): Mouth {
    const dt = dtMs > 0 && dtMs < STALE_MS ? dtMs / 1000 : 0;
    this.peak = Math.max(MOUTH.peakFloor, open, this.peak - MOUTH.peakDecayPerSec * dt);
    const a = open / this.peak;
    const cur = this.held.value;
    const h = MOUTH.hysteresis;
    const level = cur === 'open' ? 2 : cur === 'half' ? 1 : 0;
    const over = (t: number, l: number) => (level >= l ? a >= t - h : a >= t + h);
    const next: Mouth = over(MOUTH.openAt, 2) ? 'open' : over(MOUTH.halfAt, 1) ? 'half' : 'closed';
    return this.held.update(next, now, MOUTH.holdMs);
  }
}

const MOUTH = {
  /** 基準にする開きの下限（閉じているときの読み取りの揺れで、口が開かないように） */
  peakFloor: 0.3,
  /** 基準が下がる速さ（1 秒あたり）。大きく開けたあと、ふつうの喋り方に戻っても追いつく */
  peakDecayPerSec: 0.12,
  /** 基準に対する割合がこれ以上で 半開き / 開き */
  halfAt: 0.3,
  openAt: 0.68,
  hysteresis: 0.08,
  /** 同じ形を保つ最短の時間（ms）。口パクは速いので短く */
  holdMs: 70,
} as const;

/** 眉・口の表情を最低これだけ保つ（ms） */
const EXPRESSION_HOLD_MS = 350;
/** 口の形（い・う）を最低これだけ保つ（ms） */
const FORM_HOLD_MS = 160;

/** カメラから決まった顔（描画ページで使う） */
export interface Tracked {
  head: HeadPose;
  /** 視線（読み取っていなければ undefined） */
  gaze?: [number, number];
  /** スロットの値（目・眉・口の表情） */
  overrides: SlotValues;
  /** 目を読み取っている（自動の瞬きを止める） */
  eyes: boolean;
  /** 口の形（「い」「う」） */
  mouthForm?: string;
  /** カメラで見た口の開き（声が出ていないときに使う） */
  mouthOpen: Mouth;
}

/** 左右の目の開き具合の差がこれ未満なら、両目をそろえる（片目だけ半目になるのを防ぐ。ウインクは差が大きい） */
const EYE_LINK = 0.4;
/** この時間（ms）値が届かなければ、カメラなしの動きに戻す */
const STALE_MS = 500;
/** 視線をなめらかにする時間（ms） */
const GAZE_TAU_MS = 60;

export class FaceTracker {
  private msg: FaceMsg | null = null;
  private at = -Infinity;
  private readonly eyeL = new EyeLatch();
  private readonly eyeR = new EyeLatch();
  private readonly brows = new BrowLatch();
  private readonly mouthOpen = new MouthOpen();
  private readonly smileEyes = new Latch(0.78, 0.5);
  private readonly smile = new Latch(0.45, 0.25);
  private readonly frown = new Latch(0.5, 0.3);
  private readonly pucker = new Latch(0.55, 0.35);
  private readonly stretch = new Latch(0.55, 0.35);
  private readonly smileEyesHeld = new Held(false);
  private readonly mouthExpr = new Held<string | undefined>(undefined);
  private readonly mouthForm = new Held<string | undefined>(undefined);
  /** なめらかにした値（表情はゆっくり、口の開きは速く） */
  private readonly smooth = {
    brow: new Smooth(110),
    browIn: new Smooth(110),
    smile: new Smooth(110),
    frown: new Smooth(110),
    pucker: new Smooth(70),
    stretch: new Smooth(70),
    jaw: new Smooth(30),
    wideL: new Smooth(90),
    wideR: new Smooth(90),
  };
  private gaze: [number, number] = [0, 0];
  private tracked: Tracked | null = null;

  /** 値が届いた */
  update(m: FaceMsg, now: number): void {
    const dt = now - this.at;
    this.msg = m;
    this.at = now;
    if (!m.ok) {
      this.tracked = null;
      return;
    }
    const overrides: SlotValues = {};
    const sm = this.smooth;
    const smile = sm.smile.update(m.smile ?? 0, dt);

    const eyes = m.eyeL !== undefined && m.eyeR !== undefined;
    if (eyes) {
      let [l, r] = [m.eyeL!, m.eyeR!];
      if (Math.abs(l - r) < EYE_LINK) l = r = (l + r) / 2;
      // 見開き（1 より上）だけはなめらかにする。閉じる側は、まばたきが遅れないようそのまま使う
      l = l > 1 ? 1 + sm.wideL.update(l - 1, dt) : (sm.wideL.update(0, dt), l);
      r = r > 1 ? 1 + sm.wideR.update(r - 1, dt) : (sm.wideR.update(0, dt), r);
      overrides.eyeL = this.eyeL.update(l, now);
      overrides.eyeR = this.eyeR.update(r, now);
      // にっこり笑うと目を閉じて笑う（^^）。瞬きの途中でなければ
      const smiling = this.smileEyesHeld.update(this.smileEyes.update(smile), now, EXPRESSION_HOLD_MS);
      if (smiling && overrides.eyeL !== 'closed' && overrides.eyeR !== 'closed') overrides.eyeL = overrides.eyeR = 'smile';
    }
    if (m.browL !== undefined && m.browR !== undefined) {
      // 左右の眉はそろえて決める（片方だけ切り替わると不自然なので）
      const brow = sm.brow.update((m.browL + m.browR) / 2, dt);
      const inner = sm.browIn.update(m.browIn ?? 0, dt);
      overrides.browL = overrides.browR = this.brows.update(brow, inner, smile, now);
    }
    const smiles = this.smile.update(smile);
    const frowns = this.frown.update(sm.frown.update(m.frown ?? 0, dt));
    const expr = this.mouthExpr.update(smiles ? 'smile' : frowns ? 'frown' : undefined, now, EXPRESSION_HOLD_MS);
    if (expr) overrides.mouth = expr;

    const pucker = this.pucker.update(sm.pucker.update(m.pucker ?? 0, dt));
    const stretch = this.stretch.update(sm.stretch.update(m.stretch ?? 0, dt));
    const form = this.mouthForm.update(pucker ? 'u' : stretch && expr !== 'smile' ? 'i' : undefined, now, FORM_HOLD_MS);

    let gaze: [number, number] | undefined;
    if (m.gx !== undefined && m.gy !== undefined) {
      const k = dt > 0 && dt < STALE_MS ? 1 - Math.exp(-dt / GAZE_TAU_MS) : 1;
      this.gaze = [this.gaze[0] + (m.gx - this.gaze[0]) * k, this.gaze[1] + (m.gy - this.gaze[1]) * k];
      gaze = this.gaze;
    }

    this.tracked = {
      head: { yaw: m.yaw ?? 0, pitch: m.pitch ?? 0, roll: m.roll ?? 0 },
      gaze,
      overrides,
      eyes,
      mouthForm: form,
      mouthOpen: this.mouthOpen.update(sm.jaw.update(m.jaw ?? 0, dt), dt, now),
    };
  }

  /** 今の顔（カメラを使っていない・顔が見つからない・値が古いときは null） */
  current(now: number): Tracked | null {
    return now - this.at <= STALE_MS ? this.tracked : null;
  }

  /** 最後に届いた値（設定画面の表示用） */
  last(now: number): FaceMsg | null {
    return now - this.at <= STALE_MS * 4 ? this.msg : null;
  }
}
