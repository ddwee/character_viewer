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
  assert.deepEqual(rig.motion.turn, { x: 40, y: 24, sway: 0.12, talk: 0.1 });
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
  nearV(apply(a.skeleton.sprite.get('body')!, [300, 1023]), [300, 1023], 0.01);
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

// ───────── 調整画面の道具 ─────────

import { EditHistory, fit, invert, setIn, setPivot, setSpringTip, toImage, toScreen } from './edit.ts';
import { multiply } from './bones.ts';

test('調整: 書き換えは元の rig を変えず、知らない項目を残す', () => {
  const raw = { bones: { head: { pivot: [1, 2], memo: 'x' } }, future: 1 };
  const next = setPivot(raw, 'head', [10.4, 20.6]);
  assert.deepEqual(raw.bones.head.pivot, [1, 2]);
  assert.deepEqual(next, { bones: { head: { pivot: [10, 21], memo: 'x' } }, future: 1 });
  // 途中の項目がなければ作る / undefined なら消す
  const m = setIn(next, ['motion', 'talk', 'bounce'], 4);
  assert.equal((m.motion as { talk: { bounce: number } }).talk.bounce, 4);
  assert.equal('memo' in (setIn(m, ['bones', 'head', 'memo'], undefined).bones as { head: object }).head, false);
});

test('調整: 揺れものの先端から長さと向きを決め、読み込むと同じ先端になる', () => {
  const raw = setSpringTip({ bones: { hair: { pivot: [100, 100] } } }, 'hair', [100, 100], [160, 180]);
  const rig = parseRig({ bones: raw.bones, layers: [{ bone: 'hair', image: 'a.png' }] });
  const s = new TipSpring(rig.bones[0].spring!);
  nearV(s.restTip([100, 100]), [160, 180], 0.2);
  assert.equal(rig.bones[0].spring!.length, 100);
});

test('調整: 画面と画像の座標を行き来できる', () => {
  const f = fit([1024, 1024], 600, 400);
  const p = toScreen(f, [512, 1024]);
  nearV(toImage(f, p), [512, 1024]);
  // 縦に収まり、横は中央
  assert.ok(f.scale * 1024 <= 400 && f.ox > 0);
  const m = localMatrix([3, 4], { ...restPose(), rotation: 0.4, scaleX: 1.2, x: 5 });
  const id = multiply(m, invert(m)!);
  nearV([id.a, id.b, id.c, id.d, id.tx, id.ty], [1, 0, 0, 1, 0, 0]);
});

test('調整: 続けた変更は 1 回分として元に戻せる', () => {
  const h = new EditHistory<number>(50, 600);
  h.record(0, 0);
  h.record(1, 100); // スライダーを動かし続けている
  h.record(2, 200);
  h.cut(); // 指を離した
  h.record(3, 300);
  assert.equal(h.size, 2);
  assert.equal(h.undo(), 3);
  assert.equal(h.undo(), 0);
  assert.equal(h.undo(), undefined);
});

// ───────── 差し替えパーツ（スロット） ─────────

import { canBlink, faceSlots, hasHalfBlink, resolveValue } from './face.ts';
import { slotVocab } from './manifest.ts';

/** 両目で 1 枚の素材（eyes）で、今出す画像 */
function eyesFile(layers: unknown[], input: Parameters<typeof faceSlots>[0]): string | undefined {
  const rig = parseRig({ ...SAMPLE, layers });
  const l = rig.layers[0];
  assert.ok(l.kind === 'slot' && l.slot === 'eyes');
  const value = resolveValue('eyes', faceSlots(input).eyes, slotVocab(rig).get('eyes'));
  return value === undefined ? undefined : l.frames[value];
}

test('目: 瞬きは瞬き専用のコマ、状態で固定するときは表情の絵を使う', () => {
  const layers = [
    { bone: 'head', eyes: { open: 'o.png', half: 'smug.png', closed: 'smile.png', blink: { half: 'bh.png', closed: 'bc.png' } } },
  ];
  assert.equal(eyesFile(layers, { mouth: 'closed', eye: 'half' }), 'bh.png');
  assert.equal(eyesFile(layers, { mouth: 'closed', eye: 'closed' }), 'bc.png');
  assert.equal(eyesFile(layers, { mouth: 'closed', eye: 'open', fixedEyes: 'closed' }), 'smile.png'); // 寝落ちなど
  assert.equal(eyesFile(layers, { mouth: 'closed', eye: 'open', fixedEyes: 'half' }), 'smug.png');
  assert.equal(eyesFile(layers, { mouth: 'closed', eye: 'open' }), 'o.png');
  // 状態で目を固定している間は瞬きしない
  assert.equal(eyesFile(layers, { mouth: 'closed', eye: 'closed', fixedEyes: 'half' }), 'smug.png');
  const rig = parseRig({ ...SAMPLE, layers });
  assert.deepEqual(rigImages(rig).sort(), ['bc.png', 'bh.png', 'o.png', 'smile.png', 'smug.png']);
  assert.ok(canBlink(slotVocab(rig)) && hasHalfBlink(slotVocab(rig)));
});

