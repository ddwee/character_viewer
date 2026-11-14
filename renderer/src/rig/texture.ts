// パーツの画像を、透明な余白を切り詰めたテクスチャにする（PixiJS）。
//
// パーツは位置合わせのために全部同じ大きさのキャンバスで描くので、ほとんどが透明な余白になる
// （2048×2048 の中の眉 1 本、など）。そのまま GPU に送ると 1 枚あたり約 22MB（縮小用の絵を含む）を使い、
// パーツが 60 枚あると 1GB を超える。絵のある範囲だけを切り出して送り、元の位置に置く。
//
// 切り出したテクスチャは「元のキャンバスの大きさ（orig）」と「絵のある範囲（trim）」を持つので、
// スプライトはこれまでどおり元のキャンバスの座標でそのまま重ねられる。

import { ImageSource, Rectangle, Texture } from 'pixi.js';

/** 絵のある範囲を調べるときの縮小率（速くするため） */
const SCAN_SCALE = 4;
/** 切り出すときに周りに残す余白（px）。縮小表示でも縁がにじまないように */
const PAD = 8;

/** 絵のある範囲（透明でない画素を囲む四角。元の画像の座標）。全部透明なら null */
export function opaqueBounds(rgba: Uint8ClampedArray, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4 + 3;
    for (let x = 0; x < w; x++) {
      if (rgba[row + x * 4] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** 画像を、余白を切り詰めたテクスチャにする */
export function trimmedTexture(img: HTMLImageElement): Texture {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (iw === 0 || ih === 0) return Texture.EMPTY;

  // 縮小した絵で、絵のある範囲を調べる
  const sw = Math.max(1, Math.ceil(iw / SCAN_SCALE));
  const sh = Math.max(1, Math.ceil(ih / SCAN_SCALE));
  const scan = document.createElement('canvas');
  scan.width = sw;
  scan.height = sh;
  const sctx = scan.getContext('2d', { willReadFrequently: true })!;
  sctx.drawImage(img, 0, 0, sw, sh);
  const b = opaqueBounds(sctx.getImageData(0, 0, sw, sh).data, sw, sh);

  const x = b ? Math.max(0, Math.floor((b.x0 * iw) / sw) - PAD) : 0;
  const y = b ? Math.max(0, Math.floor((b.y0 * ih) / sh) - PAD) : 0;
  const w = b ? Math.min(iw, Math.ceil((b.x1 * iw) / sw) + PAD) - x : 1;
  const h = b ? Math.min(ih, Math.ceil((b.y1 * ih) / sh) + PAD) - y : 1;

  const cut = document.createElement('canvas');
  cut.width = w;
  cut.height = h;
  cut.getContext('2d')!.drawImage(img, x, y, w, h, 0, 0, w, h);

  // 縮小表示でも荒れないように（素材は表示サイズより大きく描く前提）
  const source = new ImageSource({ resource: cut, autoGenerateMipmaps: true, scaleMode: 'linear' });
  return new Texture({ source, orig: new Rectangle(0, 0, iw, ih), trim: new Rectangle(x, y, w, h) });
}

/** 画像を読み込む（読み終わるまで待つ） */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`画像を読み込めません: ${decodeURI(url.split('?')[0])}`));
    img.src = url;
  });
}
