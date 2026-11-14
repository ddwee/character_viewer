// 口の開き具合（閉じ / 半開き / 開き）。描画に依存しない純粋なロジック。
//
// - 喋り始めは、エンジンの「発話」の通知（最速）で即座に開く
// - 喋っている間は、音量（約 100 回/秒で届く）で開き具合を変える
// - 音量は人や距離で大きく変わるので、最近の大きめの音量（ピーク）を基準にした相対値で見る
// - 形が細かく行き来してちらつかないよう、しきい値に幅を持たせ、最低限の時間は同じ形を保つ

export type Mouth = 'closed' | 'half' | 'open';

export const MOUTH = {
  /** ピークからこれだけ下がった音量で「閉じ」、ピーク付近で「開き」になる（dB） */
  rangeDb: 18,
  /** ピークの下がる速さ（dB/秒）。声が小さくなっていっても追いつく */
  peakDecayDbPerSec: 6,
  /** ピークの下限（dB）。無音の雑音を基準にしないように */
  peakFloorDb: -55,
  /** 開き具合（0〜1）がこれ以上で半開き / 開き */
  halfAt: 0.3,
  openAt: 0.65,
  /** しきい値の幅（行き来しないように） */
  hysteresis: 0.08,
  /** 同じ形を保つ最短の時間（ms） */
  minHoldMs: 45,
  /** 音量がこれより古ければ使わない（ms） */
  staleMs: 150,
} as const;

const ORDER: Record<Mouth, number> = { closed: 0, half: 1, open: 2 };

export class MouthController {
  private talking = false;
  private peakDb: number = MOUTH.peakFloorDb;
  private lastDb = -120;
  private levelAt = -Infinity;
  private shape: Mouth = 'closed';
  private shapeAt = -Infinity;
  /** 開き具合（0〜1）。動き（頭の揺れなど）にも使う */
  amount = 0;

  /** 発話の状態が変わった（エンジンの状態の通知） */
  setTalking(talking: boolean, now: number): void {
    if (talking === this.talking) return;
    this.talking = talking;
    if (talking) {
      // 喋り始めは音量を待たずに開く（音量が新しければその値で）
      const fresh = now - this.levelAt <= MOUTH.staleMs;
      this.amount = fresh ? Math.max(this.relative(this.lastDb), MOUTH.openAt) : 1;
      this.set(fresh ? this.classify(this.amount) : 'open', now);
    } else {
      this.amount = 0;
      this.set('closed', now);
    }
  }

  /** 音量（dB）が届いた */
  level(db: number, now: number): void {
    const dt = Math.max(0, (now - this.levelAt) / 1000);
    this.peakDb = Math.max(MOUTH.peakFloorDb, db, Number.isFinite(dt) ? this.peakDb - MOUTH.peakDecayDbPerSec * dt : this.peakDb);
    this.lastDb = db;
    this.levelAt = now;
  }

  /** 今の口の形 */
  update(now: number): Mouth {
    if (!this.talking) return this.shape;
    // 音量が届いていない（古いエンジンなど）なら開いたまま
    if (now - this.levelAt > MOUTH.staleMs) {
      this.amount = 1;
      return this.set('open', now);
    }
    this.amount = this.relative(this.lastDb);
    if (now - this.shapeAt < MOUTH.minHoldMs) return this.shape;
    return this.set(this.classify(this.amount), now);
  }

  private relative(db: number): number {
    const a = (db - (this.peakDb - MOUTH.rangeDb)) / MOUTH.rangeDb;
    return a < 0 ? 0 : a > 1 ? 1 : a;
  }

  /** しきい値に幅を持たせて形を決める（今の形から離れにくい） */
  private classify(a: number): Mouth {
    const cur = ORDER[this.shape];
    const h = MOUTH.hysteresis;
    const up = (t: number, level: number) => (cur >= level ? a >= t - h : a >= t + h);
    if (up(MOUTH.openAt, 2)) return 'open';
    if (up(MOUTH.halfAt, 1)) return 'half';
    return 'closed';
  }

  private set(m: Mouth, now: number): Mouth {
    if (m !== this.shape) {
      this.shape = m;
      this.shapeAt = now;
    }
    return m;
  }
}
