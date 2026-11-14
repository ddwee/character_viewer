// 実行: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { headAngles, lipGap, rawFace } from '../tracker/signals.ts';
import { averageRaw, FaceTracker, peakRaw, toFaceMsg, type CameraConfig, type FaceMsg, type RawFace } from './track.ts';

const near = (a: number, b: number, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

const CONFIG: CameraConfig = {
  enabled: true,
  device: null,
  mirror: true,
  yawRange: 30,
  pitchRange: 20,
  rollGain: 1,
  gaze: true,
  eyes: true,
  expressions: true,
  sensitivity: 1,
  neutral: null,
  ranges: null,
};

const REST: RawFace = {
  yaw: 0, pitch: 0, roll: 0, blinkL: 0.08, blinkR: 0.08, wideL: 0, wideR: 0, lookX: 0, lookY: 0,
  browUpL: 0, browUpR: 0, browDownL: 0, browDownR: 0, browIn: 0, smile: 0, frown: 0, jaw: 0, pucker: 0, stretch: 0, lips: 0.012,
};

/** 同じ値を何度か送って、落ち着いた結果を返す */
function settle(t: FaceTracker, m: FaceMsg, start = 0) {
  for (let i = 0; i < 10; i++) t.update(m, start + i * 33);
  return t.current(start + 9 * 33)!;
}

test('読み取り: 行列から顔の向きを取り出す（本人の左・上・左肩へが正）', () => {
  const deg = Math.PI / 180;
  // y 軸まわりに 20° 回した行列（列優先）。顔の正面が、映像の右（x が正）を向く
  const [c, s] = [Math.cos(20 * deg), Math.sin(20 * deg)];
  const yaw = headAngles([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
  near(yaw.yaw, 20);
  near(yaw.pitch, 0);
  near(yaw.roll, 0);
  // z 軸まわり: 頭のてっぺんが映像の右へ 15° 傾く
  const [c2, s2] = [Math.cos(15 * deg), Math.sin(15 * deg)];
  near(headAngles([c2, -s2, 0, 0, s2, c2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]).roll, 15);
});

test('読み取り: 表情の数値を、生の値にまとめる', () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const raw = rawFace(
    [
      { categoryName: 'eyeBlinkLeft', score: 0.9 },
      { categoryName: 'eyeLookOutLeft', score: 0.6 },
      { categoryName: 'eyeLookInRight', score: 0.4 },
      { categoryName: 'mouthSmileLeft', score: 0.8 },
      { categoryName: 'mouthSmileRight', score: 0.4 },
      { categoryName: 'mouthFunnel', score: 0.7 },
    ],
    identity,
  );
  near(raw.blinkL, 0.9);
  near(raw.blinkR, 0);
  near(raw.lookX, 0.5); // 本人の左を見ている
  near(raw.smile, 0.6);
  near(raw.pucker, 0.7);
  near(raw.yaw, 0);
});

test('カメラ: 鏡のように動かすと、本人の左が絵の左になる', () => {
  const raw: RawFace = { ...REST, yaw: 15, pitch: 10, roll: 12, lookX: 0.3, blinkL: 0.6 };
  const mirror = toFaceMsg(raw, CONFIG);
  // 本人が左を向く・左へ傾く → 絵は左を向き（負）、反時計回りに傾く（負）。上を向くと pitch は負
  near(mirror.yaw!, -0.5);
  near(mirror.pitch!, -0.5);
  near(mirror.roll!, -12);
  assert.ok(mirror.gx! < 0);
  // 本人の左目を閉じる → 絵の左の目が閉じる
  near(mirror.eyeL!, 0);
  near(mirror.eyeR!, 1);
  // 鏡にしないと、向かい合った相手のように左右が入れ替わる
  const facing = toFaceMsg(raw, { ...CONFIG, mirror: false });
  near(facing.yaw!, 0.5);
  near(facing.roll!, 12);
  near(facing.eyeR!, 0);
  near(facing.eyeL!, 1);
  near(facing.pitch!, -0.5);
});

test('カメラ: 基準を引き、範囲を超えない。読み取らない項目は送らない', () => {
  const neutral = { ...REST, yaw: 5, pitch: -4, blinkL: 0.2, blinkR: 0.2, smile: 0.3, browDownL: 0.4, browDownR: 0.4 };
  const cfg = { ...CONFIG, neutral };
  // 基準と同じ顔なら、すべて 0（目はふつうに開いている）
  const same = toFaceMsg(neutral, cfg);
  assert.deepEqual([same.yaw, same.pitch, same.roll, same.smile, same.browL, same.eyeL], [0, 0, 0, 0, 0, 1]);
  const far = toFaceMsg({ ...neutral, yaw: 90, smile: 1 }, cfg);
  assert.equal(far.yaw, -1);
  assert.equal(far.smile, 1);
  const off = toFaceMsg(REST, { ...CONFIG, gaze: false, eyes: false, expressions: false });
  assert.deepEqual(Object.keys(off).sort(), ['ok', 'pitch', 'roll', 'type', 'yaw']);
  // 見開いた目は 1 より大きくなる
  assert.ok(toFaceMsg({ ...REST, wideL: 0.6, wideR: 0.6 }, CONFIG).eyeL! > 1.5);
});

test('カメラ: 基準は生の値の平均', () => {
  const avg = averageRaw([{ ...REST, yaw: 2, smile: 0.2 }, { ...REST, yaw: 4, smile: 0.4 }])!;
  near(avg.yaw, 3);
  near(avg.smile, 0.3);
  assert.equal(averageRaw([]), null);
});

test('カメラ: 目・眉・口の表情を決める', () => {
  const base: FaceMsg = { type: 'face', ok: true, yaw: 0.2, pitch: -0.1, roll: 3, gx: 0.5, gy: 0, eyeL: 1, eyeR: 1, browL: 0, browR: 0, browIn: 0, smile: 0, frown: 0, jaw: 0, pucker: 0, stretch: 0 };
  let f = settle(new FaceTracker(), base);
  assert.deepEqual(f.head, { yaw: 0.2, pitch: -0.1, roll: 3 });
  assert.deepEqual(f.overrides, { eyeL: 'open', eyeR: 'open', browL: 'normal', browR: 'normal' });
  assert.equal(f.eyes, true);
  near(f.gaze![0], 0.5, 0.05);
  assert.equal(f.mouthOpen, 'closed');

  // 瞬き・半目・見開き
  assert.equal(settle(new FaceTracker(), { ...base, eyeL: 0.1, eyeR: 0.1 }).overrides.eyeL, 'closed');
  assert.equal(settle(new FaceTracker(), { ...base, eyeL: 0.5, eyeR: 0.5 }).overrides.eyeL, 'half');
  assert.equal(settle(new FaceTracker(), { ...base, eyeL: 1.8, eyeR: 1.8 }).overrides.eyeR, 'wide');
  // 少しの左右差はそろえる。大きな差はウインク
  f = settle(new FaceTracker(), { ...base, eyeL: 0.75, eyeR: 0.5 });
  assert.equal(f.overrides.eyeL, f.overrides.eyeR);
  f = settle(new FaceTracker(), { ...base, eyeL: 0.05, eyeR: 1 });
  assert.deepEqual([f.overrides.eyeL, f.overrides.eyeR], ['closed', 'open']);

  // 笑顔: 口が笑い、にっこりすると目も笑う。笑うと眉が下がって読み取られるが、怒りにはしない
  f = settle(new FaceTracker(), { ...base, smile: 0.5 });
  assert.deepEqual([f.overrides.mouth, f.overrides.eyeL], ['smile', 'open']);
  f = settle(new FaceTracker(), { ...base, smile: 1, eyeL: 0.7, eyeR: 0.7, browL: -1, browR: -1 });
  assert.deepEqual([f.overrides.mouth, f.overrides.eyeL, f.overrides.browL], ['smile', 'smile', 'normal']);

  // 眉: 上げる / 怒り / 困り（内側だけ上がる）
  assert.equal(settle(new FaceTracker(), { ...base, browL: 0.8, browR: 0.8, browIn: 0.9 }).overrides.browL, 'up');
  assert.equal(settle(new FaceTracker(), { ...base, browL: -0.7, browR: -0.7 }).overrides.browR, 'angry');
  assert.equal(settle(new FaceTracker(), { ...base, browIn: 0.8 }).overrides.browL, 'worried');

  // 口の形と、声が出ていないときの口の開き（最近のいちばん大きな開きに対する割合で見る）
  const t = new FaceTracker();
  f = settle(t, { ...base, stretch: 0.8, jaw: 0.9 });
  assert.deepEqual([f.mouthForm, f.mouthOpen], ['i', 'open']);
  f = settle(t, { ...base, pucker: 0.8, jaw: 0.4 }, 400);
  assert.deepEqual([f.mouthForm, f.mouthOpen], ['u', 'half']);
  assert.equal(settle(t, base, 800).mouthOpen, 'closed');
  assert.equal(settle(new FaceTracker(), { ...base, frown: 0.7 }).overrides.mouth, 'frown');
});

test('カメラ: 境目で細かく行き来しない。値が止まったら、カメラなしの動きに戻る', () => {
  const t = new FaceTracker();
  const base: FaceMsg = { type: 'face', ok: true, eyeL: 1, eyeR: 1, smile: 0 };
  let changes = 0;
  let prev = '';
  for (let i = 0; i < 100; i++) {
    // 「半目」の境目（開き具合 0.6 付近）を ±0.04 で揺らす
    const open = 0.62 + (i % 2 ? 0.04 : -0.04);
    t.update({ ...base, eyeL: open, eyeR: open }, i * 33);
    const now = t.current(i * 33)!.overrides.eyeL;
    if (prev && now !== prev) changes++;
    prev = now;
  }
  assert.ok(changes <= 1, `${changes} 回切り替わった`);

  assert.ok(t.current(100 * 33 + 400));
  assert.equal(t.current(100 * 33 + 700), null); // 届かなくなった
  t.update({ type: 'face', ok: false, status: '顔が見つかりません' }, 5000);
  assert.equal(t.current(5000), null);
  assert.equal(t.last(5000)?.status, '顔が見つかりません');
  // 目を読み取らない設定なら、自動の瞬きに任せる
  t.update({ type: 'face', ok: true, yaw: 0.1 }, 6000);
  assert.equal(t.current(6000)!.eyes, false);
  assert.deepEqual(t.current(6000)!.overrides, {});
});

// ───────── 精度（自然な喋り方で口が動く、ちらつかない、本人の表情の大きさに合わせる） ─────────

/** 再現できる乱数（mulberry32） */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('読み取り: 唇のすき間は、顔の高さに対する割合（顔の大きさによらない）', () => {
  const face = (scale: number, gap: number) => {
    const pts = Array.from({ length: 160 }, () => ({ x: 0.5, y: 0.5 }));
    pts[10] = { x: 0.5, y: 0.5 - 0.2 * scale };
    pts[152] = { x: 0.5, y: 0.5 + 0.2 * scale };
    pts[13] = { x: 0.5, y: 0.55 };
    pts[14] = { x: 0.5, y: 0.55 + gap * scale };
    return pts;
  };
  near(lipGap(face(1, 0.02), 4 / 3), 0.05);
  near(lipGap(face(0.5, 0.02), 4 / 3), 0.05); // カメラから離れても同じ
  assert.equal(lipGap(undefined, 4 / 3), 0);
});

test('口: 自然な喋り方の小さな口の動きでも、開き・半開き・閉じが出る', () => {
  const t = new FaceTracker();
  const seen = new Set<string>();
  let now = 0;
  // 唇のすき間が、閉じ（0.012）〜 小さく開く（0.05）を 1 秒に 3 回ほど行き来する（音の合間は閉じる）。あごの値にはほとんど出ない
  for (let i = 0; i < 150; i++) {
    now += 33;
    const lips = 0.012 + 0.038 * Math.max(0, Math.sin((2 * Math.PI * 3 * now) / 1000));
    t.update(toFaceMsg({ ...REST, lips, jaw: lips * 0.5 }, CONFIG), now);
    seen.add(t.current(now)!.mouthOpen);
  }
  assert.deepEqual([...seen].sort(), ['closed', 'half', 'open']);
  // 黙って口を閉じている間は、読み取りの揺れでは開かない
  const rng = seeded(11);
  const still = new FaceTracker();
  for (let i = 0; i < 150; i++) {
    now += 33;
    still.update(toFaceMsg({ ...REST, lips: 0.012 + (rng() - 0.5) * 0.012 }, CONFIG), now);
    assert.equal(still.current(now)!.mouthOpen, 'closed');
  }
});

test('ちらつき: 境目のあたりで値が揺れても、絵は細かく切り替わらない', () => {
  const rng = seeded(12);
  const t = new FaceTracker();
  const base: FaceMsg = { type: 'face', ok: true, eyeL: 1, eyeR: 1, browL: 0, browR: 0, browIn: 0, smile: 0, frown: 0, jaw: 0, pucker: 0, stretch: 0 };
  const noise = (center: number) => center + (rng() - 0.5) * 0.3; // しきい値をまたぐ大きさの揺れ
  const changes: Record<string, number> = {};
  let prev: Record<string, string | undefined> = {};
  let now = 0;
  for (let i = 0; i < 300; i++) {
    now += 33; // 10 秒間
    t.update({ ...base, browL: noise(0.45), browR: noise(0.45), smile: noise(0.4), pucker: noise(0.5), eyeL: 0.7 + (rng() - 0.5) * 0.25, eyeR: 0.7 + (rng() - 0.5) * 0.25 }, now);
    const f = t.current(now)!;
    const cur = { brow: f.overrides.browL, mouth: f.overrides.mouth, form: f.mouthForm, eye: f.overrides.eyeL };
    for (const [k, v] of Object.entries(cur)) if (i > 0 && v !== prev[k]) changes[k] = (changes[k] ?? 0) + 1;
    prev = cur;
  }
  // 10 秒で数回まで（なめらかにする前は、ほぼ毎フレーム切り替わっていた）
  for (const k of ['brow', 'mouth', 'form', 'eye']) assert.ok((changes[k] ?? 0) <= 6, `${k} が ${changes[k]} 回切り替わった`);
});

test('ちらつき: まばたきは遅らせない。表情は切り替えたら、しばらく保つ', () => {
  const t = new FaceTracker();
  const base: FaceMsg = { type: 'face', ok: true, eyeL: 1, eyeR: 1, browL: 0, browR: 0, smile: 0 };
  settle(t, base);
  // 目を閉じた値が届いたら、その場で閉じる
  t.update({ ...base, eyeL: 0.05, eyeR: 0.05 }, 400);
  assert.equal(t.current(400)!.overrides.eyeL, 'closed');
  // 開けるのも 2 コマ以内
  t.update(base, 433);
  t.update(base, 466);
  assert.equal(t.current(466)!.overrides.eyeL, 'open');
  // 笑顔が一瞬だけ途切れても、口はすぐには戻らない
  const u = new FaceTracker();
  settle(u, { ...base, smile: 0.9 });
  u.update({ ...base, smile: 0 }, 330);
  u.update({ ...base, smile: 0 }, 363);
  assert.equal(u.current(363)!.overrides.mouth, 'smile');
  for (let i = 0; i < 30; i++) u.update({ ...base, smile: 0 }, 400 + i * 33);
  assert.equal(u.current(400 + 29 * 33)!.overrides.mouth, undefined);
});

test('表情の大きさ: 本人の「ふつうの顔 → その表情」の間で見る', () => {
  // ふつうの顔でも眉が「上がっている」（0.64）と読まれる人。眉を上げると 0.9 になる
  const cfg: CameraConfig = { ...CONFIG, neutral: { ...REST, browUpL: 0.64, browUpR: 0.64 }, ranges: { browUpL: 0.9, browUpR: 0.9, smile: 0.35 } };
  const at = (v: number) => toFaceMsg({ ...REST, browUpL: v, browUpR: v }, cfg).browL!;
  assert.equal(at(0.64), 0);
  assert.equal(at(0.9), 1);
  assert.ok(at(0.77) > 0.5 && at(0.77) < 0.7); // 半分ほど上げれば、半分ほどの値
  // ふつうの顔のまま値が少し揺れても、表情は出ない
  const t = new FaceTracker();
  const rng = seeded(13);
  for (let i = 0; i < 200; i++) {
    const v = 0.64 + (rng() - 0.5) * 0.06;
    t.update(toFaceMsg({ ...REST, browUpL: v, browUpR: v }, cfg), i * 33);
    assert.equal(t.current(i * 33)!.overrides.browL, 'normal');
  }
  // 笑顔が小さくしか読まれない人（最大 0.35）でも、笑えば笑顔になる
  assert.ok(toFaceMsg({ ...REST, smile: 0.3 }, cfg).smile! > 0.9);
  assert.ok(toFaceMsg({ ...REST, smile: 0.3 }, CONFIG).smile! < 0.6);
  // 測り損ね（基準とほとんど同じ値）は使わない
  assert.equal(toFaceMsg({ ...REST, smile: 0.3 }, { ...CONFIG, ranges: { smile: 0.01 } }).smile, toFaceMsg({ ...REST, smile: 0.3 }, CONFIG).smile);
});

test('表情の大きさ: 測るときは、一瞬の揺れではなく、保っていた値を使う', () => {
  const samples = [0.1, 0.5, 0.52, 0.5, 0.51, 0.49, 0.5, 0.52, 0.5, 0.95].map((smile) => ({ ...REST, smile }));
  const peak = peakRaw(samples, ['smile'])!;
  assert.ok(peak.smile! >= 0.5 && peak.smile! <= 0.53, `${peak.smile}`);
  assert.deepEqual(Object.keys(peak), ['smile']);
  assert.equal(peakRaw([], ['smile']), null);
});
