// パーツの調整画面（設定画面）で rig を書き換えるための道具。描画に依存しない純粋なロジック。
//
// 書き換えは avatar.json の rig の JSON そのもの（RawRig）に対して行う。
// 読み込み時に補った既定値や、知らない項目を勝手に書き足したり消したりしないように。

import type { Mat, Vec } from './bones.ts';

export type RawRig = Record<string, unknown>;

/** よく使うボーンの名前の表示名 */
export const BONE_LABELS: Record<string, string> = {
  body: '体',
  neck: '首',
  head: '頭',
  brows: '眉',
  backHair: '後ろ髪',
  frontHair: '前髪',
};

export const boneLabel = (name: string) => BONE_LABELS[name] ?? name;

type Json = Record<string, unknown>;

/** `path` の場所に値を入れた新しい rig を返す（途中の項目がなければ作る。元の rig は変えない） */
export function setIn(raw: RawRig, path: readonly string[], value: unknown): RawRig {
  const out = structuredClone(raw);
  let cur: Json = out;
  for (const key of path.slice(0, -1)) {
    // 配列（layers）の中も、番号を文字列で指定してたどれる
    if (typeof cur[key] !== 'object' || cur[key] === null) cur[key] = {};
    cur = cur[key] as Json;
  }
  const last = path[path.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  return out;
}

const round = (v: number, digits = 0) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

/** 回転の中心を動かす（画像の px、整数に丸める） */
export function setPivot(raw: RawRig, bone: string, [x, y]: Vec): RawRig {
  return setIn(raw, ['bones', bone, 'pivot'], [round(x), round(y)]);
}

/** 揺れものの先端を動かす（長さと向きになる） */
export function setSpringTip(raw: RawRig, bone: string, pivot: Vec, [x, y]: Vec): RawRig {
  const dx = x - pivot[0];
  const dy = y - pivot[1];
  const len = Math.hypot(dx, dy);
  if (len < 1) return raw;
  const withLen = setIn(raw, ['bones', bone, 'spring', 'length'], Math.max(20, round(len)));
  return setIn(withLen, ['bones', bone, 'spring', 'direction'], [round(dx / len, 3), round(dy / len, 3)]);
}

/** 画面への収め方: 画面の座標 = 画像の座標 × scale + (ox, oy) */
export interface Fit {
  scale: number;
  ox: number;
  oy: number;
}

/** 画像を画面（w × h）の中央に、余白 `margin`（割合）を空けて収める */
export function fit([iw, ih]: Vec, w: number, h: number, margin = 0.04): Fit {
  const scale = Math.min(w / (iw * (1 + 2 * margin)), h / (ih * (1 + 2 * margin)));
  return { scale, ox: (w - iw * scale) / 2, oy: (h - ih * scale) / 2 };
}

export const toScreen = (f: Fit, [x, y]: Vec): [number, number] => [x * f.scale + f.ox, y * f.scale + f.oy];
export const toImage = (f: Fit, [x, y]: Vec): [number, number] => [(x - f.ox) / f.scale, (y - f.oy) / f.scale];

/** 逆変換（つぶれていて逆がなければ null） */
export function invert(m: Mat): Mat | null {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) return null;
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return { a, b, c, d, tx: -(a * m.tx + c * m.ty), ty: -(b * m.tx + d * m.ty) };
}

/**
 * 元に戻すための履歴。スライダーやドラッグのように細かく続く変更は、
 * `mergeMs` 以内の続きを 1 回分にまとめる
 */
export class EditHistory<T> {
  private readonly stack: T[] = [];
  private lastAt = -Infinity;
  private readonly limit: number;
  private readonly mergeMs: number;

  constructor(limit = 50, mergeMs = 600) {
    this.limit = limit;
    this.mergeMs = mergeMs;
  }

  /** 変更する直前の値を記録する */
  record(before: T, now: number): void {
    if (now - this.lastAt > this.mergeMs) {
      this.stack.push(before);
      if (this.stack.length > this.limit) this.stack.shift();
    }
    this.lastAt = now;
  }

  /** 続けて変えても、次の変更は別の 1 回として記録する（ドラッグを離したときなど） */
  cut(): void {
    this.lastAt = -Infinity;
  }

  undo(): T | undefined {
    this.lastAt = -Infinity;
    return this.stack.pop();
  }

  get size(): number {
    return this.stack.length;
  }

  clear(): void {
    this.stack.length = 0;
    this.lastAt = -Infinity;
  }
}
