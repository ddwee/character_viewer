// パーツの調整画面のキャンバス。
// パーツは OBS の表示と同じもの（Animator の動きを RigView で描く。PixiJS / WebGL）で描き、
// その上に重ねた 2D canvas に、回転の中心（●）・揺れものの先端（■）・しなるパーツの網を描いて、ドラッグで動かせるようにする。
//
// - 調整モード: 呼吸などは止め、選んだボーンを回転の中心で揺らして見せる（揺れものなら親を揺らして、遅れ方を見せる）
// - 動きを見るモード: OBS と同じ動き。「喋るまね」で口と頭の動きも試せる

import { Application, type Texture } from 'pixi.js';

import { BlinkScheduler, type Eye } from '../blink';
import { apply, type Vec } from '../rig/bones';
import { fit, invert, toImage, toScreen, type Fit } from '../rig/edit';
import { faceSlots, type SlotValues } from '../rig/face';
import { rigImages, type Rig } from '../rig/manifest';
import { Animator, type HeadPose } from '../rig/motion';
import { MouthController, type Mouth } from '../rig/mouth';
import { TipSpring } from '../rig/spring';
import { trimmedTexture } from '../rig/texture';
import { RigView, type FaceView, type MeshLines } from '../rig/view';

export type CanvasMode = 'adjust' | 'play';

/** 当たり判定用の、縮小した不透明度 */
export interface Mask {
  w: number;
  h: number;
  /** 元の画像の大きさ */
  iw: number;
  ih: number;
  alpha: Uint8ClampedArray;
}

/** 動きを見るモードで試す、顔の向き・視線・差し替えパーツ */
export interface FaceTest {
  /** 顔の向き（指定しなければ自動のゆらぎ） */
  head?: HeadPose;
  /** 視線（-1〜1） */
  gaze: Vec;
  /** 表情（rig.expressions の名前） */
  expression?: string;
  /** スロットの値の上書き */
  slots: SlotValues;
}

export interface CanvasProps {
  rig: Rig;
  images: Map<string, HTMLImageElement>;
  masks: Map<string, Mask>;
  selected: string;
  mode: CanvasMode;
  /** 調整モードで、選んだボーンを揺らして見せる */
  wiggle: boolean;
  /** 選んだボーン以外のパーツを薄くする */
  dim: boolean;
  /** 動きを見るモードで、喋るまねをする */
  talking: boolean;
  /** しなるパーツの網を表示する */
  showMesh: boolean;
  /** 動きを見るモードで試す顔 */
  face?: FaceTest;
  onSelect: (bone: string) => void;
  /** 回転の中心をドラッグした（`done` はドラッグを離したとき） */
  onPivot: (bone: string, pivot: Vec, done: boolean) => void;
  /** 揺れものの先端をドラッグした */
  onTip: (bone: string, pivot: Vec, tip: Vec, done: boolean) => void;
}

/** 揺らして見せる角度（度）と、1 往復の秒数 */
const WIGGLE_DEG = 6;
const WIGGLE_SECS = 1.6;
/** 点をつかめる距離（画面の px） */
const GRAB_PX = 14;
const MASK_SCALE = 4;

type Drag = {
  kind: 'pivot' | 'tip';
  bone: string;
  /** つかんだ点の中心とマウスのずれ（画面の px）。つかんだ瞬間に点が跳ばないように */
  dx: number;
  dy: number;
};

/** 画像から当たり判定用の不透明度を作る（1/4 に縮小） */
export function makeMask(img: HTMLImageElement): Mask {
  const w = Math.max(1, Math.round(img.naturalWidth / MASK_SCALE));
  const h = Math.max(1, Math.round(img.naturalHeight / MASK_SCALE));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const alpha = new Uint8ClampedArray(w * h);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
  return { w, h, iw: img.naturalWidth, ih: img.naturalHeight, alpha };
}

/** 声のまね（1 秒に 5 回ほど口が開閉する音量） */
function fakeLevel(now: number): number {
  const t = now / 1000;
  return -18 - 24 * (1 - Math.abs(Math.sin(Math.PI * 2.6 * t)) * (0.75 + 0.25 * Math.sin(t * 1.7)));
}