test('目: 瞬き専用のコマがなければ、表情の絵で瞬きする（今までどおり）', () => {
  const plain = [{ bone: 'head', eyes: { open: 'o.png', half: 'h.png', closed: 'c.png' } }];
  assert.equal(eyesFile(plain, { mouth: 'closed', eye: 'closed' }), 'c.png');
  assert.equal(eyesFile(plain, { mouth: 'closed', eye: 'half' }), 'h.png');
  // 閉じたコマだけなら、半目の代わりも閉じたコマ
  const only = [{ bone: 'head', eyes: { open: 'o.png', half: 'h.png', blink: { closed: 'bc.png' } } }];
  assert.equal(eyesFile(only, { mouth: 'closed', eye: 'half' }), 'bc.png');
  assert.equal(hasHalfBlink(slotVocab(parseRig({ ...SAMPLE, layers: only }))), false);
  // 開いた目しかなければ瞬きできない
  assert.equal(canBlink(slotVocab(parseRig({ ...SAMPLE, layers: [{ bone: 'head', eyes: { open: 'o.png' } }] }))), false);
  assert.throws(() => parseRig({ ...SAMPLE, layers: [{ bone: 'head', eyes: { open: 'o.png', blink: 'x.png' } }] }), /eyes\.blink/);
});

test('スロット: 素材にない値は近い絵で代用し、代わりもなければ隠す', () => {
  const mouth = new Set(['closed', 'half', 'open', 'smile']);
  assert.equal(resolveValue('mouth', 'i', mouth), 'half'); // 「い」の口がなければ半開き
  assert.equal(resolveValue('mouth', 'smile_open', mouth), 'open');
  assert.equal(resolveValue('mouth', 'frown', mouth), 'closed');
  assert.equal(resolveValue('mouth', 'half', new Set(['closed', 'open'])), 'open');
  const eye = new Set(['open', 'half', 'closed']);
  assert.equal(resolveValue('eyeL', 'wide', eye), 'open');
  assert.equal(resolveValue('eyeL', 'down', eye), 'half');
  assert.equal(resolveValue('eyeL', 'squeeze', eye), 'closed');
  assert.equal(resolveValue('browL', 'angry', new Set(['normal'])), 'normal');
  // 頬・涙などは代わりがないので隠す
  assert.equal(resolveValue('cheek', 'none', new Set(['blush', 'pale'])), undefined);
  assert.equal(resolveValue('cheek', 'blush', new Set(['blush', 'pale'])), 'blush');
  assert.equal(resolveValue('tears', 'on', undefined), undefined);
});

test('スロット: 表情の上書きと、瞬き・口パクの重ね方', () => {
  const mouthVocab = new Set(['closed', 'half', 'open', 'smile', 'smile_open', 'frown']);
  // 笑顔（目を閉じて笑う）の間は瞬きを重ねない。口は、喋っていれば「笑顔で開いた口」
  const smile = { eyes: 'smile', mouth: 'smile' };
  let s = faceSlots({ mouth: 'closed', eye: 'closed', overrides: smile }, mouthVocab);
  assert.deepEqual([s.eyeL, s.eyeR, s.mouth], ['smile', 'smile', 'smile']);
  s = faceSlots({ mouth: 'open', eye: 'open', overrides: smile }, mouthVocab);
  assert.equal(s.mouth, 'smile_open');
  // 開いた口の絵がない表情は、喋っている間は音量どおりの口
  assert.equal(faceSlots({ mouth: 'half', eye: 'open', overrides: { mouth: 'frown' } }, mouthVocab).mouth, 'half');
  // 驚いた目（開いている）には瞬きを重ねる。ウインクは閉じた側だけそのまま
  s = faceSlots({ mouth: 'closed', eye: 'closed', overrides: { eyeL: 'wide', eyeR: 'closed', browL: 'up' } });
  assert.deepEqual([s.eyeL, s.eyeR, s.browL, s.browR], ['blink_closed', 'closed', 'up', 'normal']);
  // カメラで読み取った口の形は、口が開いているときだけ使う
  assert.equal(faceSlots({ mouth: 'open', eye: 'open', mouthForm: 'u' }).mouth, 'u');
  assert.equal(faceSlots({ mouth: 'closed', eye: 'open', mouthForm: 'u' }).mouth, 'closed');
  // 頬などの自由なスロットはそのまま通す
  assert.equal(faceSlots({ mouth: 'closed', eye: 'open', overrides: { cheek: 'blush' } }).cheek, 'blush');
});

