// いまの絵を透過 PNG にするための、描画に依存しない部分（テストできるように分けてある）。

/**
 * WebGL から読んだ画素は「色に透明度を掛けた値」（premultiplied alpha）なので、
 * PNG 用の普通の値に戻す。そのままだと半透明の縁（髪の毛先・輪郭のぼかし）が黒ずむ
 */
export function unpremultiply(px: Uint8ClampedArray): void {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 0 || a === 255) continue;
    const k = 255 / a;
    px[i] = Math.round(px[i] * k);
    px[i + 1] = Math.round(px[i + 1] * k);
    px[i + 2] = Math.round(px[i + 2] * k);
  }
}

/** パーツで動かす素材を写す範囲（OBS の表示と同じく、上と左右に余白をとる。下端はキャンバスの下端） */
export function rigFrame(w: number, h: number, margin: number): { x: number; y: number; width: number; height: number } {
  const mx = Math.round(w * margin);
  const my = Math.round(h * margin);
  return { x: -mx, y: -my, width: w + 2 * mx, height: h + my };
}
