// 顔の差し替えパーツ（スロット）にどの絵を出すかを決める。描画に依存しない純粋なロジック。
//
// スロット = 同じ場所で絵を差し替える枠（口・左右の目・左右の眉・頬など）。
// 各スロットは「値」（open・smile などの名前）を 1 つ持ち、パーツは frames[値] の絵を出す。
// その値の絵を持たないパーツは隠れる（閉じ目のときの白目と瞳など）。
//
// 値は次の順に決まる（後のものが優先）:
//   1. 自動の動き: 口パク（音量）、瞬き、状態で固定した目（寝落ちなど）
//   2. 上書き: 表情（rig.expressions）、カメラで読み取った表情、手動の切り替え
// 素材にない値は、近い絵で代用する（例: 「い」の口がなければ半開き）。
//
// 左右は「絵の左右」で呼ぶ（eyeL = 絵の左側にある目）。

import type { Eye } from '../blink.ts';
import type { Mouth } from './mouth.ts';

/** スロット名 → 値 */
export type SlotValues = Record<string, string>;

/** 何も上書きしないときの値（ここにないスロットは、値を入れるまで隠れる） */
export const SLOT_DEFAULTS: Readonly<SlotValues> = {
  mouth: 'closed',
  eyeL: 'open',
  eyeR: 'open',
  eyes: 'open',
  browL: 'normal',
  browR: 'normal',
  brows: 'normal',
};

/** 目のスロット（左右別、または両目で 1 枚） */
export const EYE_SLOTS = ['eyeL', 'eyeR', 'eyes'] as const;
const BROW_SLOTS = ['browL', 'browR', 'brows'] as const;

/** 目の値として使える名前（rig.states の eyes など） */
export const EYE_VALUES = ['open', 'wide', 'half', 'down', 'closed', 'smile', 'squeeze'] as const;

/** 閉じている目（この間は瞬きを重ねない） */
const EYES_SHUT = new Set(['closed', 'smile', 'squeeze', 'blink_closed']);

type SlotKind = 'mouth' | 'eye' | 'brow' | 'other';

function kindOf(slot: string): SlotKind {
  if (slot === 'mouth') return 'mouth';
  if ((EYE_SLOTS as readonly string[]).includes(slot)) return 'eye';
  if ((BROW_SLOTS as readonly string[]).includes(slot)) return 'brow';
  return 'other';
}

/** その値の絵がないときに、順に試す値 */
function chain(kind: SlotKind, value: string, has: (v: string) => boolean): string[] {
  if (kind === 'eye') {
    switch (value) {
      // 瞬きの途中。瞬き専用のコマ（blink_*）があればそれだけを使い、なければ表情の半目・閉じ目で代用する
      case 'blink_half':
        return has('blink_closed') ? ['blink_half', 'blink_closed'] : ['blink_half', 'half', 'closed', 'open'];
      case 'blink_closed':
        return ['blink_closed', 'closed', 'open'];
      case 'half':
        return ['half', 'closed', 'open'];
      case 'down':
        return ['down', 'half', 'closed', 'open'];
      case 'smile':
      case 'squeeze':
        return [value, 'closed', 'open'];
      default:
        return [value, 'open'];
    }
  }
  if (kind === 'mouth') {
    switch (value) {
      case 'closed':
      case 'open':
        return [value];
      case 'half':
        return ['half', 'open'];
      case 'i':
      case 'u':
        return [value, 'half', 'open'];
      case 'smile_open':
        return ['smile_open', 'open'];
      default:
        return [value, 'closed'];
    }
  }
  if (kind === 'brow') return [value, 'normal'];
  return [value];
}

/**
 * スロットの値を、素材にある値に直す（なければ undefined = そのスロットは隠す）。
 * `vocab` はそのスロットのパーツが持つ値の一覧
 */