test('スロット: 奥行き・切り抜き・視線・表情を rig で読める', () => {
  const rig = parseRig({
    ...SAMPLE,
    bones: { ...SAMPLE.bones, frontHair: { parent: 'head', pivot: [512, 200], depth: 1.3 } },
    layers: [
      { bone: 'head', image: 'face.png' },
      { bone: 'head', slot: 'eyeL', id: 'whiteL', frames: { open: 'w.png', half: 'wh.png' }, depth: 1 },
      { bone: 'head', image: 'pupil.png', clip: 'whiteL', gaze: [18, 10], depth: 1 },
      { bone: 'head', slot: 'eyeL', frames: { open: 'l.png', closed: 'lc.png' }, depth: 1 },
      { bone: 'frontHair', image: 'hair.png' },
    ],
    expressions: { smile: { eyes: 'smile', mouth: 'smile' } },
  });
  assert.deepEqual(rig.layers.map((l) => l.depth), [0, 1, 1, 1, 1.3]); // 書かなければボーンの奥行き
  assert.deepEqual(rig.layers[2].gaze, [18, 10]);
  assert.deepEqual([...slotVocab(rig).get('eyeL')!].sort(), ['closed', 'half', 'open']);
  assert.deepEqual(rig.expressions.smile, { eyes: 'smile', mouth: 'smile' });
  const bad = (layers: unknown[]) => () => parseRig({ ...SAMPLE, layers });
  assert.throws(bad([{ bone: 'head', image: 'a.png', clip: 'nope' }]), /layers\[0\]\.clip/);
  assert.throws(bad([{ bone: 'head', image: 'a.png', id: 'x' }, { bone: 'head', image: 'b.png', id: 'x' }]), /id「x」/);
  assert.throws(bad([{ bone: 'head', slot: 'mouth', frames: {} }]), /layers\[0\]\.frames/);
  assert.throws(bad([{ bone: 'head', image: 'a.png', depth: 'far' }]), /layers\[0\]\.depth/);
});

test('動き: 顔の向きは「ずれの量」になり、範囲を超えない。調整中は 0', () => {
  const a = new Animator(parseRig({ ...SAMPLE, motion: { turn: { x: 40, y: 20, sway: 0, talk: 0 } } }), seeded(8));
  const dt = 1 / 60;
  let t = 0;
  const run = (head?: { yaw: number; pitch: number; roll: number }, still = false) => {
    for (let i = 0; i < 60; i++) a.update({ t: (t += dt), dt, state: 'idle', mouth: 0, head, still });
  };
  run();
  nearV(a.turn, [0, 0], 1e-6);
  run({ yaw: 0.5, pitch: -1, roll: 10 });
  nearV(a.turn, [20, -20], 0.01);
  // 傾きは首と頭に分けてかかる
  assert.ok(a.skeleton.pose('neck')!.rotation + a.skeleton.pose('head')!.rotation > (9 * Math.PI) / 180);
  run({ yaw: 5, pitch: 0, roll: 0 });
  near(a.turn[0], 40, 0.01);
  run(undefined, true);
  nearV(a.turn, [0, 0]);
});

// ───────── メッシュ変形（しなり） ─────────

import { bendWeights, makeGrid, resolveBend, skin } from './mesh.ts';

test('メッシュ: 網の頂点と三角形の数、テクスチャ座標', () => {
  const g = makeGrid(100, 50, 4, 2);
  assert.equal(g.rest.length / 2, 5 * 3);
  assert.equal(g.indices.length, 4 * 2 * 6);
  nearV([g.rest[g.rest.length - 2], g.rest[g.rest.length - 1]], [100, 50]);
  nearV([g.uvs[2], g.uvs[3]], [0.25, 0]);
  assert.ok(Math.max(...g.indices) === 14);
});

