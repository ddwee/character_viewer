// ボーン（親子関係と回転の中心）の計算。描画（PixiJS）に依存しない純粋なロジック。
//
// 座標はすべて「素材の画像の座標」（パーツは同じキャンバスで位置合わせ済みなので、全パーツ共通）。
// 各ボーンは静止時の回転の中心（pivot）を持ち、そこを中心に動かす。
// 子のボーンは親の動きを引き継ぐ（頭が傾けば、頭に付いた前髪も一緒に傾く）。

/** 2D アフィン変換。x' = a·x + c·y + tx、y' = b·x + d·y + ty（PixiJS の Matrix と同じ並び） */
export interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export type Vec = readonly [number, number];

export const IDENTITY: Readonly<Mat> = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

/** m ∘ n（先に n、次に m をかける） */
export function multiply(m: Mat, n: Mat): Mat {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    tx: m.a * n.tx + m.c * n.ty + m.tx,
    ty: m.b * n.tx + m.d * n.ty + m.ty,
  };
}

export function apply(m: Mat, [x, y]: Vec): [number, number] {
  return [m.a * x + m.c * y + m.tx, m.b * x + m.d * y + m.ty];
}

/** ボーンの動き（静止時からの差分） */
export interface Pose {
  /** 移動（画像の px） */
  x: number;
  y: number;
  /** 回転（ラジアン、時計回りが正） */
  rotation: number;
  scaleX: number;
  scaleY: number;
  /**
   * そのボーンの絵だけの伸び縮み（pivot が中心）。子には大きさを伝えず、位置だけ伝える。
   * 呼吸で体を縦に伸ばしても、頭は伸びずに少し持ち上がるだけ、のように使う
   */
  squashX: number;
  squashY: number;
}

export const restPose = (): Pose => ({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, squashX: 1, squashY: 1 });

/** pivot を中心にした拡大縮小 */
function scaleAbout([px, py]: Vec, sx: number, sy: number): Mat {
  return { a: sx, b: 0, c: 0, d: sy, tx: px - sx * px, ty: py - sy * py };
}

/** pivot を中心に、拡大縮小 → 回転 → 移動 */
export function localMatrix([px, py]: Vec, p: Pose): Mat {
  const cos = Math.cos(p.rotation);
  const sin = Math.sin(p.rotation);
  const a = cos * p.scaleX;
  const b = sin * p.scaleX;
  const c = -sin * p.scaleY;
  const d = cos * p.scaleY;
  return { a, b, c, d, tx: px + p.x - (a * px + c * py), ty: py + p.y - (b * px + d * py) };
}

export interface BoneDef {
  name: string;
  parent?: string;
  pivot: Vec;
}

export class Skeleton {
  /** 親が先に来る順 */
  readonly order: readonly BoneDef[];
  readonly poses = new Map<string, Pose>();
  /** ボーンの変換（子に伝わる）。squash は含まない */
  readonly world = new Map<string, Mat>();
  /** そのボーンの絵の変換（squash を含む） */
  readonly sprite = new Map<string, Mat>();
  private readonly byName = new Map<string, BoneDef>();

  constructor(defs: readonly BoneDef[]) {
    for (const d of defs) {
      if (this.byName.has(d.name)) throw new Error(`ボーン「${d.name}」が 2 回定義されています`);
      this.byName.set(d.name, d);
    }
    for (const d of defs) {
      if (d.parent !== undefined && !this.byName.has(d.parent)) {
        throw new Error(`ボーン「${d.name}」の親「${d.parent}」がありません`);
      }
    }
    // 親が先になるよう並べる（循環していたらエラー）
    const order: BoneDef[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (d: BoneDef) => {
      const s = state.get(d.name);
      if (s === 'done') return;
      if (s === 'visiting') throw new Error(`ボーン「${d.name}」の親子関係が循環しています`);
      state.set(d.name, 'visiting');
      if (d.parent !== undefined) visit(this.byName.get(d.parent)!);
      state.set(d.name, 'done');
      order.push(d);
    };
    defs.forEach(visit);
    this.order = order;
    this.reset();
    this.solve();
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  bone(name: string): BoneDef | undefined {
    return this.byName.get(name);
  }

  /** 動きを静止時に戻す */
  reset(): void {
    for (const d of this.order) this.poses.set(d.name, restPose());
  }

  pose(name: string): Pose | undefined {
    return this.poses.get(name);
  }

  /** 各ボーンの、画像の座標での変換を求める */
  solve(): void {
    for (const d of this.order) {
      const pose = this.poses.get(d.name)!;
      const world = multiply(this.parentWorld(d.name), localMatrix(d.pivot, pose));
      this.world.set(d.name, world);
      this.sprite.set(d.name, pose.squashX === 1 && pose.squashY === 1 ? world : multiply(world, scaleAbout(d.pivot, pose.squashX, pose.squashY)));
    }
  }

  /**
   * 子のボーンから見た親の変換（親がなければ単位行列）。
   * 親の squash は大きさとしては伝えず、子の pivot が動いた分だけ移動として伝える
   */
  parentWorld(name: string): Mat {
    const d = this.byName.get(name);
    if (d?.parent === undefined) return IDENTITY;
    const world = this.world.get(d.parent)!;
    const pp = this.poses.get(d.parent)!;
    if (pp.squashX === 1 && pp.squashY === 1) return world;
    const [x, y] = apply(scaleAbout(this.byName.get(d.parent)!.pivot, pp.squashX, pp.squashY), d.pivot);
    return multiply(world, { ...IDENTITY, tx: x - d.pivot[0], ty: y - d.pivot[1] });
  }
}
