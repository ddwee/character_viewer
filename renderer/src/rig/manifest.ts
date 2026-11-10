// avatar.json の `rig`（パーツを重ねてボーンで動かす設定）を読み、足りない値を既定値で補う。
// 描画に依存しない純粋なロジック。
//
// 例（座標は素材の画像の px。パーツはすべて同じキャンバスで位置合わせ済みの前提）:
//
// "rig": {
//   "size": [1024, 1024],
//   "bones": {
//     "body":      { "pivot": [515, 1023] },
//     "neck":      { "parent": "body", "pivot": [518, 790] },
//     "head":      { "parent": "neck", "pivot": [518, 620] },
//     "brows":     { "parent": "head", "pivot": [511, 398] },
//     "backHair":  { "parent": "head", "pivot": [540, 260], "spring": { "length": 380 } },
//     "frontHair": { "parent": "head", "pivot": [518, 200], "spring": { "length": 330 } }
//   },
//   "layers": [                                   ← 下から順に重ねる
//     { "bone": "backHair", "image": "parts/01_back_hair.png" },
//     { "bone": "head", "mouth": { "closed": "…", "half": "…", "open": "…" } },
//     { "bone": "head", "eyes":  { "open": "…", "half": "…", "closed": "…",
//                                 "blink": { "half": "…", "closed": "…" } } },   ← 瞬き専用のコマ（省略可）
//     …
//   ],
//   "motion": { "breath": { "amount": 0.008 } },   ← 動きの強さ（省略すると既定値）
//   "states": { "sleep": { "eyes": "closed", "headAngle": 5 } }  ← 状態ごとの姿勢
// }
//
// 動きを付けるボーンの名前は決まっている: body（呼吸）、neck・head（頭の揺れ）、brows（眉）。
// ばね（spring）はどのボーンにも付けられる。

import type { Vec } from './bones.ts';
import { DEFAULT_SPRING, type SpringConfig } from './spring.ts';

export type AvatarState = 'idle' | 'talk' | 'away' | 'sleep';
export type EyeShape = 'open' | 'half' | 'closed';

export interface RigBone {
  name: string;
  parent?: string;
  pivot: Vec;
  spring?: SpringConfig;
}

export type RigLayer =
  | { kind: 'image'; bone: string; image: string }
  | { kind: 'mouth'; bone: string; closed: string; half?: string; open: string }
  | {
      kind: 'eyes';
      bone: string;
      open: string;
      /** 表情の半目・閉じ目（状態で目を固定するとき。瞬き専用のコマがなければ瞬きにも使う） */
      half?: string;
      closed?: string;
      /** 瞬き専用のコマ（まぶたが下りてくる絵など） */
      blinkHalf?: string;
      blinkClosed?: string;
    };

export interface MotionConfig {
  breath: {
    /** 1 回の呼吸の長さ（秒） */
    period: number;
    /** 体の縦の伸び（0.008 なら 0.8%） */
    amount: number;
  };
  sway: {
    /** 待機中の頭の揺れ（度） */
    angle: number;
    /** 待機中の頭の揺れ（左右の px） */
    shift: number;
    /** 揺れのゆっくりさ（秒） */
    period: number;
  };
  talk: {
    /** 喋るときに頭が上がる量（px） */
    bounce: number;
    /** 喋るときの頭の傾き（度） */
    angle: number;
    /** 喋るときの頭の左右の動き（px） */
    shift: number;
  };
  brows: {
    /** 喋るときに眉が上がる量（px） */
    lift: number;
  };
  /** 頭の傾きのうち、首が受け持つ割合（0〜1） */
  neckShare: number;
}

export const DEFAULT_MOTION: MotionConfig = {
  breath: { period: 3.8, amount: 0.008 },
  sway: { angle: 1.2, shift: 2, period: 6 },
  talk: { bounce: 7, angle: 2.5, shift: 3 },
  brows: { lift: 3 },
  neckShare: 0.3,
};

