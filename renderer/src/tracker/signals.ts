// MediaPipe（Face Landmarker）の出力を、生の値（rig/track.ts の RawFace）に直す。純粋なロジック。
//
// - 表情は 52 個の数値（ブレンドシェイプ。ARKit と同じ名前で、Left / Right は本人から見た左右）
// - 顔の向きは 4×4 の変換行列（列優先。カメラから見て x は右、y は上、z は手前）
// - 顔の点（478 個。映像の幅・高さを 1 とした座標）からは、唇のすき間を測る。
//   自然に喋るときの口の動きは小さく、表情の数値（あごの開き）にはほとんど出ないため

import type { RawFace } from '../rig/track.ts';

const DEG = 180 / Math.PI;

export interface Category {
  categoryName: string;
  score: number;
}

/** 変換行列から顔の向き（度）を取り出す */
export function headAngles(m: ArrayLike<number>): { yaw: number; pitch: number; roll: number } {
  // 顔の正面の向き（z 軸）と、頭のてっぺんの向き（y 軸）
  const [fx, fy, fz] = [m[8], m[9], m[10]];
  const [ux, uy] = [m[4], m[5]];
  return {
    // 本人が左を向くと、カメラの映像では顔が右を向く（x が正）
    yaw: Math.atan2(fx, fz) * DEG,
    pitch: Math.asin(Math.max(-1, Math.min(1, fy))) * DEG,
    // 本人の左肩へ傾けると、映像では頭のてっぺんが右へ動く
    roll: Math.atan2(ux, uy) * DEG,
  };
}

export interface Point {
  x: number;
  y: number;
}

/** 顔の点の番号: 上唇の内側、下唇の内側、おでこの上、あごの先 */
const LIP_UPPER = 13;
const LIP_LOWER = 14;
const FACE_TOP = 10;
const FACE_BOTTOM = 152;

/**
 * 唇のすき間（上唇と下唇の内側の距離 ÷ 顔の高さ）。顔の大きさ（カメラとの距離）によらない。
 * `aspect` は映像の 幅 ÷ 高さ
 */
export function lipGap(points: readonly Point[] | undefined, aspect: number): number {
  if (!points || points.length <= FACE_BOTTOM) return 0;
  const dist = (a: Point, b: Point) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
  const height = dist(points[FACE_TOP], points[FACE_BOTTOM]);
  return height > 1e-6 ? dist(points[LIP_UPPER], points[LIP_LOWER]) / height : 0;
}

export function rawFace(shapes: readonly Category[], matrix: ArrayLike<number>, points?: readonly Point[], aspect = 4 / 3): RawFace {
  const s: Record<string, number> = {};
  for (const c of shapes) s[c.categoryName] = c.score;
  const v = (name: string) => s[name] ?? 0;
  const avg = (a: string, b: string) => (v(a) + v(b)) / 2;
  return {
    ...headAngles(matrix),
    blinkL: v('eyeBlinkLeft'),
    blinkR: v('eyeBlinkRight'),
    wideL: v('eyeWideLeft'),
    wideR: v('eyeWideRight'),
    // 左目が外側を見る = 右目が内側を見る = 本人の左を見ている
    lookX: (v('eyeLookOutLeft') + v('eyeLookInRight') - v('eyeLookInLeft') - v('eyeLookOutRight')) / 2,
    lookY: avg('eyeLookDownLeft', 'eyeLookDownRight') - avg('eyeLookUpLeft', 'eyeLookUpRight'),
    browUpL: v('browOuterUpLeft'),
    browUpR: v('browOuterUpRight'),
    browDownL: v('browDownLeft'),
    browDownR: v('browDownRight'),
    browIn: v('browInnerUp'),
    smile: avg('mouthSmileLeft', 'mouthSmileRight'),
    frown: avg('mouthFrownLeft', 'mouthFrownRight'),
    jaw: v('jawOpen'),
    pucker: Math.max(v('mouthPucker'), v('mouthFunnel')),
    stretch: avg('mouthStretchLeft', 'mouthStretchRight'),
    lips: lipGap(points, aspect),
  };
}
