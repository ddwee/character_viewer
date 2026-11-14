// 毎フレームの動き（呼吸・頭の揺れ・喋るときの動き・髪のばね）をボーンに与える。
// 描画に依存しない純粋なロジック。
//
// 動きはすべてプログラムで作る（手付けのアニメーションは使わない）。
// - 呼吸: 体（body）をゆっくり縦に伸び縮みさせる。頭は伸びずに少し上下するだけ
// - 待機中のゆらぎ: 頭（neck・head）を、周期のそろわない波の重ね合わせで小さく揺らす（機械的に見えないように）
// - 喋るとき: 声の大きさで頭が少し上がり、傾く。眉（brows）も少し上がる。
//   体は少し縦に伸び、ばねで戻るときに少しつぶれる（squash & stretch。横幅は逆に変えて体積を保つ）
// - 状態ごとの姿勢: 寝落ちでうつむく、など。切り替えはなめらかに移る
// - 揺れもの: spring を付けたボーン（髪など）は、親の動きに少し遅れてついていく
// - 顔の向き: 向き（左右・上下）を「ずれの量（px）」にして渡す。パーツは奥行きに応じてずれる（rig/view.ts）。
//   カメラで読み取った向きがあればそれに従い、なければ待機中・喋るときに小さく自動でゆらす

import { apply, Skeleton, type Mat, type Vec } from './bones.ts';
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

/** 顔の向き（カメラで読み取った値など） */
export interface HeadPose {
  /** 左右の向き（-1〜1。正で絵の右を向く） */
  yaw: number;
  /** 上下の向き（-1〜1。正で下を向く） */
  pitch: number;
  /** 傾き（度。正で時計回り） */
  roll: number;
}

const clamp1 = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);

export interface FrameInput {
  /** 経過時間（秒） */
  t: number;
  /** 前のフレームからの時間（秒） */
  dt: number;
  state: AvatarState;
  /** 口の開き具合（0〜1、喋っていなければ 0） */
  mouth: number;
  /** 顔の向き（カメラなど）。あれば自動のゆらぎを弱めて、これに従う */
  head?: HeadPose;
  /** 呼吸・揺れなどの動きを止める（設定画面でパーツを調整するとき） */
  still?: boolean;
  /** 動きを付けたあと、揺れものを計算する前に、ボーンに手を加える（調整画面で選んだボーンを揺らすなど） */
  adjust?: (sk: Skeleton) => void;
}

/** 状態ごとの姿勢のうち、なめらかに移す数値 */
type PoseNumbers = Omit<StatePose, 'eyes'>;

export class Animator {
  readonly skeleton: Skeleton;
  private readonly rig: Rig;
  private readonly springs: { name: string; spring: TipSpring }[];
  private readonly depths: Map<string, number>;
  private readonly wobble: { swayA: Wobble; swayX: Wobble; talkA: Wobble; talkX: Wobble; turnX: Wobble; turnY: Wobble };
  /** 顔の向きによるずれ（px。奥行き 1 のパーツがずれる量） */
  turn: [number, number] = [0, 0];
  /** カメラの向きへ、なめらかに追う値 */
  private head: HeadPose = { yaw: 0, pitch: 0, roll: 0 };
  private pose: PoseNumbers = { ...DEFAULT_POSE };
  private breathPhase = 0;
  /** 声の勢い（速く追う / ゆっくり追う） */
  private energy = 0;
  private energySlow = 0;
  /** 体の伸び縮み（squash & stretch）のばね */
  private stretch = 0;
  private stretchVel = 0;