test('メッシュ: 重みは回転の中心から軸に沿って 0 → 1 に増える', () => {
  const g = makeGrid(100, 400, 1, 4); // 縦に 0, 100, 200, 300, 400
  const b = resolveBend({ start: 100, end: 300, curve: 1, grid: [1, 4] }, [50, 0], undefined, [100, 400]);
  nearV([...b.axis], [0, 1], 1e-3); // 中心から絵の中央へ向かう向き = 下
  const w = bendWeights(g.rest, [50, 0], b);
  // 左の列だけ見る（行ごとに 2 頂点）
  nearV([0, 1, 2, 3, 4].map((j) => w[j * 2]), [0, 0, 0.5, 1, 1]);
  // 揺れものがあれば、その向きと長さを使う
  const s = resolveBend({ start: 0, curve: 1, grid: [1, 1] }, [0, 0], { direction: [1, 0], length: 250 }, [100, 100]);
  nearV([...s.axis, s.end], [1, 0, 250]);
});

test('メッシュ: 根元は親のまま、先端はボーンの動きどおり、途中は混ざる', () => {
  const g = makeGrid(10, 200, 1, 2); // y = 0, 100, 200
  const pivot: [number, number] = [5, 0];
  const w = bendWeights(g.rest, pivot, resolveBend({ start: 0, end: 200, curve: 1, grid: [1, 2] }, pivot, undefined, [10, 200]));
  const root = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
  const tip = localMatrix(pivot, { ...restPose(), rotation: -Math.PI / 2 }); // 先端を横へ振る
  const out = new Float32Array(g.rest.length);
  skin(g.rest, w, root, tip, out);
  nearV([out[0], out[1]], [0, 0]); // 根元（重み 0）は動かない
  nearV([out[8], out[9]], apply(tip, [0, 200])); // 先端（重み 1）は回ったとおり
  const mid = (a: number, b: number) => (a + b) / 2;
  const t = apply(tip, [0, 100]);
  nearV([out[4], out[5]], [mid(0, t[0]), mid(100, t[1])]); // 途中は半分ずつ
});

test('しなり: rig で読める（true は既定値、誤りは日本語で）', () => {
  const rig = parseRig({ ...SAMPLE, layers: [{ bone: 'frontHair', image: 'f.png', bend: true }, { bone: 'body', image: 'b.png', bend: { start: 10, grid: [8, 4], axis: [0, -1], end: 300 } }] });
  const [a, b] = rig.layers;
  assert.ok(a.kind === 'image' && b.kind === 'image');
  assert.deepEqual(a.bend?.grid, [16, 16]);
  assert.deepEqual(b.bend, { start: 10, curve: 1.5, grid: [8, 4], axis: [0, -1], end: 300 });
  assert.throws(() => parseRig({ ...SAMPLE, layers: [{ bone: 'body', image: 'b.png', bend: { grid: [0, 4] } }] }), /bend\.grid/);
  assert.throws(() => parseRig({ ...SAMPLE, layers: [{ bone: 'head', mouth: { closed: 'a', open: 'b' }, bend: true }] }), /image のパーツにだけ/);
});

test('動き: 喋ると体が伸び、戻るときに少しつぶれる（横幅は逆）', () => {
  const a = new Animator(parseRig({ ...SAMPLE, motion: { breath: { amount: 0 } } }), seeded(7));
  const dt = 1 / 120;
  let t = 0;
  const body = () => a.skeleton.pose('body')!;
  for (let i = 0; i < 60; i++) a.update({ t: (t += dt), dt, state: 'talk', mouth: 1 });
  assert.ok(body().squashY > 1.005 && body().squashX < 1, `伸びる ${body().squashY}`);
  let minY = Infinity;
  for (let i = 0; i < 120; i++) {
    a.update({ t: (t += dt), dt, state: 'idle', mouth: 0 });
    minY = Math.min(minY, body().squashY);
  }
  assert.ok(minY < 0.999, `戻るときにつぶれる ${minY}`);
  for (let i = 0; i < 240; i++) a.update({ t: (t += dt), dt, state: 'idle', mouth: 0 });
  near(body().squashY, 1, 1e-3);
});

test('調整: layers（配列）の中も書き換えられる', () => {
  const raw = { layers: [{ bone: 'a', image: 'a.png' }, { bone: 'b', image: 'b.png' }] };
  const next = setIn(raw, ['layers', '1', 'bend'], {});
  assert.ok(Array.isArray(next.layers));
  assert.deepEqual((next.layers as unknown[])[1], { bone: 'b', image: 'b.png', bend: {} });
  assert.deepEqual(setIn(next, ['layers', '1', 'bend'], undefined), raw);
});