export function resolveValue(slot: string, value: string, vocab: ReadonlySet<string> | undefined): string | undefined {
  if (!vocab) return undefined;
  return chain(kindOf(slot), value, (v) => vocab.has(v)).find((v) => vocab.has(v));
}

/** 閉じ目の絵がある（瞬きできる） */
export function canBlink(vocab: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const slots = EYE_SLOTS.filter((s) => vocab.has(s));
  return slots.length > 0 && slots.every((s) => resolveValue(s, 'blink_closed', vocab.get(s)) !== resolveValue(s, 'open', vocab.get(s)));
}

/** 瞬きの途中の絵（半目）がある */
export function hasHalfBlink(vocab: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const slots = EYE_SLOTS.filter((s) => vocab.has(s));
  return (
    slots.length > 0 &&
    slots.every((s) => {
      const half = resolveValue(s, 'blink_half', vocab.get(s));
      return half !== resolveValue(s, 'blink_closed', vocab.get(s)) && half !== resolveValue(s, 'open', vocab.get(s));
    })
  );
}

export interface FaceInput {
  /** 口の開き具合（音量から） */
  mouth: Mouth;
  /** 瞬き（`fixedEyes` があるときは使わない） */
  eye: Eye;
  /** 状態で固定した目（寝落ちで閉じる、など） */
  fixedEyes?: string;
  /** 上書き（表情・カメラ・手動）。`eyes` / `brows` は左右の両方に効く */
  overrides?: Readonly<SlotValues>;
  /** 口の形（カメラで読み取った「い」「う」など）。口が開いているときだけ使う */
  mouthForm?: string;
}

/** 左右別のスロットと、両方まとめたスロットのどちらで書かれていても読む */
function sided(ov: Readonly<SlotValues>, left: string, right: string, both: string): [string | undefined, string | undefined, string | undefined] {
  const l = ov[left] ?? ov[both];
  const r = ov[right] ?? ov[both];
  return [l, r, ov[both] ?? (l === r ? l : undefined)];
}

/**
 * 今のスロットの値を決める。
 * `mouthVocab` は口のパーツが持つ値（表情つきの開いた口があるかを調べる）
 */
export function faceSlots(i: FaceInput, mouthVocab?: ReadonlySet<string>): SlotValues {
  const ov = i.overrides ?? {};
  const out: SlotValues = { ...SLOT_DEFAULTS, ...ov };

  // 目: 状態で固定 → 上書き → 瞬き（開いている目にだけ重ねる）
  const blink = i.fixedEyes === undefined && i.eye !== 'open' ? (i.eye === 'half' ? 'blink_half' : 'blink_closed') : undefined;
  const base = i.fixedEyes ?? 'open';
  const [l, r, both] = sided(ov, 'eyeL', 'eyeR', 'eyes');
  const eye = (v: string | undefined) => {
    const cur = v ?? base;
    return blink && !EYES_SHUT.has(cur) ? blink : cur;
  };
  out.eyeL = eye(l);
  out.eyeR = eye(r);
  // 両目で 1 枚の素材は、左右で違う値（ウインク）を出せないので、そのときは開いた目にする
  out.eyes = eye(both ?? (l === undefined && r === undefined ? undefined : 'open'));

  const [bl, br, bb] = sided(ov, 'browL', 'browR', 'brows');
  out.browL = bl ?? SLOT_DEFAULTS.browL;
  out.browR = br ?? SLOT_DEFAULTS.browR;
  out.brows = bb ?? SLOT_DEFAULTS.brows;

  // 口: 閉じているときは表情の口。開いているときは「表情_open」があればそれ、なければ口の形か音量どおり
  const expr = ov.mouth;
  if (i.mouth === 'closed') out.mouth = expr ?? 'closed';
  else if (expr !== undefined && mouthVocab?.has(`${expr}_open`)) out.mouth = `${expr}_open`;
  else out.mouth = i.mouthForm ?? i.mouth;

  return out;
}
