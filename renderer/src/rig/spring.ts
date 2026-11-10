// 揺れもの（髪など）のばね。描画に依存しない純粋なロジック。
//
// ボーンの先端に「おもり」を付け、ばねで本来の位置（親と一緒に動いた場合の位置）へ引き戻す。
// 頭が動くと、おもりは少し遅れてついていき、行きすぎて戻る。
// その遅れを、ボーンの回転（と少しの伸び縮み）に直して使う。

import type { Vec } from './bones.ts';

export interface SpringConfig {
  /** 回転の中心から先端（おもり）までの長さ（画像の px） */
  length: number;
  /** 回転の中心から見た先端の向き（静止時）。既定は真下 [0, 1] */
  direction: Vec;
  /** 揺れの速さ（1 秒あたりの往復回数）。大きいほど硬くすぐ戻る */
  frequency: number;
  /** 揺れの収まりやすさ（0〜1）。1 で行きすぎない、小さいほど長く揺れる */
  damping: number;
  /** 回転の大きさの倍率 */
  strength: number;
  /** 回転の上限（度） */
  maxAngle: number;
  /** 伸び縮みの倍率（0 で伸び縮みしない） */
  stretch: number;
  /** 伸び縮みの上限（0.03 なら ±3%） */
  maxStretch: number;
}

export const DEFAULT_SPRING: SpringConfig = {
  length: 300,
  direction: [0, 1],
  frequency: 3,
  damping: 0.35,
  strength: 1,
  maxAngle: 5,
  stretch: 0.5,
  maxStretch: 0.03,
};

/** 物理計算の 1 ステップの最大幅（秒）。フレームの間隔によらず安定させる */
const MAX_STEP = 1 / 240;
/** これ以上フレームが空いたら（タブが隠れていたなど）揺れをリセットする */
const MAX_GAP = 0.25;

export interface SpringOutput {
  /** 追加の回転（ラジアン） */
  rotation: number;
  /** 先端方向の伸び縮み（1 で変化なし） */
  stretch: number;
}

export class TipSpring {
  readonly cfg: SpringConfig;
  private pos: [number, number] | null = null;
  private vel: [number, number] = [0, 0];

  constructor(cfg: SpringConfig) {
    this.cfg = cfg;
  }

  /** 静止時の先端（画像の座標） */
  restTip(pivot: Vec): [number, number] {
    const [dx, dy] = this.cfg.direction;
    const n = Math.hypot(dx, dy) || 1;
    return [pivot[0] + (dx / n) * this.cfg.length, pivot[1] + (dy / n) * this.cfg.length];
  }

  /**
   * おもりを `dt` 秒進める。
   * @param pivot 回転の中心の今の位置
   * @param target 親と一緒に動いた場合の先端の位置（おもりが戻りたい場所）
   */
  step(pivot: Vec, target: Vec, dt: number): SpringOutput {
    if (this.pos === null || !(dt >= 0) || dt > MAX_GAP) {
      this.pos = [target[0], target[1]];
      this.vel = [0, 0];
      return { rotation: 0, stretch: 1 };
    }
    const w = 2 * Math.PI * Math.max(0.01, this.cfg.frequency);
    const z = Math.max(0, this.cfg.damping);
    const steps = Math.max(1, Math.ceil(dt / MAX_STEP));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      for (const k of [0, 1] as const) {
        // 減衰つきのばね（半陰的オイラー法）
        const acc = -w * w * (this.pos[k] - target[k]) - 2 * z * w * this.vel[k];
        this.vel[k] += acc * h;
        this.pos[k] += this.vel[k] * h;
      }
    }

    // 本来の向きと、おもりの向きの角度の差
    const tx = target[0] - pivot[0];
    const ty = target[1] - pivot[1];
    const px = this.pos[0] - pivot[0];
    const py = this.pos[1] - pivot[1];
    const angle = Math.atan2(tx * py - ty * px, tx * px + ty * py);
    const max = (this.cfg.maxAngle * Math.PI) / 180;
    const rotation = clamp(angle * this.cfg.strength, -max, max);

    const restLen = Math.hypot(tx, ty) || 1;
    const s = (Math.hypot(px, py) / restLen - 1) * this.cfg.stretch;
    const stretch = 1 + clamp(s, -this.cfg.maxStretch, this.cfg.maxStretch);
    return { rotation, stretch };
  }

  /** 次の step で、揺れのない状態から始める */
  reset(): void {
    this.pos = null;
  }
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
