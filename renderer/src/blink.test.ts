// 実行: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BLINK, BlinkScheduler, blinkDuration, blinkShape, eyeAt, nextInterval, type Eye, type Rng } from './blink.ts';

/** 再現できる乱数（mulberry32） */
function seeded(seed: number): Rng {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const cv = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) / m;
};

test('間隔はばらつきがあり、周期的にならない', () => {
  const rng = seeded(1);
  const idle = Array.from({ length: 5000 }, () => nextInterval(rng, false));
  const talk = Array.from({ length: 5000 }, () => nextInterval(rng, true));
  assert.ok(Math.min(...idle) >= BLINK.minIntervalMs && Math.max(...idle) <= BLINK.maxIntervalMs);
  // 平均 3〜4.5 秒（1 分あたり 13〜20 回）
  assert.ok(mean(idle) > 3000 && mean(idle) < 4500, `idle 平均 ${mean(idle)}`);
  // 喋っているときのほうが多い
  assert.ok(mean(talk) < mean(idle) * 0.85, `talk 平均 ${mean(talk)}`);
  // 変動係数が大きい = 一定の間隔にならない
  assert.ok(cv(idle) > 0.4, `変動係数 ${cv(idle)}`);
});

test('瞬きは 開く→半目→閉じ→半目→開く の順で、閉じるより開くほうが遅い', () => {
  const rng = seeded(2);
  for (let i = 0; i < 200; i++) {
    const s = blinkShape(rng);
    assert.ok(s.opening > s.closing * 0.99 || s.opening >= 60);
    const d = blinkDuration(s);
    assert.ok(d >= 130 && d <= 270, `長さ ${d}`);
    const seq: Eye[] = [];
    for (let t = 0; t < d; t += 1) {
      const e = eyeAt(s, t, true)!;
      if (seq.at(-1) !== e) seq.push(e);
    }
    assert.deepEqual(seq, ['half', 'closed', 'half']);
    assert.equal(eyeAt(s, d, true), null);
  }
});

test('半目の絵がなくても、閉じ目が中央寄りに出る', () => {
  const s = { closing: 40, closed: 60, opening: 100 };
  assert.equal(eyeAt(s, 10, false), 'open');
  assert.equal(eyeAt(s, 25, false), 'closed');
  assert.equal(eyeAt(s, 140, false), 'closed');
  assert.equal(eyeAt(s, 160, false), 'open');
});

test('10 分間の瞬きの回数・2 回連続・最小間隔', () => {
  const sched = new BlinkScheduler(seeded(3), 0);
  const starts: number[] = [];
  let prev: Eye = 'open';
  for (let t = 0; t < 600_000; t += 1000 / 60) {
    const e = sched.update(t, true);
    if (prev === 'open' && e !== 'open') starts.push(t);
    prev = e;
  }
  const perMin = starts.length / 10;
  assert.ok(perMin >= 12 && perMin <= 22, `1 分あたり ${perMin} 回`);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  const doubles = gaps.filter((g) => g < 600).length / gaps.length;
  assert.ok(doubles > 0.05 && doubles < 0.25, `2 回連続の割合 ${doubles}`);
  // 瞬き同士がくっつかない（前の瞬きの長さ + すき間 90ms 以上）
  assert.ok(Math.min(...gaps) >= 130 + 90 - 17, `最小間隔 ${Math.min(...gaps)}`);
});

test('話し終わりの区切りで瞬きしやすくなる', () => {
  let hits = 0;
  for (let seed = 0; seed < 400; seed++) {
    const sched = new BlinkScheduler(seeded(seed), 0);
    sched.cue(1000);
    // 区切りから 300ms 以内に瞬きが始まったか
    for (let t = 1000; t < 1300; t += 1000 / 60) {
      if (sched.update(t, true) !== 'open') {
        hits++;
        break;
      }
    }
  }
  const rate = hits / 400;
  assert.ok(rate > 0.3 && rate < 0.65, `区切りで瞬いた割合 ${rate}`);
});
