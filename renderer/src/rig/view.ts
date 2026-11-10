// パーツを重ねて、ボーンの計算結果どおりに置く（PixiJS）。
// パーツはすべて同じキャンバスで位置合わせ済みなので、各パーツに「そのボーンの変換」をそのままかける。
// 重ね順は rig.layers の順（ボーンの親子とは無関係。後ろ髪は頭のボーンに付くが、首や体より下に描く）。

import { Container, Matrix, Sprite, type Texture } from 'pixi.js';

import type { Vec } from './bones.ts';
import { blinkFrames, eyeFile, mouthFile, type EyeShape, type Rig, type RigLayer } from './manifest.ts';
import type { Mouth } from './mouth.ts';
import type { Skeleton } from './bones.ts';

interface Part {
  layer: RigLayer;
  sprite: Sprite;
}

export class RigView {
  /** 画像の座標で並べたパーツ。配置（拡大・反転）はこれにかける */
  readonly root = new Container();
  readonly size: Vec;
  /** 閉じ目の絵がある（まばたきできる） */
  readonly canBlink: boolean;
  /** 半目の絵がある */
  readonly hasHalfEyes: boolean;
  private readonly parts: Part[];
  private readonly textures: Map<string, Texture>;
  private readonly m = new Matrix();

  constructor(rig: Rig, textures: Map<string, Texture>) {
    this.textures = textures;
    const tex = (file: string) => {
      const t = textures.get(file);
      if (!t) throw new Error(`画像が読み込まれていません: ${file}`);
      return t;
    };
    this.parts = rig.layers.map((layer) => {
      const first = layer.kind === 'image' ? layer.image : layer.kind === 'mouth' ? layer.closed : layer.open;
      const sprite = new Sprite(tex(first));
      this.root.addChild(sprite);
      return { layer, sprite };
    });
    const first = this.parts[0].sprite.texture;
    this.size = rig.size[0] > 0 && rig.size[1] > 0 ? rig.size : [first.width, first.height];
    const eyes = rig.layers.filter((l) => l.kind === 'eyes');
    this.canBlink = eyes.length > 0 && eyes.every((l) => blinkFrames(l).closed !== undefined);
    this.hasHalfEyes = eyes.length > 0 && eyes.every((l) => blinkFrames(l).half !== undefined);
  }

  /** `blinking` は目が瞬きの途中（瞬き専用のコマを使う）。false なら状態で固定した表情 */
  update(sk: Skeleton, mouth: Mouth, eyes: EyeShape, blinking = true): void {
    for (const { layer, sprite } of this.parts) {
      const w = sk.sprite.get(layer.bone)!;
      this.m.set(w.a, w.b, w.c, w.d, w.tx, w.ty);
      sprite.setFromMatrix(this.m);

      let file: string | undefined;
      if (layer.kind === 'mouth') file = mouthFile(layer, mouth);
      else if (layer.kind === 'eyes') file = eyeFile(layer, eyes, blinking);
      if (file !== undefined) {
        const t = this.textures.get(file)!;
        if (sprite.texture !== t) sprite.texture = t;
      }
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
