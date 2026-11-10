// 実行: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, localMatrix, restPose, Skeleton } from './bones.ts';
import { parseRig, rigImages } from './manifest.ts';
import { Animator } from './motion.ts';
import { MOUTH, MouthController, type Mouth } from './mouth.ts';
import { DEFAULT_SPRING, TipSpring } from './spring.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const nearV = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.forEach((v, i) => near(v, b[i], eps));

/** 再現できる乱数（mulberry32） */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────── ボーン ─────────

test('回転の中心は回しても動かない', () => {
  const m = localMatrix([100, 200], { ...restPose(), rotation: 0.7, scaleX: 1.3, scaleY: 0.8 });
  nearV(apply(m, [100, 200]), [100, 200]);
  // 中心の真右 10px は、時計回りに 90° 回すと真下へ
  nearV(apply(localMatrix([0, 0], { ...restPose(), rotation: Math.PI / 2 }), [10, 0]), [0, 10]);
});

test('子は親の動きを引き継ぐ', () => {
  const sk = new Skeleton([
    { name: 'head', parent: 'neck', pivot: [0, -100] }, // 親より先に書いても良い
    { name: 'neck', pivot: [0, 0] },
  ]);
  assert.deepEqual(
    sk.order.map((b) => b.name),
    ['neck', 'head'],
  );
  sk.pose('neck')!.rotation = Math.PI / 2;
  sk.pose('head')!.y = -10;
  sk.solve();
  // 首の上 100px にある頭の中心は、首が 90° 回ると首の右 100px へ。さらに頭の「上へ 10px」も回って右へ
  nearV(apply(sk.world.get('head')!, [0, -100]), [110, 0]);
});

test('squash はそのボーンの絵だけを伸ばし、子には位置だけを伝える', () => {
  const sk = new Skeleton([
    { name: 'body', pivot: [0, 1000] },
    { name: 'head', parent: 'body', pivot: [0, 600] },
  ]);
  sk.pose('body')!.squashY = 1.01;
  sk.solve();
  // 体の絵は下端を中心に伸びる
  nearV(apply(sk.sprite.get('body')!, [0, 600]), [0, 596]);
  // 頭は 4px 上がるが、伸びない（大きさは 1 のまま）
  const head = sk.sprite.get('head')!;
  nearV(apply(head, [0, 600]), [0, 596]);
  near(head.a, 1);
  near(head.d, 1);
});

test('ボーンの定義の誤りを日本語で知らせる', () => {
  assert.throws(() => new Skeleton([{ name: 'a', parent: 'x', pivot: [0, 0] }]), /親「x」がありません/);
  assert.throws(
    () =>
      new Skeleton([
        { name: 'a', parent: 'b', pivot: [0, 0] },
        { name: 'b', parent: 'a', pivot: [0, 0] },
      ]),
    /循環/,
  );
});

// ───────── ばね ─────────

test('ばね: 親が横に動くと遅れて反対に傾き、やがて元に戻る', () => {
  const s = new TipSpring({ ...DEFAULT_SPRING, length: 100, maxAngle: 30 });
  const dt = 1 / 60;
  s.step([0, 0], [0, 100], dt);
  // 回転の中心ごと右へ 20px 動いた（先端の本来の位置も右へ）
  const out = s.step([20, 0], [20, 100], dt);
  // おもりは左に取り残される → 時計回り（正）に傾く
  assert.ok(out.rotation > 0.05, `${out.rotation}`);
  let last = out;
  for (let i = 0; i < 300; i++) last = s.step([20, 0], [20, 100], dt);
  near(last.rotation, 0, 1e-3);
  near(last.stretch, 1, 1e-3);
});

test('ばね: 回転と伸び縮みは上限を超えない', () => {
  const s = new TipSpring({ ...DEFAULT_SPRING, length: 100, maxAngle: 4, maxStretch: 0.02 });
  s.step([0, 0], [0, 100], 1 / 60);
  const out = s.step([200, -200], [200, -100], 1 / 60);
  assert.ok(Math.abs(out.rotation) <= (4 * Math.PI) / 180 + 1e-9);
  assert.ok(Math.abs(out.stretch - 1) <= 0.02 + 1e-9);
});

