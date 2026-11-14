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
//     { "bone": "backHair", "image": "parts/01_back_hair.png", "bend": {} },   ← bend でしなる（メッシュ変形）
//     { "bone": "head", "mouth": { "closed": "…", "half": "…", "open": "…" } },
//     { "bone": "head", "eyes":  { "open": "…", "half": "…", "closed": "…",
//                                 "blink": { "half": "…", "closed": "…" } } },   ← 瞬き専用のコマ（省略可）
//     { "bone": "head", "image": "parts/09_nose.png", "depth": 1.4 },            ← depth: 顔の向きでずれる量（奥行き）
//     { "bone": "head", "slot": "eyeL", "id": "whiteL",                          ← slot: 差し替えパーツ（rig/face.ts）
//       "frames": { "open": "…", "half": "…" } },                                   その値の絵がなければ隠れる
//     { "bone": "head", "image": "parts/12_pupil_l.png", "clip": "whiteL",       ← clip: その id のパーツの形で切り抜く
//       "gaze": [18, 10] },                                                         gaze: 視線で動く量（px）
//     …
//   ],
//   "motion": { "breath": { "amount": 0.008 } },   ← 動きの強さ（省略すると既定値）
//   "states": { "sleep": { "eyes": "closed", "headAngle": 5 } },  ← 状態ごとの姿勢
//   "expressions": { "smile": { "eyes": "smile", "mouth": "smile" } }  ← 表情（スロットの値の組み合わせ）
// }
//
// 動きを付けるボーンの名前は決まっている: body（呼吸）、neck・head（頭の揺れ）、brows（眉）。
// ばね（spring）はどのボーンにも付けられる。
// mouth・eyes は slot の短い書き方（mouth は slot "mouth"、eyes は slot "eyes" になる）。

import type { Vec } from './bones.ts';
import { EYE_VALUES, type SlotValues } from './face.ts';
import { DEFAULT_BEND, type BendConfig } from './mesh.ts';
import { DEFAULT_SPRING, type SpringConfig } from './spring.ts';

export type AvatarState = 'idle' | 'talk' | 'away' | 'sleep';
/** 目の値（rig/face.ts の EYE_VALUES） */
export type EyeShape = (typeof EYE_VALUES)[number];

export interface RigBone {
  name: string;
  parent?: string;
  pivot: Vec;
  spring?: SpringConfig;
  /** 奥行き。このボーンのパーツの depth の既定値で、揺れものが顔の向きに遅れてついていく量にもなる */
  depth: number;
}

interface LayerCommon {
  bone: string;
  /**
   * 奥行き。顔の向きに合わせて、手前のパーツ（正）は向いた方へ、奥のパーツ（負）は逆へずれる。
   * 1 で rig.motion.turn の量だけずれる。0 なら動かない
   */
  depth: number;
  /** 名前（ほかのパーツの clip から指す） */
  id?: string;
  /** この id のパーツの形（不透明な部分）で切り抜く。そのパーツが隠れているときは、これも隠れる */
  clip?: string;
  /** 視線で動く量（px。左右, 上下）。瞳に付ける */
  gaze?: Vec;
}

export type RigLayer =
  | (LayerCommon & {
      kind: 'image';
      image: string;
      /** しなる（メッシュ変形）。根元は動かず、先端ほどボーンの動きどおりになる */
      bend?: BendConfig;
    })
  | (LayerCommon & {
      kind: 'slot';
      /** 差し替えの枠の名前（mouth・eyeL・eyeR・eyes・browL・browR・brows、ほか自由） */
      slot: string;
      /** 値 → 画像。今の値の絵がなければ隠れる */
      frames: Record<string, string>;
    });

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
    /** 喋るときに体が縦に伸びる割合（戻るときに少しつぶれる） */
    stretch: number;
  };
  brows: {
    /** 喋るときに眉が上がる量（px） */
    lift: number;
  };
  /** 頭の傾きのうち、首が受け持つ割合（0〜1） */
  neckShare: number;
  turn: {
    /** 顔を真横いっぱいに向けたとき、depth 1 のパーツがずれる量（px） */
    x: number;
    /** 上下いっぱいに向けたときの量（px） */
    y: number;
    /** 待機中に、顔の向きを自動でゆらす量（0〜1。1 でいっぱいまで） */
    sway: number;
    /** 喋るときに、顔の向きをゆらす量（0〜1） */
    talk: number;
  };
}

export const DEFAULT_MOTION: MotionConfig = {
  breath: { period: 3.8, amount: 0.008 },
  sway: { angle: 1.2, shift: 2, period: 6 },
  talk: { bounce: 7, angle: 2.5, shift: 3, stretch: 0.012 },
  brows: { lift: 3 },
  neckShare: 0.3,
  turn: { x: 40, y: 24, sway: 0.12, talk: 0.1 },
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
  /** 表情の名前 → スロットの値の組み合わせ */
  expressions: Record<string, SlotValues>;
}

const STATES: readonly AvatarState[] = ['idle', 'talk', 'away', 'sleep'];
const EYES: readonly string[] = EYE_VALUES;

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

function num(v: unknown, where: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  throw new Error(`${where} は数値で書いてください`);
}

/** 値 → 画像 の表（書かれていない項目は入れない） */
function frames(entries: [string, unknown][], where: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of entries) if (v !== undefined) out[k] = str(v, `${where}.${k}`);
  return out;
}

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

