// パーツの調整画面のキャンバス（2D canvas）。
// OBS の表示と同じ動きの計算（Animator）でパーツを描き、回転の中心（●）と揺れものの先端（■）を重ねて、
// ドラッグで動かせるようにする。
//
// - 調整モード: 呼吸などは止め、選んだボーンを回転の中心で揺らして見せる（揺れものなら親を揺らして、遅れ方を見せる）
// - 動きを見るモード: OBS と同じ動き。「喋るまね」で口と頭の動きも試せる

import { BlinkScheduler, type Eye } from '../blink';
import { apply, type Vec } from '../rig/bones';
import { fit, invert, toImage, toScreen, type Fit } from '../rig/edit';
import { blinkFrames, eyeFile, mouthFile, rigImages, type Rig, type RigLayer } from '../rig/manifest';
import { Animator } from '../rig/motion';
import { MouthController, type Mouth } from '../rig/mouth';
import { TipSpring } from '../rig/spring';

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
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
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

  constructor(canvas: HTMLCanvasElement, props: CanvasProps) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.props = props;
    this.animator = new Animator(props.rig);
    this.resize = new ResizeObserver(() => this.fitCanvas());
    this.resize.observe(canvas);
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
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
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
    const hasHalf = p.rig.layers.every((l) => l.kind !== 'eyes' || blinkFrames(l).half !== undefined);
    this.eye = playing ? this.blink.update(now, hasHalf) : 'open';

    this.animator.update({
      t: now / 1000,
      dt,
      state: talking ? 'talk' : 'idle',
      mouth: talking ? this.mouth.amount : 0,
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

  private fileFor(layer: RigLayer): string {
    if (layer.kind === 'image') return layer.image;
    if (layer.kind === 'mouth') return mouthFile(layer, this.mouthShape);
    return eyeFile(layer, this.eye, true);
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

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';

    // パーツ
    for (const layer of p.rig.layers) {
      const img = p.images.get(this.fileFor(layer));
      const m = sk.sprite.get(layer.bone);
      if (!img || !m) continue;
      ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.ox, dpr * v.oy);
      ctx.transform(m.a, m.b, m.c, m.d, m.tx, m.ty);
      ctx.globalAlpha = p.dim && p.mode === 'adjust' && layer.bone !== p.selected ? 0.35 : 1;
      ctx.drawImage(img, 0, 0);
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (p.mode === 'adjust') this.drawHandles();
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
    const sk = this.animator.skeleton;
    const pt = toImage(this.view, [sx, sy]);
    for (let i = p.rig.layers.length - 1; i >= 0; i--) {
      const layer = p.rig.layers[i];
      const mask = p.masks.get(this.fileFor(layer));
      const inv = invert(sk.sprite.get(layer.bone)!);
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
