// 毎フレームの動き（呼吸・頭の揺れ・喋るときの動き・髪のばね）をボーンに与える。
// 描画に依存しない純粋なロジック。
//
// 動きはすべてプログラムで作る（手付けのアニメーションは使わない）。
// - 呼吸: 体（body）をゆっくり縦に伸び縮みさせる。頭は伸びずに少し上下するだけ
// - 待機中のゆらぎ: 頭（neck・head）を、周期のそろわない波の重ね合わせで小さく揺らす（機械的に見えないように）
// - 喋るとき: 声の大きさで頭が少し上がり、傾く。眉（brows）も少し上がる
// - 状態ごとの姿勢: 寝落ちでうつむく、など。切り替えはなめらかに移る
// - 揺れもの: spring を付けたボーン（髪など）は、親の動きに少し遅れてついていく

import { apply, Skeleton } from './bones.ts';
import { type AvatarState, DEFAULT_POSE, type EyeShape, type Rig, type StatePose } from './manifest.ts';
import { TipSpring } from './spring.ts';

/** 0 以上 1 未満の乱数 */
export type Rng = () => number;

const DEG = Math.PI / 180;

/** 周期のそろわない波の重ね合わせ（-1〜1）。`t` は「何周目か」 */
export class Wobble {
  private readonly phase: [number, number, number];

  constructor(rng: Rng) {
    this.phase = [rng(), rng(), rng()].map((r) => r * 2 * Math.PI) as [number, number, number];
  }

  at(t: number): number {
    const w = 2 * Math.PI * t;
    return 0.6 * Math.sin(w + this.phase[0]) + 0.3 * Math.sin(1.618 * w + this.phase[1]) + 0.1 * Math.sin(2.718 * w + this.phase[2]);
  }
}

/** 目標に向かって指数的に近づける（`tau` 秒で約 63%） */
export function approach(cur: number, target: number, dt: number, tau: number): number {
  if (tau <= 0) return target;
  return target + (cur - target) * Math.exp(-dt / tau);
}

export interface FrameInput {
  /** 経過時間（秒） */
  t: number;
  /** 前のフレームからの時間（秒） */
  dt: number;
  state: AvatarState;
  /** 口の開き具合（0〜1、喋っていなければ 0） */
  mouth: number;
}

/** 状態ごとの姿勢のうち、なめらかに移す数値 */
type PoseNumbers = Omit<StatePose, 'eyes'>;

export class Animator {
  readonly skeleton: Skeleton;
  private readonly rig: Rig;
  private readonly springs: { name: string; spring: TipSpring }[];
  private readonly wobble: { swayA: Wobble; swayX: Wobble; talkA: Wobble; talkX: Wobble };
  private pose: PoseNumbers = { ...DEFAULT_POSE };
  private breathPhase = 0;
  /** 声の勢い（速く追う / ゆっくり追う） */
  private energy = 0;
  private energySlow = 0;

  constructor(rig: Rig, rng: Rng = Math.random) {
    this.rig = rig;
    this.skeleton = new Skeleton(rig.bones);
    this.springs = rig.bones.filter((b) => b.spring).map((b) => ({ name: b.name, spring: new TipSpring(b.spring!) }));
    this.wobble = { swayA: new Wobble(rng), swayX: new Wobble(rng), talkA: new Wobble(rng), talkX: new Wobble(rng) };
    this.breathPhase = rng();
    const { eyes: _, ...start } = rig.states.idle;
    this.pose = start;
  }

  /** その状態で目を固定するなら、その形（まばたきしないとき） */
  eyesFor(state: AvatarState): EyeShape | undefined {
    return this.rig.states[state].eyes;
  }

  update(f: FrameInput): void {
    const { motion } = this.rig;
    const dt = Math.min(Math.max(f.dt, 0), 0.1);

    // 状態ごとの姿勢へなめらかに移る（寝落ちはゆっくり、起きるのは速く）
    const target = this.rig.states[f.state];
    const tau = f.state === 'sleep' ? 1.2 : f.state === 'talk' ? 0.12 : 0.3;
    for (const k of Object.keys(this.pose) as (keyof PoseNumbers)[]) {
      this.pose[k] = approach(this.pose[k], target[k], dt, tau);
    }
    const p = this.pose;

    // 声の勢い（上がるのは速く、下がるのは少しゆっくり）
    this.energy = approach(this.energy, f.mouth, dt, f.mouth > this.energy ? 0.035 : 0.12);
    this.energySlow = approach(this.energySlow, f.mouth, dt, 0.35);

    const sk = this.skeleton;
    sk.reset();

    // 呼吸（吸うときに伸びる）
    this.breathPhase = (this.breathPhase + dt / (motion.breath.period * Math.max(0.1, p.breathSlow))) % 1;
    const inhale = (1 - Math.cos(2 * Math.PI * this.breathPhase)) / 2;
    const body = sk.pose('body');
    if (body) body.squashY = 1 + motion.breath.amount * p.breathDeep * inhale;

    // 頭（待機中のゆらぎ + 喋るときの動き + 状態の姿勢）
    const swayT = f.t / Math.max(0.1, motion.sway.period);
    const talkT = f.t / 1.3;
    const w = this.wobble;
    const angle =
      (p.headAngle + motion.sway.angle * p.sway * w.swayA.at(swayT) + motion.talk.angle * this.energySlow * w.talkA.at(talkT)) * DEG;
    const shift = motion.sway.shift * p.sway * w.swayX.at(swayT) + motion.talk.shift * this.energySlow * w.talkX.at(talkT);
    const lift = -motion.talk.bounce * this.energy + p.headDrop;

    const neck = sk.pose('neck');
    const head = sk.pose('head');
    const neckShare = neck && head ? Math.min(1, Math.max(0, motion.neckShare)) : neck ? 1 : 0;
    if (neck) neck.rotation = angle * neckShare;
    if (head) {
      head.rotation = angle * (1 - neckShare);
      head.x = shift;
      head.y = lift;
    } else if (neck) {
      neck.x = shift;
      neck.y = lift;
    }

    const brows = sk.pose('brows');
    if (brows) brows.y = -motion.brows.lift * this.energy;

    sk.solve();

    // 揺れもの（親が動いたあとで、遅れを計算する）
    for (const { name, spring } of this.springs) {
      const def = sk.bone(name)!;
      const pose = sk.pose(name)!;
      // 揺れがない場合の位置
      const rigid = sk.world.get(name)!;
      const pivot = apply(rigid, def.pivot);
      const tip = apply(rigid, spring.restTip(def.pivot));
      const out = spring.step(pivot, tip, f.dt);
      pose.rotation += out.rotation;
      pose.squashY *= out.stretch;
      sk.solve();
    }
  }
}