export interface StatePose {
  /** 目をこの形に固定する（まばたきしない）。省略するとまばたき */
  eyes?: EyeShape;
  /** 頭の傾き（度。正で時計回り） */
  headAngle: number;
  /** 頭が下がる量（px） */
  headDrop: number;
  /** 呼吸の長さの倍率（2 なら 2 倍ゆっくり） */
  breathSlow: number;
  /** 呼吸の深さの倍率 */
  breathDeep: number;
  /** 待機中の揺れの倍率 */
  sway: number;
}

export const DEFAULT_POSE: StatePose = { headAngle: 0, headDrop: 0, breathSlow: 1, breathDeep: 1, sway: 1 };

const DEFAULT_STATE_POSES: Record<AvatarState, Partial<StatePose>> = {
  idle: {},
  talk: {},
  away: { sway: 0.6 },
  sleep: { eyes: 'closed', headAngle: 4, headDrop: 10, breathSlow: 1.5, breathDeep: 1.6, sway: 0.3 },
};

export interface Rig {
  size: Vec;
  bones: RigBone[];
  layers: RigLayer[];
  motion: MotionConfig;
  states: Record<AvatarState, StatePose>;
}

const STATES: readonly AvatarState[] = ['idle', 'talk', 'away', 'sleep'];
const EYES: readonly EyeShape[] = ['open', 'half', 'closed'];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function vec(v: unknown, where: string): Vec {
  if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return [v[0], v[1]];
  }
  throw new Error(`${where} は [x, y] の形で書いてください`);
}

function str(v: unknown, where: string): string {
  if (typeof v === 'string' && v.length > 0) return v;
  throw new Error(`${where} に画像のファイル名を書いてください`);
}

const optStr = (v: unknown, where: string) => (v === undefined ? undefined : str(v, where));

