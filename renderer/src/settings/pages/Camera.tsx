import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { parseRig } from '../../rig/manifest';
import { averageRaw, FaceTracker, peakRaw, type FaceMsg, type RawFace, type Tracked } from '../../rig/track';
import { api } from '../api';
import { Button, Card, Notice, Row, Select, Slider, Toggle } from '../components';
import { errorText, toast, useSettings } from '../store';
import { Preview } from './Preview';

/** 基準を測る時間（ms） */
const NEUTRAL_MS = 1500;
/** 表情の大きさを測る時間（ms）。押してからその表情を作る時間も含む */
const RANGE_MS = 2500;

/** 覚えさせる表情（その表情をしたときの、生の値の大きさを測る） */
const RANGE_STEPS: { id: string; label: string; hint: string; keys: (keyof RawFace)[] }[] = [
  { id: 'smile', label: 'にっこり笑う', hint: '口の笑顔と、笑った目（^^）に使う', keys: ['smile'] },
  { id: 'up', label: '眉を上げて、目を見開く', hint: '驚いた顔', keys: ['browUpL', 'browUpR', 'wideL', 'wideR'] },
  { id: 'angry', label: '眉をひそめる', hint: '怒った顔', keys: ['browDownL', 'browDownR'] },
  { id: 'worried', label: '眉を八の字にする', hint: '困った顔。難しければ飛ばしてよい', keys: ['browIn'] },
  { id: 'frown', label: '口をへの字にする', hint: '', keys: ['frown'] },
  { id: 'u', label: '口をすぼめて「う」', hint: '', keys: ['pucker'] },
  { id: 'i', label: '口を横に引いて「い」', hint: '', keys: ['stretch'] },
  { id: 'blink', label: '両目を閉じる', hint: 'まばたきで目が閉じきらないときに', keys: ['blinkL', 'blinkR'] },
];

/** カメラで読み取った顔を、エンジンから受け取る（約 30 回/秒）。画面の更新は 10 回/秒に抑える */
function useFace(): { msg: FaceMsg | null; tracked: Tracked | null; samples: { current: RawFace[] | null } } {
  const [state, setState] = useState<{ msg: FaceMsg | null; tracked: Tracked | null }>({ msg: null, tracked: null });
  /** 基準を測っている間だけ、生の値を溜める */
  const samples = useRef<RawFace[] | null>(null);
  useEffect(() => {
    const tracker = new FaceTracker();
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const open = () => {
      ws = new WebSocket(`ws://${location.host}/ws?role=monitor`);
      ws.onopen = () => ws?.send(JSON.stringify({ type: 'subscribe', face: true }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data) as FaceMsg;
        if (m.type !== 'face') return;
        tracker.update(m, performance.now());
        if (m.ok && m.raw) samples.current?.push(m.raw);
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(open, 1500);
      };
    };
    open();
    const timer = setInterval(() => {
      const now = performance.now();
      setState({ msg: tracker.last(now), tracked: tracker.current(now) });
    }, 100);
    return () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(timer);
      ws?.close();
    };
  }, []);
  return { ...state, samples };
}

/** この PC のカメラの名前（一度カメラの使用を許可するまでは、名前が分からない） */
function useCameras(refresh: unknown): string[] {
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((ds) => setList([...new Set(ds.filter((d) => d.kind === 'videoinput' && d.label).map((d) => d.label))]))
      .catch(() => {});
  }, [refresh]);
  return list;
}

/** -1〜1（または 0〜1）の値の棒 */
function Bar(props: { value: number | undefined; signed?: boolean; max?: number }) {
  const max = props.max ?? 1;
  const v = Math.max(props.signed ? -1 : 0, Math.min(1, (props.value ?? 0) / max));
  const style = props.signed ? { left: `${v < 0 ? 50 + v * 50 : 50}%`, width: `${Math.abs(v) * 50}%` } : { left: '0%', width: `${v * 100}%` };
  return (
    <div class={`face-bar ${props.signed ? 'signed' : ''}`}>
      <div class="face-bar-fill" style={style} />
    </div>
  );
}

const SLOT_LABELS: Record<string, string> = { eyeL: '目（絵の左）', eyeR: '目（絵の右）', browL: '眉（絵の左）', browR: '眉（絵の右）', mouth: '口の表情' };

/** キーの組み合わせを、global-hotkey（アプリ側）が読める書き方にする。修飾キーだけなら null */
function hotkeyFrom(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  // ふつうの文字キーだけでは、文字が打てなくなるので受け付けない（F1〜F24 とテンキーは単独でもよい）
  if (mods.length === 0 && !/^(F\d{1,2}|Numpad.+)$/.test(e.code)) return null;
  return [...mods, e.code].join('+');
}