  constructor(rig: Rig, rng: Rng = Math.random) {
    this.rig = rig;
    this.skeleton = new Skeleton(rig.bones);
    this.depths = new Map(rig.bones.map((b) => [b.name, b.depth]));
    this.springs = rig.bones.filter((b) => b.spring).map((b) => ({ name: b.name, spring: new TipSpring(b.spring!) }));
    const [swayA, swayX, talkA, talkX] = [new Wobble(rng), new Wobble(rng), new Wobble(rng), new Wobble(rng)];
    this.breathPhase = rng();
    this.wobble = { swayA, swayX, talkA, talkX, turnX: new Wobble(rng), turnY: new Wobble(rng) };
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

    // カメラの向きは、細かい震えを取るために少しだけなめらかに追う（遅れは 1 フレーム程度）
    const h = f.head;
    for (const k of ['yaw', 'pitch', 'roll'] as const) this.head[k] = approach(this.head[k], h ? h[k] : 0, dt, h ? 0.03 : 0.25);
    /** カメラで動かしている間は、自動のゆらぎを弱める */
    const auto = h ? 0.3 : 1;

    const sk = this.skeleton;
    sk.reset();
    if (f.still) {
      this.turn = [0, 0];
      f.adjust?.(sk);
      this.solveSprings(f.dt);
      return;
    }

    // 呼吸（吸うときに伸びる）
    this.breathPhase = (this.breathPhase + dt / (motion.breath.period * Math.max(0.1, p.breathSlow))) % 1;
    const inhale = (1 - Math.cos(2 * Math.PI * this.breathPhase)) / 2;
    // 体の伸び縮み: 声の勢いに向かって伸び、ばねで行きすぎて少しつぶれてから戻る
    this.stepStretch(motion.talk.stretch * f.mouth, dt);
    const body = sk.pose('body');
    if (body) {
      body.squashY = (1 + motion.breath.amount * p.breathDeep * inhale) * (1 + this.stretch);
      body.squashX = 1 - this.stretch * 0.5;
    }

    // 頭（待機中のゆらぎ + 喋るときの動き + 状態の姿勢）
    const swayT = f.t / Math.max(0.1, motion.sway.period);
    const talkT = f.t / 1.3;
    const w = this.wobble;
    const angle =
      (p.headAngle + this.head.roll + auto * (motion.sway.angle * p.sway * w.swayA.at(swayT) + motion.talk.angle * this.energySlow * w.talkA.at(talkT))) * DEG;
    const shift = auto * (motion.sway.shift * p.sway * w.swayX.at(swayT) + motion.talk.shift * this.energySlow * w.talkX.at(talkT));

    // 顔の向き（カメラ + 自動のゆらぎ）
    const { turn } = motion;
    const yaw = clamp1(this.head.yaw + auto * (turn.sway * p.sway * w.turnX.at(swayT * 0.7) + turn.talk * this.energySlow * w.turnX.at(talkT * 0.8)));
    const pitch = clamp1(this.head.pitch + auto * (turn.sway * p.sway * w.turnY.at(swayT * 0.9) + turn.talk * this.energySlow * w.turnY.at(talkT * 0.6)));
    this.turn = [yaw * turn.x, pitch * turn.y];
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

    f.adjust?.(sk);
    this.solveSprings(f.dt);
  }

  /** ボーンの奥行きの分だけ、顔の向きでずらした変換 */
  private shiftByDepth(m: Mat, bone: string): Mat {
    const depth = this.depths.get(bone) ?? 0;
    const [x, y]: Vec = [this.turn[0] * depth, this.turn[1] * depth];
    if (x === 0 && y === 0) return m;
    return { ...m, tx: m.tx + m.a * x + m.c * y, ty: m.ty + m.b * x + m.d * y };
  }

  /** 体の伸び縮みのばね（揺れの速さ 3.5 回/秒、収まりやすさ 0.3） */
  private stepStretch(target: number, dt: number): void {
    const w = 2 * Math.PI * 3.5;
    const z = 0.3;
    const steps = Math.max(1, Math.ceil(dt * 240));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.stretchVel += (-w * w * (this.stretch - target) - 2 * z * w * this.stretchVel) * h;
      this.stretch += this.stretchVel * h;
    }
    // 大きくつぶれすぎないように
    this.stretch = Math.max(-0.05, Math.min(0.05, this.stretch));
  }

  /** 揺れもの（親が動いたあとで、遅れを計算する） */
  private solveSprings(dt: number): void {
    const sk = this.skeleton;
    sk.solve();
    for (const { name, spring } of this.springs) {
      const def = sk.bone(name)!;
      const pose = sk.pose(name)!;
      // 揺れがない場合の位置（顔の向きによるずれも含める。振り向くと髪が遅れてついてくる）
      const rigid = this.shiftByDepth(sk.world.get(name)!, name);
      const pivot = apply(rigid, def.pivot);
      const tip = apply(rigid, spring.restTip(def.pivot));
      const out = spring.step(pivot, tip, dt);
      pose.rotation += out.rotation;
      pose.squashY *= out.stretch;
      sk.solve();
    }
  }
}