test('ばね: フレームが大きく空いたら揺れをリセットする', () => {
  const s = new TipSpring({ ...DEFAULT_SPRING, length: 100 });
  s.step([0, 0], [0, 100], 1 / 60);
  const out = s.step([500, 0], [500, 100], 2);
  assert.equal(out.rotation, 0);
});

// ───────── 口 ─────────

test('口: 喋り始めは音量を待たずに開き、喋り終わりで閉じる', () => {
  const m = new MouthController();
  m.setTalking(true, 1000);
  assert.equal(m.update(1000), 'open');
  m.setTalking(false, 1200);
  assert.equal(m.update(1200), 'closed');
  assert.equal(m.amount, 0);
});

test('口: 音量の大小で 閉じ・半開き・開き が変わる（ピーク基準）', () => {
  const m = new MouthController();
  let now = 0;
  const feed = (db: number, ms = 200) => {
    let shape: Mouth = 'closed';
    for (let t = 0; t < ms; t += 10) {
      now += 10;
      m.level(db, now);
      shape = m.update(now);
    }
    return shape;
  };
  feed(-60);
  m.setTalking(true, now);
  assert.equal(feed(-20), 'open');
  assert.equal(feed(-31), 'half');
  assert.equal(feed(-45), 'closed');
  assert.equal(feed(-21), 'open');
});

test('口: しきい値付近で細かく行き来しない', () => {
  const m = new MouthController();
  let now = 0;
  m.level(-20, now);
  m.setTalking(true, now);
  // ピーク -20dB に対して「開き」のしきい値ちょうど付近を ±1dB で揺らす
  const edge = -20 - MOUTH.rangeDb * (1 - MOUTH.openAt);
  let changes = 0;
  let prev = m.update(now);
  for (let i = 0; i < 100; i++) {
    now += 10;
    m.level(edge + (i % 2 ? 1 : -1), now);
    const s = m.update(now);
    if (s !== prev) changes++;
    prev = s;
  }
  assert.ok(changes <= 1, `${changes} 回切り替わった`);
});

test('口: 音量が届かない（古いエンジン）なら喋っている間は開いたまま', () => {
  const m = new MouthController();
  m.setTalking(true, 0);
  assert.equal(m.update(500), 'open');
});

// ───────── 設定の読み込み ─────────

const SAMPLE = {
  size: [1024, 1024],
  bones: {
    body: { pivot: [512, 1023] },
    neck: { parent: 'body', pivot: [512, 790] },
    head: { parent: 'neck', pivot: [512, 620] },
    brows: { parent: 'head', pivot: [512, 398] },
    frontHair: { parent: 'head', pivot: [512, 200], spring: { length: 330, frequency: 3.5 } },
  },
  layers: [
    { bone: 'body', image: 'parts/body.png' },
    { bone: 'head', image: 'parts/face.png' },
    { bone: 'head', mouth: { closed: 'm0.png', half: 'm1.png', open: 'm2.png' } },
    { bone: 'head', eyes: { open: 'e0.png', half: 'e1.png', closed: 'e2.png' } },
    { bone: 'brows', image: 'parts/brows.png' },
    { bone: 'frontHair', image: 'parts/front.png' },
  ],
  motion: { breath: { amount: 0.01 }, future: 1 },
  states: { sleep: { headAngle: 8 }, away: { eyes: 'half' } },
};

test('rig を読み、書かれていない値は既定値で補う', () => {
  const rig = parseRig(SAMPLE);
  assert.equal(rig.bones.length, 5);
  assert.equal(rig.bones[4].spring?.length, 330);
  assert.equal(rig.bones[4].spring?.damping, DEFAULT_SPRING.damping);
  assert.equal(rig.motion.breath.amount, 0.01);
  assert.equal(rig.motion.breath.period, 3.8);
  assert.equal(rig.states.sleep.headAngle, 8);
  assert.equal(rig.states.sleep.eyes, 'closed'); // 既定値が残る
  assert.equal(rig.states.away.eyes, 'half');
  assert.equal(rig.states.idle.eyes, undefined);
  assert.equal(rigImages(rig).length, 10);
});

