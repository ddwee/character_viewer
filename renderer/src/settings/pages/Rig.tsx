import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { boneLabel, EditHistory, setIn, setPivot, setSpringTip, type RawRig } from '../../rig/edit';
import { parseRig, rigImages, type Rig as RigData } from '../../rig/manifest';
import { api } from '../api';
import { Button, Card, Notice, Row, Slider, Toggle } from '../components';
import { RigCanvas, makeMask, type CanvasMode, type Mask } from '../rigCanvas';
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
  { path: ['brows', 'lift'], label: '喋るときに眉が上がる量', min: 0, max: 10, step: 0.5, unit: 'px' },
  { path: ['neckShare'], label: '首が受け持つ傾き', hint: '頭の傾きのうち、首の付け根で曲がる割合', min: 0, max: 1, step: 0.05, unit: '%', scale: 100 },
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
              </div>
            )}
          </div>
        </div>
      </Card>

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

/** キャンバス（毎フレームの描画は RigCanvas に任せ、Preact は設定を渡すだけ） */
function RigCanvasView(props: ConstructorParameters<typeof RigCanvas>[1]) {
  const ref = useRef<HTMLCanvasElement>(null);
  const view = useRef<RigCanvas | null>(null);
  useEffect(() => {
    view.current = new RigCanvas(ref.current!, props);
    return () => view.current?.destroy();
  }, []);
  useEffect(() => view.current?.update(props));
  return <canvas ref={ref} class="rig-canvas checker" />;
}