const hotkeyLabel = (h: string) => h.replace(/Digit|Key/g, '').replace(/Numpad/g, 'テンキー ').split('+').join(' + ');

export function Camera() {
  const { settings, update, replace, info } = useSettings();
  const { msg, tracked, samples } = useFace();
  const [measuring, setMeasuring] = useState(false);
  /** 表情の大きさを測っている項目 */
  const [ranging, setRanging] = useState<string | null>(null);
  const [expressions, setExpressions] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [capturing, setCapturing] = useState<string | null>(null);
  const cameras = useCameras(msg?.ok);

  // 素材の表情（rig.expressions）と、今選んでいる表情
  useEffect(() => {
    api
      .get<{ rig: unknown }>('/api/avatar/rig')
      .then((r) => setExpressions(r.rig ? Object.keys(parseRig(r.rig).expressions) : []))
      .catch(() => setExpressions([]));
  }, [settings?.avatar.dir]);

  // 今選んでいる表情（キーで切り替えたときも表示を合わせる）
  useEffect(() => {
    const load = () =>
      api
        .get<{ name: string | null }>('/api/expression')
        .then((r) => setChosen(r.name))
        .catch(() => {});
    load();
    const timer = setInterval(load, 1000);
    return () => clearInterval(timer);
  }, []);

  // キーの割り当て: 押したキーの組み合わせを記録する
  useEffect(() => {
    if (!capturing) return;
    const on = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === 'Escape') return setCapturing(null);
      const h = hotkeyFrom(e);
      if (!h) return;
      update((s) => {
        // 同じキーをほかの表情が使っていたら外す
        for (const [k, v] of Object.entries(s.hotkeys)) if (v === h) delete s.hotkeys[k];
        s.hotkeys[capturing] = h;
      });
      setCapturing(null);
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [capturing]);

  const slots = useMemo(() => Object.entries(tracked?.overrides ?? {}), [tracked]);

  if (!settings) return null;
  const c = settings.camera;

  const showWindow = async () => {
    try {
      await api.post('/api/camera/window', { show: true });
    } catch {
      // ブラウザで設定画面を開いているとき: 読み取りページを別のタブで開く
      window.open('/tracker/', 'cv-tracker');
    }
  };

  const enable = (on: boolean) => {
    update((s) => void (s.camera.enabled = on));
    // 初めて使うときは、カメラの使用を許可する確認がウィンドウに出るので、見えるようにする
    if (on) void showWindow();
  };

  const measureNeutral = () => {
    samples.current = [];
    setMeasuring(true);
    setTimeout(() => {
      const neutral = averageRaw(samples.current ?? []);
      samples.current = null;
      setMeasuring(false);
      if (!neutral) return toast('顔を読み取れませんでした。カメラに顔が映っているか確かめてください', 'error');
      update((s) => void (s.camera.neutral = neutral));
      toast('今の顔を基準にしました');
    }, NEUTRAL_MS);
  };

  const measureRange = (step: (typeof RANGE_STEPS)[number]) => {
    samples.current = [];
    setRanging(step.id);
    setTimeout(() => {
      const peak = peakRaw(samples.current ?? [], step.keys);
      samples.current = null;
      setRanging(null);
      if (!peak) return toast('顔を読み取れませんでした。カメラに顔が映っているか確かめてください', 'error');
      update((s) => {
        s.camera.ranges = { ...s.camera.ranges, ...peak };
        // 本人の表情の大きさに合わせたので、出やすさは標準に戻す
        s.camera.sensitivity = 1;
      });
      toast(`「${step.label}」を覚えました`);
    }, RANGE_MS);
  };

  const choose = async (name: string | null) => {
    try {
      await api.post('/api/expression', { name });
      setChosen(name);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const reading = msg?.ok === true;
  const status = !c.enabled
    ? null
    : reading
      ? `読み取っています（${msg.fps ?? '-'} 回/秒）`
      : (msg?.status ?? (info?.isApp ? '読み取りを待っています…（しばらく待っても変わらなければ「カメラの映像を表示」を押してください）' : '「カメラの映像を表示」を押して、読み取りページを開いたままにしてください'));

  return (
    <div class="page">
      <h1>カメラ</h1>

      <div class="grid-2 images-top">
        <Card title="プレビュー" desc="カメラで読み取った顔の向き・視線・表情が、ここと OBS の表示に反映されます">
          <Preview height={320} />
        </Card>

        <Card title="カメラで顔を読み取る" desc="顔の向き・視線・目・眉・口の表情を読み取って、キャラクターに反映します。映像はこの PC の中だけで処理し、どこにも送りません。パーツで動かす素材で使えます">
          <Row label="カメラを使う" hint="口パクは今までどおり声で動かします（そのほうが速いため）">
            <Toggle checked={c.enabled} onChange={enable} />
          </Row>
          {status && <Notice kind={reading ? 'ok' : 'warn'}>{status}</Notice>}
          <Row label="カメラ" hint={cameras.length === 0 ? '名前は、一度カメラを使うと選べるようになります' : undefined}>
            <Select
              value={c.device ?? ''}
              options={[{ value: '', label: '既定のカメラ' }, ...[...new Set([...cameras, ...(c.device ? [c.device] : [])])].map((n) => ({ value: n, label: n }))]}
              onChange={(v) => update((s) => void (s.camera.device = v || null))}
            />
          </Row>
          <Row label="鏡のように動かす" hint="自分が右に傾くと、画面のキャラクターも画面の右に傾く。切ると、向かい合った相手のように動く">
            <Toggle checked={c.mirror} onChange={(v) => update((s) => void (s.camera.mirror = v))} />
          </Row>
          <div class="actions">
            <Button onClick={showWindow}>カメラの映像を表示</Button>
          </div>
        </Card>
      </div>

      <Card
        title="基準を合わせる"
        desc="カメラの位置や顔つきは人によって違うので、「正面を向いた、ふつうの顔」を基準として覚えさせます。表情が勝手に出る・出にくいときも、まずこれを試してください"
        actions={
          c.neutral && (
            <Button small onClick={() => update((s) => void (s.camera.neutral = null))}>
              基準を消す
            </Button>
          )
        }
      >
        <div class="actions">
          <Button kind="primary" onClick={measureNeutral} disabled={!reading || measuring || ranging !== null}>
            {measuring ? '測っています…（そのまま動かないで）' : '正面を向いて、ふつうの顔で押す'}
          </Button>
          <span class="muted small">{c.neutral ? '基準を設定済みです' : 'まだ基準を設定していません'}</span>
        </div>
      </Card>

      <Card
        title="表情を覚えさせる"
        desc={
          <>
            表情の大きさは人によって違います。それぞれの表情を実際にして覚えさせると、<b>自分の表情の大きさに合わせて</b>切り替わるようになります（表情が出ない・勝手に出るときに効きます）。
            先に「基準を合わせる」を済ませてから、ボタンを押して <b>2 秒ほどその表情を保って</b>ください。全部やる必要はなく、使いたい表情だけで構いません。
          </>
        }
        actions={
          c.ranges && (
            <Button small onClick={() => update((s) => void (s.camera.ranges = null))}>
              覚えた表情を消す
            </Button>
          )
        }
      >
        <div class="expr-list">
          {RANGE_STEPS.map((step) => {
            const done = step.keys.every((k) => c.ranges?.[k] !== undefined);
            return (
              <div class="expr-row" key={step.id}>
                <Button small kind={ranging === step.id ? 'primary' : 'default'} onClick={() => measureRange(step)} disabled={!reading || measuring || ranging !== null}>
                  {ranging === step.id ? 'その表情のまま…' : step.label}
                </Button>
                <span class={`small ${done ? '' : 'muted'}`}>{done ? '✓ 覚えました' : 'まだ'}</span>
                {step.hint && <span class="muted small">{step.hint}</span>}
              </div>
            );
          })}
        </div>
      </Card>

      <div class="grid-2">
        <Card
          title="読み取る項目と強さ"
          actions={
            <Button small onClick={() => api.post<{ settings: typeof settings }>('/api/settings/reset', { section: 'camera' }).then((r) => replace(r.settings))}>
              既定値に戻す
            </Button>
          }
        >
          <Row label="視線" hint="瞳を、見ている方向へ動かす">
            <Toggle checked={c.gaze} onChange={(v) => update((s) => void (s.camera.gaze = v))} />
          </Row>
          <Row label="目の開き具合・まばたき" hint="切ると、まばたきは自動になる">
            <Toggle checked={c.eyes} onChange={(v) => update((s) => void (s.camera.eyes = v))} />
          </Row>
          <Row label="眉・口の表情" hint="笑顔・驚き・困り・怒りなど">
            <Toggle checked={c.expressions} onChange={(v) => update((s) => void (s.camera.expressions = v))} />
          </Row>
          <Row label="表情の出やすさ" hint="大きいほど、小さな動きで表情が変わる。上げすぎると、読み取りの細かい揺れで表情がちらつきやすくなる（まず「表情を覚えさせる」を試す）">
            <Slider value={c.sensitivity} min={0.3} max={3} step={0.05} onInput={(v) => update((s) => void (s.camera.sensitivity = v))} format={(v) => `${v.toFixed(2)} 倍`} ends={['出にくい', '出やすい']} />
          </Row>
          <Row label="横を向く角度" hint="顔をこの角度まで向けると、キャラクターがいっぱいまで横を向く。小さいほど大きく動く">
            <Slider value={c.yawRange} min={10} max={60} step={1} onInput={(v) => update((s) => void (s.camera.yawRange = v))} format={(v) => `${v} °`} />
          </Row>
          <Row label="上下を向く角度">
            <Slider value={c.pitchRange} min={10} max={60} step={1} onInput={(v) => update((s) => void (s.camera.pitchRange = v))} format={(v) => `${v} °`} />
          </Row>
          <Row label="頭の傾きの大きさ">
            <Slider value={c.rollGain} min={0} max={2} step={0.05} onInput={(v) => update((s) => void (s.camera.rollGain = v))} format={(v) => `${v.toFixed(2)} 倍`} />
          </Row>
        </Card>

        <Card title="今の値" desc="読み取った値と、そこから決まった表情。表情が出ないときは、棒がどこまで伸びるかを見て「表情の出やすさ」を調整します">
          {!reading ? (
            <p class="muted">読み取っていません</p>
          ) : (
            <div class="face-values">
              <span>向き（左右）</span>
              <Bar value={msg.yaw} signed />
              <span>向き（上下）</span>
              <Bar value={msg.pitch} signed />
              <span>傾き</span>
              <Bar value={msg.roll} signed max={30} />
              {msg.gx !== undefined && (
                <>
                  <span>視線（左右）</span>
                  <Bar value={msg.gx} signed />
                </>
              )}
              {msg.eyeL !== undefined && (
                <>
                  <span>目の開き（左 / 右）</span>
                  <div class="face-pair">
                    <Bar value={msg.eyeL} max={2} />
                    <Bar value={msg.eyeR} max={2} />
                  </div>
                </>
              )}
              {msg.smile !== undefined && (
                <>
                  <span>眉（左 / 右）</span>
                  <div class="face-pair">
                    <Bar value={msg.browL} signed />
                    <Bar value={msg.browR} signed />
                  </div>
                  <span>眉の内側（困り）</span>
                  <Bar value={msg.browIn} />
                  <span>笑顔</span>
                  <Bar value={msg.smile} />
                  <span>への字口</span>
                  <Bar value={msg.frown} />
                  <span>口の開き</span>
                  <Bar value={msg.jaw} />
                  <span>口をすぼめる（う）</span>
                  <Bar value={msg.pucker} />
                  <span>口を横に引く（い）</span>
                  <Bar value={msg.stretch} />
                </>
              )}
            </div>
          )}
          {slots.length > 0 && (
            <p class="small face-slots">
              {slots.map(([k, v]) => (
                <span class="tag" key={k}>
                  {SLOT_LABELS[k] ?? k}: {v}
                </span>
              ))}
              {tracked?.mouthForm && <span class="tag">口の形: {tracked.mouthForm}</span>}
            </p>
          )}
        </Card>
      </div>

      <Card
        title="表情を切り替える"
        desc={
          <>
            カメラでは読み取れない表情（赤面・涙など）や、決まった表情を出したいときに使います。選んでいる間は、カメラの表情より優先されます。
            表情は素材の avatar.json の <code>rig.expressions</code> に書いたものです。
            {info?.isApp ? 'キーを割り当てると、ほかのアプリ（OBS やゲーム）を使っている間も切り替えられます（同じキーをもう一度押すと解除）。' : 'キーの割り当ては、アプリとして起動しているときに使えます。'}
          </>
        }
      >
        {expressions.length === 0 ? (
          <p class="muted">今の素材には表情（rig.expressions）がありません</p>
        ) : (
          <div class="expr-list">
            <div class="expr-row">
              <button class={`chip ${chosen === null ? 'on' : ''}`} onClick={() => choose(null)}>
                なし（カメラ・自動に任せる）
              </button>
            </div>
            {expressions.map((name) => (
              <div class="expr-row" key={name}>
                <button class={`chip ${chosen === name ? 'on' : ''}`} onClick={() => choose(chosen === name ? null : name)}>
                  {name}
                </button>
                <span class="muted small">{capturing === name ? 'キーを押してください（Esc でやめる）' : settings.hotkeys[name] ? hotkeyLabel(settings.hotkeys[name]) : 'キーなし'}</span>
                <Button small onClick={() => setCapturing(capturing === name ? null : name)}>
                  {capturing === name ? 'やめる' : 'キーを割り当てる'}
                </Button>
                {settings.hotkeys[name] && (
                  <Button small onClick={() => update((s) => void delete s.hotkeys[name])}>
                    外す
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