test('rig の誤りは場所がわかる日本語で知らせる', () => {
  assert.throws(() => parseRig({ ...SAMPLE, layers: [{ bone: 'nope', image: 'a.png' }] }), /rig\.layers\[0\]\.bone/);
  assert.throws(() => parseRig({ ...SAMPLE, bones: { body: { pivot: [1] } } }), /rig\.bones\.body\.pivot/);
  assert.throws(() => parseRig({ ...SAMPLE, motion: { breath: { amount: 'big' } } }), /rig\.motion\.breath\.amount/);
  assert.throws(() => parseRig({ ...SAMPLE, states: { sleep: { eyes: 'wink' } } }), /rig\.states\.sleep\.eyes/);
});

// ───────── 動き ─────────

/** 頭の中心（画像の座標）が今どこにあるか */
const headAt = (a: Animator) => apply(a.skeleton.world.get('head')!, [512, 620]);

test('動き: 喋ると頭が上がり、黙ると戻る。体の下端は動かない', () => {
  // 待機中のゆらぎと呼吸は止めて比べる
  const a = new Animator(parseRig({ ...SAMPLE, motion: { breath: { amount: 0 }, sway: { angle: 0, shift: 0 } } }), seeded(3));
  const dt = 1 / 60;
  let t = 0;
  const run = (secs: number, state: 'idle' | 'talk', mouth: number) => {
    for (let i = 0; i < secs / dt; i++) a.update({ t: (t += dt), dt, state, mouth });
  };
  run(1, 'idle', 0);
  const idleY = headAt(a)[1];
  run(0.3, 'talk', 1);
  const talkY = headAt(a)[1];
  assert.ok(talkY < idleY - 4, `喋ると頭が上がる ${idleY} → ${talkY}`);
  run(1.5, 'idle', 0);
  assert.ok(Math.abs(headAt(a)[1] - idleY) < 0.5, '黙ると戻る');
  // 体の下端（呼吸の中心）は常に同じ位置
  nearV(apply(a.skeleton.sprite.get('body')!, [300, 1023]), [300, 1023]);
});

test('動き: 寝落ちでうつむき、目を閉じる', () => {
  const a = new Animator(parseRig(SAMPLE), seeded(4));
  const dt = 1 / 60;
  let t = 0;
  for (let i = 0; i < 300; i++) a.update({ t: (t += dt), dt, state: 'sleep', mouth: 0 });
  assert.equal(a.eyesFor('sleep'), 'closed');
  assert.equal(a.eyesFor('idle'), undefined);
  const neck = a.skeleton.pose('neck')!.rotation + a.skeleton.pose('head')!.rotation;
  assert.ok(neck > (4 * Math.PI) / 180, `傾き ${neck}`);
});

test('動き: 長時間動かしても値が発散しない', () => {
  const a = new Animator(parseRig(SAMPLE), seeded(5));
  const rng = seeded(6);
  let t = 0;
  for (let i = 0; i < 60 * 60 * 2; i++) {
    const dt = rng() < 0.01 ? 0.5 : 1 / 30 + rng() * 0.02; // ときどきフレームが飛ぶ
    const talking = Math.floor(t / 3) % 2 === 0;
    a.update({ t: (t += dt), dt, state: talking ? 'talk' : 'idle', mouth: talking ? rng() : 0 });
  }
  for (const [name, p] of a.skeleton.poses) {
    assert.ok([p.x, p.y, p.rotation, p.squashY].every(Number.isFinite), name);
    assert.ok(Math.abs(p.rotation) < 0.2 && Math.abs(p.y) < 30, `${name} ${JSON.stringify(p)}`);
  }
});
