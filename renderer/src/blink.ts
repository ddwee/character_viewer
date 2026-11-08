// まばたきのタイミング（描画に依存しない純粋なロジック）。
//
// 人のまばたきに寄せて、機械的な繰り返しに見えないようにする。
// - 間隔は一定ではなく、右に裾の長い分布（対数正規分布）。平均は 1 分あたり約 15〜20 回
// - 喋っているときは増える（会話中は瞬きが増える）
// - ときどき 2 回続けて瞬く
// - 閉じるのは速く、開くのはゆっくり。1 回ごとの長さも少し揺らぐ
// - 話し終わりや目覚めなど、区切りのタイミングで瞬きしやすい

/** 0 以上 1 未満の乱数 */
export type Rng = () => number;

export type Eye = 'open' | 'half' | 'closed';

export const BLINK = {
  /** 黙っているときの瞬きの間隔（中央値, ms） */
  idleMedianMs: 3400,
  /** 喋っているときの瞬きの間隔（中央値, ms） */
  talkMedianMs: 2600,
  /** 間隔のばらつき（対数正規分布の σ） */
  sigma: 0.55,
  minIntervalMs: 700,
  maxIntervalMs: 9000,
  /** 2 回続けて瞬く確率と、そのすき間（ms） */
  doubleChance: 0.12,
  doubleGapMs: [90, 220] as const,
  /** 話し終わり・目覚めで瞬く確率と、それまでの遅れ（ms） */
  cueChance: 0.45,
  cueDelayMs: [80, 260] as const,
  /** 前の瞬きからこの時間内は区切りの瞬きをしない（ms） */
  cueRefractoryMs: 700,
} as const;

/** 1 回の瞬きの長さ（ms） */
export interface BlinkShape {
  closing: number;
  closed: number;
  opening: number;
}

const between = (rng: Rng, [lo, hi]: readonly [number, number]) => lo + (hi - lo) * rng();

/** 標準正規分布（Box–Muller） */
function gaussian(rng: Rng): number {
  const u = 1 - rng(); // (0, 1]
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** 次の瞬きまでの時間（ms） */
export function nextInterval(rng: Rng, talking: boolean): number {
  const median = talking ? BLINK.talkMedianMs : BLINK.idleMedianMs;
  const ms = median * Math.exp(BLINK.sigma * gaussian(rng));
  return Math.min(BLINK.maxIntervalMs, Math.max(BLINK.minIntervalMs, ms));
}

/** 1 回の瞬きの形。閉じる 30〜60ms、閉じたまま 40〜90ms、開く 60〜120ms */
export function blinkShape(rng: Rng): BlinkShape {
  return { closing: between(rng, [30, 60]), closed: between(rng, [40, 90]), opening: between(rng, [60, 120]) };
}

export function blinkDuration(s: BlinkShape): number {
  return s.closing + s.closed + s.opening;
}

/**
 * 瞬きの開始から `t` ms 後の目の状態。終わっていたら null。
 * 半目の絵がないときは、閉じ目を中央寄りの時間だけ出す。
 */
export function eyeAt(s: BlinkShape, t: number, hasHalf: boolean): Eye | null {
  if (t < 0) return 'open';
  if (t >= blinkDuration(s)) return null;
  const closedFrom = s.closing;
  const closedTo = s.closing + s.closed;
  if (t >= closedFrom && t < closedTo) return 'closed';
  if (hasHalf) return 'half';
  // 半目がなければ、閉じる途中の後半と開く途中の前半を閉じ目にする
  if (t < closedFrom) return t >= s.closing / 2 ? 'closed' : 'open';
  return t < closedTo + s.opening / 2 ? 'closed' : 'open';
}

/** 瞬きの予定を管理する。時刻は呼び出し側が渡す（ms） */
export class BlinkScheduler {
  private readonly rng: Rng;
  private nextAt: number;
  private current: { start: number; shape: BlinkShape } | null = null;
  private lastEnd = -Infinity;
  private talking = false;

  constructor(rng: Rng, now: number) {
    this.rng = rng;
    this.nextAt = now + nextInterval(rng, false);
  }

  /** 喋っているかを伝える（瞬きの頻度が変わる） */
  setTalking(talking: boolean): void {
    this.talking = talking;
  }

  /** 話し終わり・目覚めなどの区切り。確率で少し後に瞬く */
  cue(now: number): void {
    if (this.current || now - this.lastEnd < BLINK.cueRefractoryMs) return;
    if (this.rng() >= BLINK.cueChance) return;
    this.nextAt = Math.min(this.nextAt, now + between(this.rng, BLINK.cueDelayMs));
  }

  /** 瞬きの予定を今から立て直す（まばたきしない絵から戻ったときなど） */
  reschedule(now: number): void {
    if (!this.current) this.nextAt = now + nextInterval(this.rng, this.talking);
  }

  /** すぐに瞬く（確認用） */
  blinkNow(now: number): void {
    if (!this.current) this.nextAt = now;
  }

  /** 次に `update` を呼ぶべき時刻 */
  wakeAt(): number {
    return this.current ? -Infinity : this.nextAt;
  }

  /** 今の目の状態を返す */
  update(now: number, hasHalf: boolean): Eye {
    if (!this.current && now >= this.nextAt) {
      this.current = { start: now, shape: blinkShape(this.rng) };
    }
    if (!this.current) return 'open';

    const eye = eyeAt(this.current.shape, now - this.current.start, hasHalf);
    if (eye !== null) return eye;

    // 瞬きが終わった
    this.lastEnd = now;
    this.current = null;
    this.nextAt =
      this.rng() < BLINK.doubleChance ? now + between(this.rng, BLINK.doubleGapMs) : now + nextInterval(this.rng, this.talking);
    return 'open';
  }
}
