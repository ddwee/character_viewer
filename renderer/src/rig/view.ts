// パーツを重ねて、ボーンの計算結果どおりに置く（PixiJS）。
// パーツはすべて同じキャンバスで位置合わせ済みなので、各パーツに「そのボーンの変換」をそのままかける。
// 重ね順は rig.layers の順（ボーンの親子とは無関係。後ろ髪は頭のボーンに付くが、首や体より下に描く）。
//
// - しなる（bend）パーツは格子状のメッシュにして、頂点ごとに根元と先端の動きを混ぜる（rig/mesh.ts）
// - 差し替え（slot）パーツは、今の値の絵に切り替える。その値の絵がなければ隠す（rig/face.ts）
// - 奥行き（depth）のあるパーツは、顔の向きに合わせてずらす（手前ほど大きく動いて、立体的に見える）
// - 切り抜き（clip）のあるパーツは、指定したパーツの形の中だけに描く（瞳を白目の中だけに）

import { Container, Matrix, Mesh, MeshGeometry, Sprite, Texture } from 'pixi.js';

import type { Mat, Skeleton, Vec } from './bones.ts';
import { canBlink, hasHalfBlink, resolveValue, type SlotValues } from './face.ts';
import { slotVocab, type Rig, type RigLayer } from './manifest.ts';
import { bendWeights, makeGrid, resolveBend, skin } from './mesh.ts';

interface PartBase {
  layer: RigLayer;
  /** 今出している画像（隠れているときは undefined） */
  file?: string;
  /** 今の変換（ボーンの変換 + 奥行き・視線のずれ） */
  mat: Mat;
  /** 切り抜きの形にするパーツ */
  clipBy?: Part;
  /** 切り抜き用のスプライト（clipBy と同じ絵を同じ場所に置く） */
  mask?: Sprite;
}

interface SpritePart extends PartBase {
  kind: 'sprite';
  view: Sprite;
}

interface MeshPart extends PartBase {
  kind: 'mesh';
  view: Mesh;
  geometry: MeshGeometry;
  rest: Float32Array;
  weights: Float32Array;
  indices: Uint32Array;
}

type Part = SpritePart | MeshPart;

/** 網の線（調整画面で表示する用）。positions は画像の座標 */
export interface MeshLines {
  bone: string;
  /** パーツの画像のファイル名 */
  image: string;
  /** 静止時の頂点（画像の座標） */
  rest: Float32Array;
  positions: Float32Array;
  indices: Uint32Array;
}

/** 顔の見た目（毎フレーム渡す） */
export interface FaceView {
  /** スロットの値（rig/face.ts の faceSlots） */
  slots: Readonly<SlotValues>;
  /** 顔の向きによるずれ（px。depth 1 のパーツがずれる量）。Animator.turn */
  turn: Vec;
  /** 視線（-1〜1。左右, 上下） */
  gaze: Vec;
}

const firstFile = (l: RigLayer) => (l.kind === 'image' ? l.image : Object.values(l.frames)[0]);

/** m のあとに平行移動 (x, y) をかけた変換（ずれはボーンと一緒に回る） */
function shifted(m: Mat, x: number, y: number): Mat {
  if (x === 0 && y === 0) return m;
  return { a: m.a, b: m.b, c: m.c, d: m.d, tx: m.tx + m.a * x + m.c * y, ty: m.ty + m.b * x + m.d * y };
}

export class RigView {
  /** 画像の座標で並べたパーツ。配置（拡大・反転）はこれにかける */
  readonly root = new Container();
  readonly size: Vec;
  /** 閉じ目の絵がある（まばたきできる） */
  readonly canBlink: boolean;
  /** 半目の絵がある */
  readonly hasHalfEyes: boolean;
  /** スロットごとの、素材が持つ値 */
  readonly vocab: Map<string, Set<string>>;
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
    const firstTex = tex(firstFile(rig.layers[0]));
    this.size = rig.size[0] > 0 && rig.size[1] > 0 ? rig.size : [firstTex.width, firstTex.height];

