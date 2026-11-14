// 実行: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rigFrame, unpremultiply } from './snapshot.ts';

test('半透明の画素の色を元に戻す', () => {
  // 白（255）を半透明（128）で描くと、WebGL からは 128 で読める
  const px = new Uint8ClampedArray([128, 64, 0, 128, 10, 20, 30, 255, 0, 0, 0, 0]);
  unpremultiply(px);
  assert.deepEqual([...px], [255, 128, 0, 128, 10, 20, 30, 255, 0, 0, 0, 0]);
});

test('パーツの写す範囲は OBS の表示と同じ余白（下には余白なし）', () => {
  assert.deepEqual(rigFrame(1000, 2000, 0.03), { x: -30, y: -60, width: 1060, height: 2060 });
});
