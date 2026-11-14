import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { boneLabel, EditHistory, setIn, setPivot, setSpringTip, type RawRig } from '../../rig/edit';
import { parseRig, rigImages, slotVocab, type Rig as RigData } from '../../rig/manifest';
import { resolveBend } from '../../rig/mesh';
import { api } from '../api';
import { Button, Card, Notice, Row, Select, Slider, Toggle } from '../components';
import { RigCanvas, makeMask, type CanvasMode, type FaceTest, type Mask } from '../rigCanvas';
import { errorText, toast } from '../store';

/** 変更してから保存するまでの待ち時間（ドラッグ中に何度も保存しないように） */
const SAVE_DELAY_MS = 350;

type SaveState = 'saved' | 'pending' | 'saving' | 'error';

/** 動きの強さのスライダー */
const MOTION_SLIDERS: { path: string[]; label: string; hint?: string; min: number; max: number; step: number; unit: string; scale?: number }[] = [
  { path: ['breath', 'amount'], label: '呼吸の大きさ', hint: '体が縦に伸びる割合', min: 0, max: 0.03, step: 0.001, unit: '%', scale: 100 },
  { path: ['breath', 'period'], label: '呼吸の長さ', hint: '1 回の呼吸の秒数', min: 1.5, max: 8, step: 0.1, unit: '秒' },
  { path: ['sway', 'angle'], label: '待機中の頭の揺れ', min: 0, max: 5, step: 0.1, unit: '°' },
  { path: ['sway', 'shift'], label: '待機中の左右の揺れ', min: 0, max: 10, step: 0.5, unit: 'px' },
  { path: ['talk', 'bounce'], label: '喋るときに頭が上がる量', min: 0, max: 20, step: 0.5, unit: 'px' },
  { path: ['talk', 'angle'], label: '喋るときの頭の傾き', min: 0, max: 8, step: 0.1, unit: '°' },
  { path: ['talk', 'shift'], label: '喋るときの左右の動き', min: 0, max: 10, step: 0.5, unit: 'px' },
  { path: ['talk', 'stretch'], label: '喋るときの体の伸び縮み', hint: '伸びて、戻るときに少しつぶれる', min: 0, max: 0.04, step: 0.001, unit: '%', scale: 100 },
  { path: ['brows', 'lift'], label: '喋るときに眉が上がる量', min: 0, max: 10, step: 0.5, unit: 'px' },
  { path: ['neckShare'], label: '首が受け持つ傾き', hint: '頭の傾きのうち、首の付け根で曲がる割合', min: 0, max: 1, step: 0.05, unit: '%', scale: 100 },
  { path: ['turn', 'x'], label: '顔を横に向けたときのずれ', hint: '奥行き 1 のパーツが、真横いっぱいでずれる量', min: 0, max: 120, step: 1, unit: 'px' },
  { path: ['turn', 'y'], label: '顔を上下に向けたときのずれ', min: 0, max: 120, step: 1, unit: 'px' },
  { path: ['turn', 'sway'], label: '待機中に顔の向きをゆらす量', hint: 'カメラを使わないとき、自動で少し向きを変える', min: 0, max: 0.5, step: 0.01, unit: '%', scale: 100 },
  { path: ['turn', 'talk'], label: '喋るときに顔の向きをゆらす量', min: 0, max: 0.5, step: 0.01, unit: '%', scale: 100 },
];

/** 揺れもののスライダー */
const SPRING_SLIDERS: { key: string; label: string; hint: string; min: number; max: number; step: number; unit: string; scale?: number }[] = [
  { key: 'frequency', label: '揺れの速さ', hint: '大きいほど硬く、すぐ戻る', min: 0.5, max: 8, step: 0.1, unit: '回/秒' },
  { key: 'damping', label: '揺れの収まりやすさ', hint: '小さいほど長く揺れる', min: 0.05, max: 1, step: 0.05, unit: '' },
  { key: 'maxAngle', label: '最大の傾き', hint: '大きく揺れすぎないように', min: 0, max: 15, step: 0.5, unit: '°' },
  { key: 'stretch', label: '伸び縮み', hint: '0 で伸び縮みしない', min: 0, max: 1, step: 0.05, unit: '' },
];

const getPath = (obj: unknown, path: string[]): number => path.reduce<any>((o, k) => o?.[k], obj) as number;

function fmt(v: number, unit: string, scale = 1): string {
  const x = v * scale;
  const digits = Math.abs(x) >= 10 || Number.isInteger(x) ? (Number.isInteger(x) ? 0 : 1) : 2;
  return `${x.toFixed(digits)}${unit === '' ? '' : ` ${unit}`}`;
}

