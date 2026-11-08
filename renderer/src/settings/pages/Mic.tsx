import { useEffect, useState } from 'preact/hooks';

import { api, type CalOption, type Device, type Settings, type Status } from '../api';
import { Button, Card, LevelMeter, Modal, Notice, Row, Select, Slider } from '../components';
import { errorText, toast, useMeter, useSettings } from '../store';

export function Mic(props: { status: Status | null }) {
  const { settings, update, replace } = useSettings();
  const meter = useMeter();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [calOpen, setCalOpen] = useState(false);
  const [linkOff, setLinkOff] = useState(true);

  const loadDevices = async () => {
    try {
      setDevices(await api.get<Device[]>('/api/devices'));
      setDeviceError(null);
    } catch (e) {
      setDeviceError(errorText(e));
    }
  };
  useEffect(() => {
    loadDevices();
  }, []);
  // 開いている途中でキャリブレーションが動いていたら（別の画面から始めた等）表示する
  useEffect(() => {
    if (props.status?.calibration) setCalOpen(true);
  }, [props.status?.calibration != null]);

  if (!settings) return null;
  const a = settings.audio;
  const selected = devices?.find((d) => (a.device ? d.name === a.device : d.isDefault));
  const channels = selected?.channels ?? Math.max(a.channel, 2);

  const setOn = (v: number) =>
    update((s) => {
      const gap = s.audio.onDb - s.audio.offDb;
      s.audio.onDb = v;
      s.audio.offDb = linkOff ? v - gap : Math.min(s.audio.offDb, v);
    });

  return (
    <div class="page">
      <h1>マイク</h1>
      {props.status?.inputError && <Notice kind="error">マイクを開けません: {props.status.inputError}</Notice>}

      <Card
        title="使うマイク"
        desc="OBS で使っているのと同じマイク（オーディオインターフェース）を選びます"
        actions={
          <Button small onClick={loadDevices}>
            一覧を更新
          </Button>
        }
      >
        {deviceError && <Notice kind="error">{deviceError}</Notice>}
        <Row label="デバイス">
          <Select
            value={a.device ?? ''}
            options={[
              { value: '', label: `Windows の既定のマイク${devices?.find((d) => d.isDefault) ? `（${devices.find((d) => d.isDefault)!.name}）` : ''}` },
              ...(devices ?? []).map((d) => ({ value: d.name, label: d.name })),
              ...(a.device && devices && !devices.some((d) => d.name === a.device) ? [{ value: a.device, label: `${a.device}（見つかりません）` }] : []),
            ]}
            onChange={(v) => update((s) => void (s.audio.device = v || null))}
          />
        </Row>
        <Row label="チャンネル" hint="マイクをつないだ入力端子の番号（オーディオインターフェースの 1 番なら 1）">
          <Select
            value={a.channel}
            options={Array.from({ length: channels }, (_, i) => ({ value: i + 1, label: `${i + 1}` }))}
            onChange={(v) => update((s) => void (s.audio.channel = v))}
          />
        </Row>
        {props.status?.input && (
          <p class="hint">
            {props.status.input.sampleRate.toLocaleString()} Hz / {props.status.input.channels}ch / 取り込み間隔 {((props.status.input.bufferFrames / props.status.input.sampleRate) * 1000).toFixed(1)} ms
          </p>
        )}
      </Card>

      <Card
        title="反応のしかた"
        desc="話しかけながら調整できます。メーターの緑の線を超えると「話している」になります"
        actions={
          <>
            <Button small onClick={() => api.post<{ settings: Settings }>('/api/settings/reset', { section: 'audio' }).then((r) => replace(r.settings))}>
              初期値に戻す
            </Button>
            <Button small kind="primary" onClick={() => setCalOpen(true)}>
              自動で調整する
            </Button>
          </>
        }
      >
        <div class="meter-block">
          <LevelMeter db={meter.db} on={a.onDb} off={a.offDb} active={props.status?.speaking} tall />
          <div class="meter-legend">
            <span class="dot on" /> 話し始め <span class="dot off" /> 話し終わり
            <span class={`voice-chip ${meter.voiced ? 'on' : ''}`}>声らしさ {meter.voicing.toFixed(2)}</span>
            <span class={`talk-chip ${props.status?.speaking ? 'on' : ''}`}>{props.status?.speaking ? '話しています' : '静か'}</span>
          </div>
        </div>

        <Row label="話し始めの音量" hint="これより大きい声で「話している」になります。小さくすると小声にも反応します">
          <Slider value={a.onDb} min={-70} max={-10} step={1} onInput={setOn} format={(v) => `${v} dB`} ends={['小声にも反応', '大きい声だけ']} />
        </Row>
        <Row label="話し終わりの音量" hint="これより小さくなると「話し終わり」とみなします">
          <Slider
            value={a.offDb}
            min={-80}
            max={a.onDb}
            step={1}
            onInput={(v) => update((s) => void (s.audio.offDb = v))}
            format={(v) => `${v} dB`}
          />
          <label class="check">
            <input type="checkbox" checked={linkOff} onChange={(e) => setLinkOff((e.target as HTMLInputElement).checked)} /> 話し始めと一緒に動かす
          </label>
        </Row>
        <Row label="声らしさ" hint="息・キーボードの音など「声ではない音」に反応しないための基準。0 にすると音量だけで判定します">
          <Slider
            value={a.voicing}
            min={0}
            max={0.95}
            step={0.05}
            onInput={(v) => update((s) => void (s.audio.voicing = Math.round(v * 100) / 100))}
            format={(v) => (v === 0 ? '使わない' : v.toFixed(2))}
            ends={['なんでも反応', '声だけに厳しく']}
          />
        </Row>
        <details class="advanced">
          <summary>細かい設定</summary>
          <Row label="話し終わりまでの待ち時間" hint="言葉の切れ目で口が閉じすぎるときは長く">
            <Slider value={a.holdMs} min={50} max={1000} step={10} onInput={(v) => update((s) => void (s.audio.holdMs = v))} format={(v) => `${v} ms`} />
          </Row>
          <Row label="低い雑音のカット" hint="エアコン・振動などの低い音を除きます（0 で無効）">
            <Slider value={a.hpfHz} min={0} max={300} step={10} onInput={(v) => update((s) => void (s.audio.hpfHz = v))} format={(v) => (v === 0 ? '無効' : `${v} Hz`)} />
          </Row>
        </details>
      </Card>

      {calOpen && <Calibration status={props.status} onClose={() => setCalOpen(false)} />}
    </div>
  );
}

