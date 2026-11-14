// メッシュ変形（しなり）。描画に依存しない純粋なロジック。
//
// パーツの絵を格子状の網（メッシュ）に分け、各頂点を
//   「ボーンが動かなかった場合の位置（根元）」と「ボーンの動きどおりの位置（先端）」
// の間で混ぜる。混ぜる割合（重み）は、ボーンの回転の中心から軸に沿って離れるほど大きくする。
//
// - 髪: 根元は頭に付いたまま、毛先ほど大きく揺れる（しなる）
// - 体: 裾は動かず、胸から上だけが呼吸や喋るときに伸び縮みする（つぶれる）
//
// 2 つの変換を重みで足し合わせる方法は「線形ブレンドスキニング」と同じ（ボーンが 2 本の場合）。

import { apply, type Mat, type Vec } from './bones.ts';

export interface BendConfig {
  /** 重みを上げていく向き（画像の座標）。省略すると、揺れものの向き、なければ中心から絵の中央へ向かう向き */
  axis?: Vec;
  /** 回転の中心から軸に沿ってこの距離（px）までは動かない */
  start: number;
  /** この距離（px）で動きが 100% になる。省略すると揺れものの長さ、なければ絵の高さの 40% */
  end?: number;
  /** 曲がり方。1 で一様、大きいほど先端に寄せて曲がる */
  curve: number;
  /** 網の目の数（横, 縦） */
  grid: [number, number];
}

export const DEFAULT_BEND: BendConfig = { start: 0, curve: 1.5, grid: [16, 16] };

/** 実際に使う値（省略された値を補ったもの） */
export interface ResolvedBend {
  axis: Vec;
  start: number;
  end: number;
  curve: number;
  grid: [number, number];
}

/**
 * 省略された値を補う。
 * @param pivot ボーンの回転の中心
 * @param spring ボーンの揺れもの（あれば向きと長さを使う）
 * @param size 絵の大きさ
 */
export function resolveBend(b: BendConfig, pivot: Vec, spring: { direction: Vec; length: number } | undefined, size: Vec): ResolvedBend {
  let axis = b.axis ?? spring?.direction ?? [size[0] / 2 - pivot[0], size[1] / 2 - pivot[1]];
  const n = Math.hypot(axis[0], axis[1]);
  axis = n > 1e-6 ? [axis[0] / n, axis[1] / n] : [0, 1];
  const end = b.end ?? spring?.length ?? size[1] * 0.4;
  return { axis, start: b.start, end: Math.max(end, b.start + 1), curve: Math.max(0.1, b.curve), grid: b.grid };
}

export interface Grid {
  /** 静止時の頂点（画像の座標）。x, y の順に並ぶ */
  rest: Float32Array;
  /** テクスチャ座標（0〜1） */
  uvs: Float32Array;
  indices: Uint32Array;
}

/** 絵（左上が (x0, y0)、大きさ w × h）を cols × rows の網に分ける */
export function makeGrid(w: number, h: number, cols: number, rows: number, x0 = 0, y0 = 0): Grid {
  cols = Math.max(1, Math.round(cols));
  rows = Math.max(1, Math.round(rows));
  const n = (cols + 1) * (rows + 1);
  const rest = new Float32Array(n * 2);
  const uvs = new Float32Array(n * 2);
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const k = (j * (cols + 1) + i) * 2;
      uvs[k] = i / cols;
      uvs[k + 1] = j / rows;
      rest[k] = x0 + uvs[k] * w;
      rest[k + 1] = y0 + uvs[k + 1] * h;
    }
  }
  const indices = new Uint32Array(cols * rows * 6);
  let t = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i;
      const b = a + 1;
      const c = a + cols + 1;
      const d = c + 1;
      indices.set([a, b, d, a, d, c], t);
      t += 6;
    }
  }
  return { rest, uvs, indices };
}

/** 各頂点の重み（0 = 根元のまま、1 = ボーンの動きどおり） */
export function bendWeights(rest: Float32Array, pivot: Vec, b: ResolvedBend): Float32Array {
  const w = new Float32Array(rest.length / 2);
  const span = b.end - b.start;
  for (let i = 0; i < w.length; i++) {
    const d = (rest[i * 2] - pivot[0]) * b.axis[0] + (rest[i * 2 + 1] - pivot[1]) * b.axis[1];
    const t = Math.min(1, Math.max(0, (d - b.start) / span));
    w[i] = t ** b.curve;
  }
  return w;
}

/** 頂点を動かす: out = (1 - w)·root(v) + w·tip(v) */
export function skin(rest: Float32Array, weights: Float32Array, root: Mat, tip: Mat, out: Float32Array): void {
  for (let i = 0; i < weights.length; i++) {
    const v: Vec = [rest[i * 2], rest[i * 2 + 1]];
    const [rx, ry] = apply(root, v);
    const [tx, ty] = apply(tip, v);
    const w = weights[i];
    out[i * 2] = rx + (tx - rx) * w;
    out[i * 2 + 1] = ry + (ty - ry) * w;
  }
}