/** しなりの設定。true や {} なら既定値 */
function parseBend(v: unknown, where: string): BendConfig | undefined {
  if (v === undefined || v === null || v === false) return undefined;
  if (v === true) return structuredClone(DEFAULT_BEND);
  if (!isObj(v)) throw new Error(`${where} の書き方が正しくありません`);
  const base = mergeNumbers(DEFAULT_BEND, v, where);
  const [cols, rows] = base.grid;
  if (![cols, rows].every((n) => Number.isInteger(n) && n >= 1 && n <= 64)) throw new Error(`${where}.grid は 1〜64 の整数 2 つで書いてください`);
  const out: BendConfig = { ...base };
  if (v.axis !== undefined) out.axis = vec(v.axis, `${where}.axis`);
  if (v.end !== undefined) {
    if (typeof v.end !== 'number' || !Number.isFinite(v.end)) throw new Error(`${where}.end は数値で書いてください`);
    out.end = v.end;
  }
  return out;
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
      depth: b.depth === undefined ? 0 : num(b.depth, `${where}.depth`),
    };
  });
  const boneDepth = new Map(bones.map((b) => [b.name, b.depth]));

  if (!Array.isArray(raw.layers) || raw.layers.length === 0) throw new Error('rig.layers にパーツを書いてください');
  const layers: RigLayer[] = raw.layers.map((l, i) => {
    const where = `rig.layers[${i}]`;
    if (!isObj(l)) throw new Error(`${where} の書き方が正しくありません`);
    const bone = l.bone;
    if (typeof bone !== 'string' || !boneDepth.has(bone)) throw new Error(`${where}.bone に、rig.bones にあるボーンの名前を書いてください`);
    const common: LayerCommon = {
      bone,
      depth: l.depth === undefined ? boneDepth.get(bone)! : num(l.depth, `${where}.depth`),
      ...(l.id !== undefined && { id: str(l.id, `${where}.id`) }),
      ...(l.clip !== undefined && { clip: str(l.clip, `${where}.clip`) }),
      ...(l.gaze !== undefined && { gaze: vec(l.gaze, `${where}.gaze`) }),
    };
    if (l.image !== undefined) {
      const bend = parseBend(l.bend, `${where}.bend`);
      return { kind: 'image', ...common, image: str(l.image, `${where}.image`), ...(bend && { bend }) };
    }
    if (l.bend !== undefined) throw new Error(`${where}.bend は image のパーツにだけ書けます`);
    if (l.slot !== undefined) {
      if (!isObj(l.frames) || Object.keys(l.frames).length === 0) throw new Error(`${where}.frames に { "値": "画像", … } を書いてください`);
      return { kind: 'slot', ...common, slot: str(l.slot, `${where}.slot`), frames: frames(Object.entries(l.frames), `${where}.frames`) };
    }
    if (isObj(l.mouth)) {
      const m = l.mouth;
      str(m.closed, `${where}.mouth.closed`);
      str(m.open, `${where}.mouth.open`);
      return { kind: 'slot', ...common, slot: 'mouth', frames: frames(Object.entries(m), `${where}.mouth`) };
    }
    if (isObj(l.eyes)) {
      const e = l.eyes;
      if (e.blink !== undefined && !isObj(e.blink)) throw new Error(`${where}.eyes.blink は { "half": …, "closed": … } の形で書いてください`);
      const blink = isObj(e.blink) ? e.blink : {};
      str(e.open, `${where}.eyes.open`);
      return {
        kind: 'slot',
        ...common,
        slot: 'eyes',
        frames: {
          ...frames(Object.entries(e).filter(([k]) => k !== 'blink'), `${where}.eyes`),
          // 瞬き専用のコマ（まぶたが下りてくる絵など）
          ...frames([['blink_half', blink.half], ['blink_closed', blink.closed]], `${where}.eyes.blink`),
        },
      };
    }
    throw new Error(`${where} には image・slot・mouth・eyes のどれかを書いてください`);
  });

  const ids = new Set<string>();
  for (const l of layers) {
    if (l.id === undefined) continue;
    if (ids.has(l.id)) throw new Error(`rig.layers の id「${l.id}」が 2 回使われています`);
    ids.add(l.id);
  }
  layers.forEach((l, i) => {
    if (l.clip !== undefined && (!ids.has(l.clip) || l.clip === l.id)) throw new Error(`rig.layers[${i}].clip に、ほかのパーツの id を書いてください`);
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
      if (!EYES.includes(eyes as string)) throw new Error(`rig.states.${s}.eyes は ${EYES.join('・')} のどれかで書いてください`);
      pose.eyes = eyes as EyeShape;
    }
    states[s] = pose;
  }

  if (raw.expressions !== undefined && !isObj(raw.expressions)) throw new Error('rig.expressions の書き方が正しくありません');
  const expressions: Record<string, SlotValues> = {};
  for (const [name, e] of Object.entries(isObj(raw.expressions) ? raw.expressions : {})) {
    if (!isObj(e)) throw new Error(`rig.expressions.${name} は { "スロット": "値", … } の形で書いてください`);
    expressions[name] = frames(Object.entries(e), `rig.expressions.${name}`);
  }

  return { size: size ?? [0, 0], bones, layers, motion, states, expressions };
}

/** パーツで使う画像の一覧（読み込み用） */
export function rigImages(rig: Rig): string[] {
  return [...new Set(rig.layers.flatMap((l) => (l.kind === 'image' ? [l.image] : Object.values(l.frames))))];
}

/** スロットごとの、素材が持つ値の一覧（同じスロットのパーツを合わせたもの） */
export function slotVocab(rig: Rig): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const l of rig.layers) {
    if (l.kind !== 'slot') continue;
    const set = out.get(l.slot) ?? new Set<string>();
    for (const k of Object.keys(l.frames)) set.add(k);
    out.set(l.slot, set);
  }
  return out;
}