export function Rig() {
  const [raw, setRaw] = useState<RawRig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [stamp, setStamp] = useState(Date.now());
  const [selected, setSelected] = useState('head');
  const [mode, setMode] = useState<CanvasMode>('adjust');
  const [wiggle, setWiggle] = useState(true);
  const [dim, setDim] = useState(true);
  const [talking, setTalking] = useState(false);
  const [showMesh, setShowMesh] = useState(true);
  const [face, setFace] = useState<FaceTest>({ gaze: [0, 0], slots: {} });
  const [save, setSave] = useState<SaveState>('saved');
  const [, setTick] = useState(0);
  const original = useRef<RawRig | null>(null);
  const history = useRef(new EditHistory<RawRig>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<RawRig | null>(null);

  const load = async () => {
    try {
      const r = await api.get<{ rig: RawRig | null }>('/api/avatar/rig');
      setMissing(r.rig === null);
      setRaw(r.rig);
      original.current = r.rig;
      history.current.clear();
      setStamp(Date.now());
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  };
  useEffect(() => {
    load();
  }, []);

  const parsed = useMemo((): { rig?: RigData; error?: string } => {
    if (!raw) return {};
    try {
      return { rig: parseRig(raw) };
    } catch (e) {
      return { error: errorText(e) };
    }
  }, [raw]);
  const rig = parsed.rig;

  useEffect(() => {
    if (rig && !rig.bones.some((b) => b.name === selected)) setSelected(rig.bones[0].name);
  }, [rig]);

  // ───── 保存（少し待ってからまとめて） ─────

  const flush = async () => {
    clearTimeout(saveTimer.current);
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    setSave('saving');
    try {
      await api.put('/api/avatar/rig', next);
      setSave(pending.current ? 'pending' : 'saved');
    } catch (e) {
      setSave('error');
      toast(errorText(e), 'error');
    }
  };
  // ページを離れるときは、まだ保存していない変更を保存する
  useEffect(() => () => void flush(), []);

  const change = (next: RawRig, opts: { record?: boolean; now?: boolean } = {}) => {
    if (!raw) return;
    if (opts.record !== false) history.current.record(raw, performance.now());
    setRaw(next);
    try {
      parseRig(next);
    } catch {
      return; // 正しくない間は保存しない（OBS の表示を壊さない）
    }
    pending.current = next;
    setSave('pending');
    clearTimeout(saveTimer.current);
    if (opts.now) flush();
    else saveTimer.current = setTimeout(flush, SAVE_DELAY_MS);
  };

  const undo = () => {
    const prev = history.current.undo();
    if (prev) change(prev, { record: false, now: true });
    setTick((t) => t + 1);
  };
  const restore = () => {
    if (!original.current) return;
    change(original.current, { now: true });
    history.current.cut();
    toast('開いたときの状態に戻しました');
  };

  // ───── 画像（キャンバス用）を読み込む ─────

  const files = rig ? rigImages(rig).join('\n') : '';
  const [images, setImages] = useState<{ images: Map<string, HTMLImageElement>; masks: Map<string, Mask> } | null>(null);
  useEffect(() => {
    if (!files) return;
    let alive = true;
    const list = files.split('\n');
    Promise.all(
      list.map(
        (f) =>
          new Promise<[string, HTMLImageElement]>((ok, ng) => {
            const img = new Image();
            img.onload = () => ok([f, img]);
            img.onerror = () => ng(new Error(`画像を読み込めません: ${f}`));
            img.src = `/avatar/${encodeURI(f)}?t=${stamp}`;
          }),
      ),
    )
      .then((pairs) => {
        if (!alive) return;
        setImages({ images: new Map(pairs), masks: new Map(pairs.map(([f, img]) => [f, makeMask(img)])) });
      })
      .catch((e) => alive && setLoadError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [files, stamp]);

  // ───── 表示 ─────

  if (loadError) {
    return (
      <div class="page">
        <h1>パーツの調整</h1>
        <Notice kind="error">{loadError}</Notice>
        <Button onClick={load}>読み込み直す</Button>
      </div>
    );
  }
  if (missing) {
    return (
      <div class="page">
        <h1>パーツの調整</h1>
        <Notice>
          今の素材フォルダは 1 枚絵の設定です。パーツを重ねてボーンで動かすには、素材フォルダの avatar.json に <code>rig</code> を書きます（書き方は README の「パーツを重ねてボーンで動かす」）。
          素材フォルダは「画像と動き」のページで変えられます。
        </Notice>
        <Button onClick={load}>読み込み直す</Button>
      </div>
    );
  }
  if (!raw) return null;

  const bone = rig?.bones.find((b) => b.name === selected);
  const rawBone = (raw.bones as Record<string, { spring?: Record<string, unknown> }> | undefined)?.[selected];
  const setPivotNum = (i: 0 | 1, v: number) => bone && Number.isFinite(v) && change(setPivot(raw, selected, i === 0 ? [v, bone.pivot[1]] : [bone.pivot[0], v]));

  return (
    <div class="page">
      <h1>パーツの調整</h1>

      {parsed.error && <Notice kind="error">avatar.json の rig に誤りがあります（直るまで保存しません）: {parsed.error}</Notice>}

      <Card
        title="回転の中心"
        desc={
          <>
            ●（回転の中心）をドラッグして、パーツが自然に回る位置に合わせます。目安は、<b>首は付け根</b>、<b>頭はあごの下</b>、<b>髪は生え際</b>。
            揺れもの（髪など）は ■（先端）で長さと向きを決めます。パーツをクリックすると、そのパーツを選べます。
          </>
        }
        actions={
          <>
            <span class={`small ${save === 'error' ? 'bad' : 'muted'}`}>
              {{ saved: '保存しました', pending: '保存待ち…', saving: '保存しています…', error: '保存できませんでした' }[save]}
            </span>
            <Button small onClick={undo} disabled={history.current.size === 0}>
              元に戻す
            </Button>
            <Button small onClick={restore} disabled={original.current === raw}>
              開いたときに戻す
            </Button>
          </>
        }
      >
        <div class="rig-editor">
          <div class="rig-stage">
            {rig && images ? (
              <RigCanvasView
                rig={rig}
                images={images.images}
                masks={images.masks}
                selected={selected}
                mode={mode}
                wiggle={wiggle}
                dim={dim}
                talking={talking}
                showMesh={showMesh}
                face={face}
                onSelect={setSelected}
                onPivot={(b, p, done) => {
                  change(setPivot(raw, b, p));
                  if (done) history.current.cut();
                }}
                onTip={(b, pivot, tip, done) => {
                  change(setSpringTip(raw, b, pivot, tip));
                  if (done) history.current.cut();
                }}
              />
            ) : (
              <div class="rig-loading muted">{parsed.error ? '' : '読み込んでいます…'}</div>
            )}
            <div class="rig-modes">
              <div class="seg">
                <button class={mode === 'adjust' ? 'on' : ''} onClick={() => setMode('adjust')}>
                  調整する
                </button>
                <button class={mode === 'play' ? 'on' : ''} onClick={() => setMode('play')}>
                  動きを見る
                </button>
              </div>
              {mode === 'adjust' ? (
                <>
                  <label class="check">
                    <input type="checkbox" checked={wiggle} onChange={(e) => setWiggle((e.target as HTMLInputElement).checked)} />
                    揺らして確かめる
                  </label>
                  <label class="check">
                    <input type="checkbox" checked={dim} onChange={(e) => setDim((e.target as HTMLInputElement).checked)} />
                    ほかのパーツを薄く
                  </label>
                </>
              ) : (
                <label class="check">
                  <input type="checkbox" checked={talking} onChange={(e) => setTalking((e.target as HTMLInputElement).checked)} />
                  喋るまね
                </label>
              )}
              <label class="check">
                <input type="checkbox" checked={showMesh} onChange={(e) => setShowMesh((e.target as HTMLInputElement).checked)} />
                網を表示
              </label>
            </div>
          </div>

          <div class="rig-side">
            <div class="label">ボーン</div>
            <div class="bone-list">
              {rig?.bones.map((b) => (
                <button class={`bone ${b.name === selected ? 'on' : ''}`} onClick={() => setSelected(b.name)} key={b.name}>
                  {boneLabel(b.name)}
                  {b.spring && <span class="tag">揺れもの</span>}
                  {b.parent && <span class="muted small">← {boneLabel(b.parent)}</span>}
                </button>
              ))}
            </div>

            {bone && (
              <div class="bone-detail">
                <h3>
                  {boneLabel(bone.name)} <span class="muted small">{bone.name}</span>
                </h3>
                <div class="pivot-inputs">
                  <span class="small muted">回転の中心</span>
                  <label>
                    x <input type="number" value={bone.pivot[0]} onChange={(e) => setPivotNum(0, Number((e.target as HTMLInputElement).value))} />
                  </label>
                  <label>
                    y <input type="number" value={bone.pivot[1]} onChange={(e) => setPivotNum(1, Number((e.target as HTMLInputElement).value))} />
                  </label>
                </div>
                <Row label="揺れもの" hint="頭の動きに遅れてついていく（髪など）">
                  <Toggle
                    checked={!!bone.spring}
                    onChange={(on) => change(setIn(raw, ['bones', selected, 'spring'], on ? (rawBone?.spring ?? { length: 200 }) : undefined))}
                  />
                </Row>
                {bone.spring &&
                  SPRING_SLIDERS.map((s) => (
                    <Row label={s.label} hint={s.hint} key={s.key}>
                      <Slider
                        value={(bone.spring as unknown as Record<string, number>)[s.key]}
                        min={s.min}
                        max={s.max}
                        step={s.step}
                        onInput={(v) => change(setIn(raw, ['bones', selected, 'spring', s.key], v))}
                        format={(v) => fmt(v, s.unit, s.scale)}
                      />
                    </Row>
                  ))}
                {rig && <BendControls rig={rig} raw={raw} bone={selected} change={change} />}
                {rig && <DepthControls rig={rig} raw={raw} bone={selected} change={change} />}
              </div>
            )}
          </div>
        </div>
      </Card>

      {rig && mode === 'play' && <FaceTestCard rig={rig} face={face} setFace={setFace} />}

      {rig && (
        <Card title="動きの強さ" desc="「動きを見る」にすると、OBS と同じ動きで確かめられます。変えるとすぐ OBS の表示にも反映されます">
          {MOTION_SLIDERS.map((s) => (
            <Row label={s.label} hint={s.hint} key={s.path.join('.')}>
              <Slider
                value={getPath(rig.motion, s.path)}
                min={s.min}
                max={s.max}
                step={s.step}
                onInput={(v) => change(setIn(raw, ['motion', ...s.path], v))}
                format={(v) => fmt(v, s.unit, s.scale)}
              />
            </Row>
          ))}
        </Card>
      )}
    </div>
  );
}

/**
 * しなり（メッシュ変形）。選んだボーンの絵のパーツ（目・口以外）に付ける。
 * 根元は動かず、回転の中心から離れるほどボーンの動きどおりになる
 */
function BendControls(props: { rig: RigData; raw: RawRig; bone: string; change: (next: RawRig) => void }) {
  const { rig, raw, bone, change } = props;
  const idx = rig.layers.flatMap((l, i) => (l.kind === 'image' && l.bone === bone ? [i] : []));
  if (idx.length === 0) return null;
  const first = rig.layers[idx[0]];
  const bend = first.kind === 'image' ? first.bend : undefined;
  const def = rig.bones.find((b) => b.name === bone)!;
  const size: [number, number] = rig.size[0] > 0 ? [rig.size[0], rig.size[1]] : [1024, 1024];
  const resolved = bend && resolveBend(bend, def.pivot, def.spring, size);
  /** このボーンのパーツすべてに同じ値を入れる */
  const setAll = (key: string | null, value: unknown) => {
    let next = raw;
    for (const i of idx) next = setIn(next, key === null ? ['layers', String(i), 'bend'] : ['layers', String(i), 'bend', key], value);
    change(next);
  };
  return (
    <>
      <Row label="しなる（メッシュ変形）" hint="根元は動かず、先のほうほど大きく動く（髪のしなり、体の伸び縮み）">
        <Toggle checked={!!bend} onChange={(on) => setAll(null, on ? {} : undefined)} />
      </Row>
      {resolved && (
        <>
          <Row label="動かない範囲" hint="回転の中心からこの距離までは動かない">
            <Slider value={resolved.start} min={0} max={600} step={5} onInput={(v) => setAll('start', v)} format={(v) => `${v} px`} />
          </Row>
          <Row label="全部動く距離" hint={def.spring ? '省略すると揺れものの長さ' : '省略すると絵の高さの 40%'}>
            <Slider value={resolved.end} min={20} max={1000} step={5} onInput={(v) => setAll('end', v)} format={(v) => `${Math.round(v)} px`} />
          </Row>
          <Row label="曲がり方" hint="大きいほど先端に寄せて曲がる">
            <Slider value={resolved.curve} min={0.5} max={3} step={0.1} onInput={(v) => setAll('curve', v)} format={(v) => v.toFixed(1)} />
          </Row>
        </>
      )}
    </>
  );
}

/**
 * 奥行き。選んだボーンのパーツが、顔の向きでどれだけずれるか。
 * 手前のパーツ（前髪・鼻）は大きく、奥のパーツ（後ろ髪・耳）は逆向きにずらすと、立体的に見える
 */
function DepthControls(props: { rig: RigData; raw: RawRig; bone: string; change: (next: RawRig) => void }) {
  const { rig, raw, bone, change } = props;
  const layers = rig.layers.flatMap((l, i) => (l.bone === bone ? [{ l, i }] : []));
  if (layers.length === 0) return null;
  const name = (l: RigData['layers'][number]) => (l.kind === 'image' ? l.image.split('/').pop()! : `${l.slot}${l.id ? `（${l.id}）` : ''}`);
  return (
    <>
      <div class="label depth-label">奥行き（顔の向きでずれる量）</div>
      {layers.map(({ l, i }) => (
        <Row label={<span class="small">{name(l)}</span>} key={i}>
          <Slider value={l.depth} min={-1.5} max={2.5} step={0.05} onInput={(v) => change(setIn(raw, ['layers', String(i), 'depth'], v))} format={(v) => v.toFixed(2)} />
        </Row>
      ))}
    </>
  );
}

/** 顔の向き・視線・表情・差し替えパーツを試す（この画面の中だけ。保存はしない） */
function FaceTestCard(props: { rig: RigData; face: FaceTest; setFace: (f: FaceTest) => void }) {
  const { rig, face, setFace } = props;
  const head = face.head ?? { yaw: 0, pitch: 0, roll: 0 };
  const setHead = (k: 'yaw' | 'pitch' | 'roll', v: number) => setFace({ ...face, head: { ...head, [k]: v } });
  const vocab = [...slotVocab(rig)].filter(([, values]) => values.size > 0);
  const setSlot = (slot: string, value: string) => {
    const slots = { ...face.slots };
    if (value === '') delete slots[slot];
    else slots[slot] = value;
    setFace({ ...face, slots });
  };
  const signed = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
  return (
    <Card
      title="顔の向きと表情を試す"
      desc="カメラで読み取る値の代わりに、ここで動かして確かめます（この画面の中だけ。OBS の表示は変わりません）"
      actions={
        <Button small onClick={() => setFace({ gaze: [0, 0], slots: {} })}>
          リセット
        </Button>
      }
    >
      <Row label="顔の向き（左右）" hint="動かすと、自動のゆらぎの代わりにこの向きになる">
        <Slider value={head.yaw} min={-1} max={1} step={0.02} onInput={(v) => setHead('yaw', v)} format={signed} />
      </Row>
      <Row label="顔の向き（上下）">
        <Slider value={head.pitch} min={-1} max={1} step={0.02} onInput={(v) => setHead('pitch', v)} format={signed} />
      </Row>
      <Row label="頭の傾き">
        <Slider value={head.roll} min={-25} max={25} step={0.5} onInput={(v) => setHead('roll', v)} format={(v) => `${v.toFixed(1)} °`} />
      </Row>
      <Row label="視線（左右）">
        <Slider value={face.gaze[0]} min={-1} max={1} step={0.02} onInput={(v) => setFace({ ...face, gaze: [v, face.gaze[1]] })} format={signed} />
      </Row>
      <Row label="視線（上下）">
        <Slider value={face.gaze[1]} min={-1} max={1} step={0.02} onInput={(v) => setFace({ ...face, gaze: [face.gaze[0], v] })} format={signed} />
      </Row>
      {Object.keys(rig.expressions).length > 0 && (
        <Row label="表情" hint="avatar.json の rig.expressions">
          <div class="chips">
            {['', ...Object.keys(rig.expressions)].map((name) => (
              <button class={`chip ${(face.expression ?? '') === name ? 'on' : ''}`} onClick={() => setFace({ ...face, expression: name || undefined })} key={name}>
                {name || 'なし'}
              </button>
            ))}
          </div>
        </Row>
      )}
      {vocab.map(([slot, values]) => (
        <Row label={<span class="small">{slot}</span>} key={slot}>
          <Select value={face.slots[slot] ?? ''} options={[{ value: '', label: '（自動）' }, ...[...values].map((v) => ({ value: v, label: v }))]} onChange={(v) => setSlot(slot, v)} />
        </Row>
      ))}
    </Card>
  );
}

/** キャンバス（毎フレームの描画は RigCanvas に任せ、Preact は設定を渡すだけ） */
function RigCanvasView(props: ConstructorParameters<typeof RigCanvas>[1]) {
  const ref = useRef<HTMLCanvasElement>(null);
  const view = useRef<RigCanvas | null>(null);
  useEffect(() => {
    view.current = new RigCanvas(ref.current!, props);
    return () => view.current?.destroy();
  }, []);
  useEffect(() => view.current?.update(props));
  // パーツは PixiJS の canvas（RigCanvas が下に入れる）、点と網はこの canvas に描く
  return (
    <div class="rig-canvas-wrap checker">
      <canvas ref={ref} class="rig-overlay" />
    </div>
  );
}