function Calibration(props: { status: Status | null; onClose: () => void }) {
  const { update, flush } = useSettings();
  const cal = props.status?.calibration ?? null;

  const close = async () => {
    await api.post('/api/calibration/cancel');
    props.onClose();
  };
  const apply = async (o: CalOption) => {
    update((s) => {
      s.audio.onDb = o.onDb;
      s.audio.offDb = o.offDb;
      s.audio.voicing = o.voicing;
    });
    await flush();
    await api.post('/api/calibration/cancel');
    toast(`「${o.name}」の設定にしました`);
    props.onClose();
  };

  if (!cal) {
    return (
      <Modal title="自動で調整する（キャリブレーション）" onClose={props.onClose}>
        <p>約 40 秒、画面の指示どおりに音を出してもらい、息やキーボードの音には反応せず、声にはしっかり反応する設定を探します。</p>
        <ol class="steps">
          <li>何もせず静かにする（6 秒）</li>
          <li>息を吸ったり吐いたりする（8 秒）</li>
          <li>キーボードをタイプする（8 秒）</li>
          <li>小声で話す（8 秒）</li>
          <li>普段の声で話す（8 秒）</li>
        </ol>
        <p class="hint">録音中は OBS の絵は切り替わりません。録音はこの PC の中だけに保存されます。</p>
        <div class="modal-actions">
          <Button onClick={props.onClose}>やめる</Button>
          <Button kind="primary" onClick={() => api.post('/api/calibration/start')}>
            始める
          </Button>
        </div>
      </Modal>
    );
  }

  if (cal.phase === 'error') {
    return (
      <Modal title="キャリブレーション" onClose={close}>
        <Notice kind="error">{cal.error}</Notice>
        <div class="modal-actions">
          <Button onClick={close}>閉じる</Button>
          <Button kind="primary" onClick={() => api.post('/api/calibration/start')}>
            もう一度
          </Button>
        </div>
      </Modal>
    );
  }

  if (cal.phase === 'done' && cal.result) {
    return (
      <Modal title="調整の結果" onClose={close} wide>
        <p>どちらかを選んでください。声が小さめなら「小声にも反応」がおすすめです。</p>
        <div class="grid-2">
          {cal.result.options.map((o) => (
            <div class="option" key={o.name}>
              <h3>{o.name.replace(/^[AB]: /, '')}</h3>
              <div class="option-values">
                話し始め {o.onDb} dB ・ 話し終わり {o.offDb} dB ・ 声らしさ {o.voicing ? o.voicing.toFixed(2) : '使わない'}
              </div>
              {o.note && <Notice kind="warn">{o.note}</Notice>}
              <table class="results">
                <tbody>
                  {o.segments.map((s) => (
                    <tr key={s.label}>
                      <td>{s.label}</td>
                      <td>{s.target ? '反応してほしい' : '反応しないでほしい'}</td>
                      <td class={s.reacted === s.target ? 'good' : 'bad'}>
                        {s.reacted === s.target ? '◎' : s.target ? '× 反応しない' : `× ${Math.max(1, s.starts)} 回反応`}
                        {s.recall != null && <span class="muted"> 声の {s.recall.toFixed(0)}%</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Button kind="primary" onClick={() => apply(o)}>
                この設定にする
              </Button>
            </div>
          ))}
        </div>
        <div class="modal-actions">
          <Button onClick={close}>どちらも使わない</Button>
          <Button onClick={() => api.post('/api/calibration/start')}>やり直す</Button>
        </div>
      </Modal>
    );
  }

  const seg = cal.segments[cal.segment];
  return (
    <Modal title="キャリブレーション中" onClose={close}>
      {cal.phase === 'countdown' && (
        <div class="cal-big">
          <div class="cal-count">{Math.ceil(cal.remainingSecs)}</div>
          <div>まもなく始まります。まずは静かにしていてください</div>
        </div>
      )}
      {cal.phase === 'recording' && seg && (
        <div class="cal-big">
          <div class="cal-step">
            {cal.segment + 1} / {cal.segments.length} ・ {seg.label}
          </div>
          <div class="cal-prompt">{seg.prompt}</div>
          <div class="cal-remain">あと {Math.ceil(cal.remainingSecs)} 秒</div>
        </div>
      )}
      {cal.phase === 'analyzing' && (
        <div class="cal-big">
          <span class="spinner big" />
          <div>解析しています（数秒）…</div>
        </div>
      )}
      <LevelMeter db={cal.levelDb} tall />
      <div class="progress">
        <div style={{ width: `${(cal.progress * 100).toFixed(1)}%` }} />
      </div>
      <div class="modal-actions">
        <Button onClick={close}>中止する</Button>
      </div>
    </Modal>
  );
}