/** 既定値に、書かれている数値だけを上書きする（入れ子も） */
function mergeNumbers<T extends object>(base: T, over: unknown, where: string): T {
  if (over === undefined) return structuredClone(base);
  if (!isObj(over)) throw new Error(`${where} の書き方が正しくありません`);
  const out = structuredClone(base) as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    if (cur === undefined) continue; // 知らない項目は無視（新しい版の設定でも読めるように）
    if (typeof cur === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where}.${k} は数値で書いてください`);
      out[k] = v;
    } else if (Array.isArray(cur)) {
      out[k] = vec(v, `${where}.${k}`);
    } else if (isObj(cur)) {
      out[k] = mergeNumbers(cur, v, `${where}.${k}`);
    }
  }
  return out as T;
}

export function parseRig(raw: unknown): Rig {
  if (!isObj(raw)) throw new Error('avatar.json の rig の書き方が正しくありません');
  const size = raw.size === undefined ? undefined : vec(raw.size, 'rig.size');

  if (!isObj(raw.bones) || Object.keys(raw.bones).length === 0) throw new Error('rig.bones にボーンを書いてください');
  const bones: RigBone[] = Object.entries(raw.bones).map(([name, b]) => {
    const where = `rig.bones.${name}`;
    if (!isObj(b)) throw new Error(`${where} の書き方が正しくありません`);
    if (b.parent !== undefined && typeof b.parent !== 'string') throw new Error(`${where}.parent はボーンの名前で書いてください`);
    return {
      name,
      parent: b.parent,
      pivot: vec(b.pivot, `${where}.pivot`),
      spring: b.spring === undefined ? undefined : mergeNumbers(DEFAULT_SPRING, b.spring, `${where}.spring`),
    };
  });
  const boneNames = new Set(bones.map((b) => b.name));

  if (!Array.isArray(raw.layers) || raw.layers.length === 0) throw new Error('rig.layers にパーツを書いてください');
  const layers: RigLayer[] = raw.layers.map((l, i) => {
    const where = `rig.layers[${i}]`;
    if (!isObj(l)) throw new Error(`${where} の書き方が正しくありません`);
    const bone = l.bone;
    if (typeof bone !== 'string' || !boneNames.has(bone)) throw new Error(`${where}.bone に、rig.bones にあるボーンの名前を書いてください`);
    if (l.image !== undefined) return { kind: 'image', bone, image: str(l.image, `${where}.image`) };
    if (isObj(l.mouth)) {
      const m = l.mouth;
      return {
        kind: 'mouth',
        bone,
        closed: str(m.closed, `${where}.mouth.closed`),
        half: optStr(m.half, `${where}.mouth.half`),
        open: str(m.open, `${where}.mouth.open`),
      };
    }
    if (isObj(l.eyes)) {
      const e = l.eyes;
      if (e.blink !== undefined && !isObj(e.blink)) throw new Error(`${where}.eyes.blink は { "half": …, "closed": … } の形で書いてください`);
      const b = isObj(e.blink) ? e.blink : {};
      return {
        kind: 'eyes',
        bone,
        open: str(e.open, `${where}.eyes.open`),
        half: optStr(e.half, `${where}.eyes.half`),
        closed: optStr(e.closed, `${where}.eyes.closed`),
        blinkHalf: optStr(b.half, `${where}.eyes.blink.half`),
        blinkClosed: optStr(b.closed, `${where}.eyes.blink.closed`),
      };
    }
    throw new Error(`${where} には image・mouth・eyes のどれかを書いてください`);
  });

  const motion = mergeNumbers(DEFAULT_MOTION, raw.motion, 'rig.motion');

  if (raw.states !== undefined && !isObj(raw.states)) throw new Error('rig.states の書き方が正しくありません');
  const states = {} as Record<AvatarState, StatePose>;
  for (const s of STATES) {
    const over = isObj(raw.states) ? raw.states[s] : undefined;
    const base = { ...DEFAULT_POSE, ...DEFAULT_STATE_POSES[s] };
    const { eyes: baseEyes, ...nums } = base;
    const pose: StatePose = mergeNumbers(nums, isObj(over) ? { ...over, eyes: undefined } : over, `rig.states.${s}`);
    const eyes = isObj(over) && 'eyes' in over ? over.eyes : baseEyes;
    if (eyes !== undefined && eyes !== null) {
      if (!EYES.includes(eyes as EyeShape)) throw new Error(`rig.states.${s}.eyes は open・half・closed のどれかで書いてください`);
      pose.eyes = eyes as EyeShape;
    }
    states[s] = pose;
  }

  return { size: size ?? [0, 0], bones, layers, motion, states };
}

/** パーツで使う画像の一覧（読み込み用） */
export function rigImages(rig: Rig): string[] {
  const files = rig.layers.flatMap((l) =>
    l.kind === 'image' ? [l.image] : l.kind === 'mouth' ? [l.closed, l.half, l.open] : [l.open, l.half, l.closed, l.blinkHalf, l.blinkClosed],
  );
  return [...new Set(files.filter((f): f is string => f !== undefined))];
}

type EyesLayer = Extract<RigLayer, { kind: 'eyes' }>;

/** 瞬きに使うコマ（瞬き専用のコマがあればそれ、なければ表情の半目・閉じ目） */
export function blinkFrames(l: EyesLayer): { half?: string; closed?: string } {
  return l.blinkClosed !== undefined ? { half: l.blinkHalf, closed: l.blinkClosed } : { half: l.half, closed: l.closed };
}

/**
 * 目のパーツで表示する画像。
 * `blinking` は瞬きの途中（瞬き専用のコマを使う）、そうでなければ状態で固定した表情
 */
export function eyeFile(l: EyesLayer, eye: EyeShape, blinking: boolean): string {
  const f = blinking ? blinkFrames(l) : l;
  if (eye === 'closed') return f.closed ?? l.open;
  if (eye === 'half') return f.half ?? f.closed ?? l.open;
  return l.open;
}

/** 口のパーツで表示する画像 */
export function mouthFile(l: Extract<RigLayer, { kind: 'mouth' }>, mouth: 'closed' | 'half' | 'open'): string {
  return mouth === 'open' ? l.open : mouth === 'half' ? (l.half ?? l.open) : l.closed;
}