export class RigCanvas {
  /** 上に重ねる 2D canvas（点と網を描き、マウスを受け取る） */
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly app = new Application();
  private ready = false;
  private destroyed = false;
  private textures = new Map<string, Texture>();
  private texturesFor: Map<string, HTMLImageElement> | null = null;
  private rigView: RigView | null = null;
  private rigViewFor: Rig | null = null;
  private props: CanvasProps;
  private animator: Animator;
  private readonly mouth = new MouthController();
  private readonly blink = new BlinkScheduler(Math.random, performance.now());
  private mouthShape: Mouth = 'closed';
  private eye: Eye = 'open';
  private drag: Drag | null = null;
  private lastAt: number | null = null;
  private raf = 0;
  private view: Fit = { scale: 1, ox: 0, oy: 0 };
  private readonly resize: ResizeObserver;

  /** `canvas` は重ねる 2D canvas。PixiJS の canvas はその直前（下）に入れる */
  constructor(canvas: HTMLCanvasElement, props: CanvasProps) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.props = props;
    this.animator = new Animator(props.rig);
    this.resize = new ResizeObserver(() => this.fitCanvas());
    this.resize.observe(canvas);
    this.app
      .init({ autoStart: false, backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: window.devicePixelRatio || 1, preference: 'webgl' })
      .then(() => {
        if (this.destroyed) return this.app.destroy(true);
        this.app.ticker.stop();
        this.app.canvas.classList.add('rig-gl');
        canvas.parentElement!.insertBefore(this.app.canvas, canvas);
        this.ready = true;
        this.fitCanvas();
      });
    this.fitCanvas();
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    this.raf = requestAnimationFrame(this.frame);
  }

  update(props: CanvasProps): void {
    // rig が変わったら動きの計算を作り直す（回転の中心などを反映）
    if (props.rig !== this.props.rig) this.animator = new Animator(props.rig);
    this.props = props;
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.rigView?.destroy();
    for (const t of this.textures.values()) t.destroy(true);
    if (this.ready) this.app.destroy(true);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
  }

  private fitCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    if (this.ready) this.app.renderer.resize(w, h);
  }

  /** 画像・rig が変わったら、テクスチャと RigView を作り直す */
  private ensureView(): RigView | null {
    const p = this.props;
    if (this.texturesFor !== p.images) {
      this.rigView?.destroy();
      this.rigView = null;
      for (const t of this.textures.values()) t.destroy(true);
      this.textures = new Map([...p.images].map(([f, img]) => [f, trimmedTexture(img)]));
      this.texturesFor = p.images;
    }
    if (this.rigViewFor !== p.rig || !this.rigView) {
      this.rigView?.destroy();
      this.rigView = new RigView(p.rig, this.textures);
      this.rigViewFor = p.rig;
      this.app.stage.addChild(this.rigView.root);
    }
    return this.rigView;
  }

  // ───── 毎フレーム ─────

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const p = this.props;
    const dt = this.lastAt === null ? 0 : (now - this.lastAt) / 1000;
    this.lastAt = now;

    const playing = p.mode === 'play';
    const talking = playing && p.talking;
    this.mouth.setTalking(talking, now);
    if (talking) this.mouth.level(fakeLevel(now), now);
    this.mouthShape = this.mouth.update(now);
    this.blink.setTalking(talking);
    this.eye = playing && this.rigView?.canBlink ? this.blink.update(now, this.rigView.hasHalfEyes) : 'open';

    this.animator.update({
      t: now / 1000,
      dt,
      state: talking ? 'talk' : 'idle',
      mouth: talking ? this.mouth.amount : 0,
      head: playing ? p.face?.head : undefined,
      still: !playing,
      adjust: playing || this.drag || !p.wiggle ? undefined : (sk) => this.wiggle(sk, now),
    });
    this.draw();
  };

  /** 選んだボーンを揺らす。揺れものなら親を揺らして、遅れてついていく様子を見せる */
  private wiggle(sk: Animator['skeleton'], now: number): void {
    const p = this.props;
    const bone = p.rig.bones.find((b) => b.name === p.selected);
    if (!bone) return;
    const target = bone.spring ? bone.parent : bone.name;
    const pose = target === undefined ? undefined : sk.pose(target);
    if (pose) pose.rotation += ((WIGGLE_DEG * Math.PI) / 180) * Math.sin((2 * Math.PI * now) / 1000 / WIGGLE_SECS);
  }

  /** 今の顔（調整モードでは、素の顔のまま） */
  private faceView(rv: RigView): FaceView {
    const p = this.props;
    const test = p.mode === 'play' ? p.face : undefined;
    const overrides = { ...(test?.expression ? p.rig.expressions[test.expression] : undefined), ...test?.slots };
    const slots = faceSlots({ mouth: this.mouthShape, eye: this.eye, overrides }, rv.vocab.get('mouth'));
    return { slots, turn: this.animator.turn, gaze: test?.gaze ?? [0, 0] };
  }

  private size(): Vec {
    const { rig, images } = this.props;
    if (rig.size[0] > 0 && rig.size[1] > 0) return rig.size;
    const first = images.get(rigImages(rig)[0]);
    return first ? [first.naturalWidth, first.naturalHeight] : [1024, 1024];
  }

  private draw(): void {
    const { ctx, canvas } = this;
    const p = this.props;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    this.view = fit(this.size(), w, h);
    const v = this.view;
    const sk = this.animator.skeleton;

    // パーツ（OBS と同じ RigView で描く）
    if (this.ready) {
      const rv = this.ensureView();
      if (rv) {
        rv.root.scale.set(v.scale);
        rv.root.position.set(v.ox, v.oy);
        rv.setAlpha((layer) => (p.dim && p.mode === 'adjust' && layer.bone !== p.selected ? 0.35 : 1));
        rv.update(sk, this.faceView(rv));
        this.app.render();
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (p.showMesh) this.drawMesh();
    if (p.mode === 'adjust') this.drawHandles();
  }

  /** 網の三角形のうち、絵がある（透明でない）もの。網ごとに 1 回だけ調べる */
  private readonly visibleTris = new WeakMap<Float32Array, Uint32Array>();

  private trianglesWithContent(m: MeshLines): Uint32Array {
    const cached = this.visibleTris.get(m.rest);
    if (cached) return cached;
    const mask = this.props.masks.get(m.image);
    const keep: number[] = [];
    for (let t = 0; t < m.indices.length; t += 3) {
      const vs = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
      if (!mask) {
        keep.push(...vs);
        continue;
      }
      // 三角形を囲む範囲に、透明でない点があるか（縮小した不透明度で調べる）
      const xs = vs.map((v) => (m.rest[v * 2] * mask.w) / mask.iw);
      const ys = vs.map((v) => (m.rest[v * 2 + 1] * mask.h) / mask.ih);
      const [x0, x1] = [Math.max(0, Math.floor(Math.min(...xs))), Math.min(mask.w - 1, Math.ceil(Math.max(...xs)))];
      const [y0, y1] = [Math.max(0, Math.floor(Math.min(...ys))), Math.min(mask.h - 1, Math.ceil(Math.max(...ys)))];
      let found = false;
      for (let y = y0; y <= y1 && !found; y++) for (let x = x0; x <= x1 && !found; x++) found = mask.alpha[y * mask.w + x] > 20;
      if (found) keep.push(...vs);
    }
    const out = new Uint32Array(keep);
    this.visibleTris.set(m.rest, out);
    return out;
  }

  /** 選んだボーンのしなるパーツの網（絵がある部分だけ） */
  private drawMesh(): void {
    const { ctx } = this;
    const p = this.props;
    for (const m of this.rigView?.meshLines() ?? []) {
      if (m.bone !== p.selected) continue;
      ctx.strokeStyle = 'rgb(255 80 160 / 0.75)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const pt = (i: number) => toScreen(this.view, [m.positions[i * 2], m.positions[i * 2 + 1]]);
      const tris = this.trianglesWithContent(m);
      for (let t = 0; t < tris.length; t += 3) {
        const [a, b, c] = [pt(tris[t]), pt(tris[t + 1]), pt(tris[t + 2])];
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.lineTo(c[0], c[1]);
        ctx.closePath();
      }
      ctx.stroke();
    }
  }

  private drawHandles(): void {
    const { ctx } = this;
    const p = this.props;
    const sk = this.animator.skeleton;
    const accent = getComputedStyle(this.canvas).getPropertyValue('--accent').trim() || '#3b6fd8';

    const dot = (x: number, y: number, r: number, fill: string, stroke: string) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    };

    // 選んでいないボーンの点（小さく）
    for (const b of p.rig.bones) {
      if (b.name === p.selected) continue;
      const [x, y] = toScreen(this.view, apply(sk.world.get(b.name)!, b.pivot));
      dot(x, y, 4, 'rgb(255 255 255 / 0.85)', 'rgb(0 0 0 / 0.55)');
    }

    const b = p.rig.bones.find((x) => x.name === p.selected);
    if (!b) return;
    const world = sk.world.get(b.name)!;
    const [px, py] = toScreen(this.view, apply(world, b.pivot));

    // 揺れものの先端（■）と、中心からの線
    if (b.spring) {
      const tip = new TipSpring(b.spring).restTip(b.pivot);
      const [tx, ty] = toScreen(this.view, apply(world, tip));
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = accent;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = accent;
      ctx.fillRect(tx - 6, ty - 6, 12, 12);
      ctx.strokeRect(tx - 6, ty - 6, 12, 12);
    }

    // 回転の中心（●）
    dot(px, py, 8, accent, '#fff');
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgb(0 0 0 / 0.6)';
    ctx.fillStyle = '#fff';
    const label = '回転の中心';
    ctx.strokeText(label, px + 12, py + 4);
    ctx.fillText(label, px + 12, py + 4);
  }

  // ───── ドラッグ・クリック ─────

  /** マウスの位置（キャンバスの描画領域の座標。枠線の分を除く） */
  private point(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left - this.canvas.clientLeft, e.clientY - r.top - this.canvas.clientTop];
  }

  /** 画面の点にある、つかめるもの（いちばん近いもの。点が重なっていたら、選んでいるボーンを少し優先） */
  private grab(sx: number, sy: number): Drag | null {
    const p = this.props;
    const sk = this.animator.skeleton;
    let best: { d: number; drag: Drag } | null = null;
    const consider = (pt: Vec, kind: Drag['kind'], bone: string) => {
      const [x, y] = toScreen(this.view, pt);
      const d = Math.hypot(x - sx, y - sy) * (bone === p.selected ? 0.8 : 1);
      if (d <= GRAB_PX && (!best || d < best.d)) best = { d, drag: { kind, bone, dx: x - sx, dy: y - sy } };
    };
    for (const b of p.rig.bones) {
      const world = sk.world.get(b.name)!;
      consider(apply(world, b.pivot), 'pivot', b.name);
      // 先端は選んでいるボーンのものだけ表示しているので、つかめるのもそれだけ
      if (b.spring && b.name === p.selected) consider(apply(world, new TipSpring(b.spring).restTip(b.pivot)), 'tip', b.name);
    }
    return (best as { drag: Drag } | null)?.drag ?? null;
  }

  /** 画面の点にあるパーツのボーン（上に重なっているものから） */
  private pick(sx: number, sy: number): string | null {
    const p = this.props;
    const pt = toImage(this.view, [sx, sy]);
    const shown = this.rigView?.shown() ?? [];
    for (let i = shown.length - 1; i >= 0; i--) {
      const { layer, file, mat } = shown[i];
      const mask = p.masks.get(file);
      const inv = invert(mat);
      if (!mask || !inv) continue;
      const [x, y] = apply(inv, pt);
      const mx = Math.floor((x * mask.w) / mask.iw);
      const my = Math.floor((y * mask.h) / mask.ih);
      if (mx < 0 || my < 0 || mx >= mask.w || my >= mask.h) continue;
      if (mask.alpha[my * mask.w + mx] > 40) return layer.bone;
    }
    return null;
  }

  private onDown = (e: PointerEvent): void => {
    if (this.props.mode !== 'adjust' || e.button !== 0) return;
    const [sx, sy] = this.point(e);
    const g = this.grab(sx, sy);
    if (g) {
      this.drag = g;
      if (g.bone !== this.props.selected) this.props.onSelect(g.bone);
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
    const bone = this.pick(sx, sy);
    if (bone) this.props.onSelect(bone);
  };

  private onMove = (e: PointerEvent): void => {
    const [sx, sy] = this.point(e);
    if (!this.drag) {
      if (this.props.mode === 'adjust') this.canvas.style.cursor = this.grab(sx, sy) ? 'grab' : this.pick(sx, sy) ? 'pointer' : 'default';
      return;
    }
    this.move(sx, sy, false);
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.drag) return;
    const [sx, sy] = this.point(e);
    this.move(sx, sy, true);
    this.drag = null;
    this.canvas.style.cursor = 'grab';
  };

  private move(sx: number, sy: number, done: boolean): void {
    const d = this.drag!;
    const bone = this.props.rig.bones.find((b) => b.name === d.bone);
    if (!bone) return;
    // ドラッグ中は揺らさないので、親は静止している。画面の点はそのまま画像の座標になる
    const [x, y] = toImage(this.view, [sx + d.dx, sy + d.dy]);
    const parent = this.animator.skeleton.parentWorld(d.bone);
    const inv = invert(parent);
    const local = inv ? apply(inv, [x, y]) : ([x, y] as [number, number]);
    if (d.kind === 'pivot') this.props.onPivot(d.bone, local, done);
    else this.props.onTip(d.bone, bone.pivot, local, done);
  }
}