    this.parts = rig.layers.map((layer): Part => {
      const t = tex(firstFile(layer));
      const base = { layer, mat: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 } };
      if (layer.kind === 'image' && layer.bend) {
        const bone = rig.bones.find((b) => b.name === layer.bone)!;
        const bend = resolveBend(layer.bend, bone.pivot, bone.spring, this.size);
        // 網は絵のある範囲（余白を切り詰めた範囲）にだけ張る
        const { x, y, width, height } = t.trim ?? t.orig;
        const grid = makeGrid(width, height, bend.grid[0], bend.grid[1], x, y);
        // テクスチャ座標は元のキャンバス全体を 0〜1 とする（切り詰めた分は PixiJS が直す）
        const uvs = grid.rest.map((v, i) => v / (i % 2 === 0 ? t.orig.width : t.orig.height));
        const geometry = new MeshGeometry({ positions: grid.rest.slice(), uvs, indices: grid.indices });
        const view = new Mesh({ geometry, texture: t });
        this.root.addChild(view);
        return { ...base, kind: 'mesh', view, geometry, rest: grid.rest, weights: bendWeights(grid.rest, bone.pivot, bend), indices: grid.indices };
      }
      const view = new Sprite(t);
      this.root.addChild(view);
      return { ...base, kind: 'sprite', view };
    });

    // 切り抜き: 形にするパーツと同じ絵のスプライトを別に用意して、マスクにする
    const byId = new Map(this.parts.flatMap((p) => (p.layer.id === undefined ? [] : [[p.layer.id, p] as const])));
    for (const p of this.parts) {
      if (p.layer.clip === undefined) continue;
      p.clipBy = byId.get(p.layer.clip);
      p.mask = new Sprite(Texture.EMPTY);
      this.root.addChild(p.mask);
      // 形は不透明度で決める（絵の色には左右されない）
      p.view.setMask({ mask: p.mask, channel: 'alpha' });
    }

    this.vocab = slotVocab(rig);
    this.canBlink = canBlink(this.vocab);
    this.hasHalfEyes = hasHalfBlink(this.vocab);
  }

  update(sk: Skeleton, face: FaceView): void {
    const [tx, ty] = face.turn;
    const [gx, gy] = face.gaze;

    for (const part of this.parts) {
      const { layer } = part;
      if (layer.kind === 'slot') {
        const value = resolveValue(layer.slot, face.slots[layer.slot] ?? '', this.vocab.get(layer.slot));
        part.file = value === undefined ? undefined : layer.frames[value];
      } else {
        part.file = layer.image;
      }
      const ox = tx * layer.depth + (layer.gaze ? gx * layer.gaze[0] : 0);
      const oy = ty * layer.depth + (layer.gaze ? gy * layer.gaze[1] : 0);
      part.mat = shifted(sk.sprite.get(layer.bone)!, ox, oy);

      if (part.kind === 'mesh') {
        // 根元 = ボーンが動かなかった場合（親の動きだけ）、先端 = ボーンの動きどおり
        skin(part.rest, part.weights, shifted(sk.parentWorld(layer.bone), ox, oy), part.mat, part.geometry.positions);
        part.geometry.getBuffer('aPosition').update();
        continue;
      }
      part.view.visible = part.file !== undefined;
      if (part.file === undefined) continue;
      this.place(part.view, part.mat);
      const t = this.textures.get(part.file)!;
      if (part.view.texture !== t) part.view.texture = t;
    }

    // 切り抜き（形にするパーツが隠れていたら、切り抜かれる側も隠す）
    for (const part of this.parts) {
      const { clipBy, mask } = part;
      if (!mask) continue;
      const shape = clipBy?.file === undefined ? undefined : this.textures.get(clipBy.file);
      if (!clipBy || !shape) {
        part.view.visible = false;
        continue;
      }
      if (mask.texture !== shape) mask.texture = shape;
      this.place(mask, clipBy.mat);
    }
  }

  private place(view: Sprite, w: Mat): void {
    this.m.set(w.a, w.b, w.c, w.d, w.tx, w.ty);
    view.setFromMatrix(this.m);
  }

  /** パーツごとの透明度（調整画面で、選んだボーン以外を薄くする） */
  setAlpha(alpha: (layer: RigLayer) => number): void {
    for (const p of this.parts) p.view.alpha = alpha(p.layer);
  }

  /** 各パーツが今出している画像と変換（重ね順。隠れているパーツは除く）。調整画面の当たり判定用 */
  shown(): { layer: RigLayer; file: string; mat: Mat }[] {
    return this.parts.flatMap((p) => (p.file === undefined || !p.view.visible ? [] : [{ layer: p.layer, file: p.file, mat: p.mat }]));
  }

  /** しなるパーツの網（今の形） */
  meshLines(): MeshLines[] {
    return this.parts
      .filter((p): p is MeshPart => p.kind === 'mesh')
      .map((p) => ({ bone: p.layer.bone, image: p.layer.kind === 'image' ? p.layer.image : '', rest: p.rest, positions: p.geometry.positions, indices: p.indices }));
  }

  destroy(): void {
    const geometries = this.parts.flatMap((p) => (p.kind === 'mesh' ? [p.geometry] : []));
    this.root.destroy({ children: true });
    for (const g of geometries) g.destroy();
  }
}
