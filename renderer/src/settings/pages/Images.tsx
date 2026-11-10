import { useEffect, useState } from 'preact/hooks';

import { api, type AvatarView, type Settings } from '../api';
import { Button, Card, DropZone, Notice, Row, Slider, Toggle } from '../components';
import { errorText, toast, useSettings } from '../store';
import { Preview } from './Preview';

const SLOT_HINT = { image: '目を開けた絵', half: 'なくても可', closed: 'まばたき用' } as const;
const STATE_HINT = {
  idle: '喋っていないとき（必須）',
  talk: '喋っているとき。なければ待機の絵',
  away: 'しばらく無言のとき。なければ待機の絵',
  sleep: '長く無言のとき。なければ放置の絵',
} as const;

export function Images() {
  const { settings, update, replace, info, reloadInfo } = useSettings();
  const [view, setView] = useState<AvatarView | null>(null);
  const [stamp, setStamp] = useState(Date.now());
  const [dirInput, setDirInput] = useState('');

  const load = async () => {
    try {
      setView(await api.get<AvatarView>('/api/avatar'));
      setStamp(Date.now());
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  useEffect(() => {
    load();
  }, [settings?.avatar.dir]);
  useEffect(() => setDirInput(settings?.avatar.dir ?? ''), [settings?.avatar.dir]);

  if (!settings) return null;
  const av = settings.avatar;
  const d = settings.display;

  const upload = async (state: string, slot: string, f: File) => {
    await api.upload(`/api/avatar/${state}/${slot}?name=${encodeURIComponent(f.name)}`, f);
    toast('画像を設定しました。OBS の表示にもすぐ反映されます');
    await load();
  };
  const clear = async (state: string, slot: string) => {
    await api.del(`/api/avatar/${state}/${slot}`);
    await load();
  };
  const setDir = (dir: string | null) => {
    update((s) => void (s.avatar.dir = dir));
    setTimeout(reloadInfo, 800);
  };

  return (
    <div class="page">
      <h1>画像と動き</h1>

      <div class="grid-2 images-top">
        <Card title="プレビュー" desc="ボタンで各状態の見え方を試せます（OBS の表示には影響しません）">
          <Preview height={300} controls />
        </Card>
        <Card title="動き">
          <Row label="まばたき" hint="「閉じ目」の絵がある状態でまばたきします">
            <Toggle checked={d.blink} onChange={(v) => update((s) => void (s.display.blink = v))} />
          </Row>
          <Row label="まばたきの頻度" hint="間隔は毎回ランダムで、喋っているときは少し増えます">
            <Slider
              value={d.blinkRate}
              min={0.5}
              max={2}
              step={0.1}
              disabled={!d.blink}
              onInput={(v) => update((s) => void (s.display.blinkRate = Math.round(v * 10) / 10))}
              format={(v) => (v === 1 ? '標準' : `${v.toFixed(1)} 倍`)}
              ends={['少なめ', '多め']}
            />
          </Row>
          <Row label="左右反転">
            <Toggle checked={d.mirror} onChange={(v) => update((s) => void (s.display.mirror = v))} />
          </Row>
          <Row label="「放置」になるまで" hint="無言がこの秒数続いたら">
            <Slider
              value={av.awaySecs}
              min={0}
              max={120}
              step={1}
              onInput={(v) =>
                update((s) => {
                  s.avatar.awaySecs = v;
                  if (v > 0 && s.avatar.sleepSecs > 0 && s.avatar.sleepSecs <= v) s.avatar.sleepSecs = v + 1;
                })
              }
              format={(v) => (v === 0 ? 'ならない' : `${v} 秒`)}
            />
          </Row>
          <Row label="「寝落ち」になるまで" hint="無言の開始から数えた秒数">
            <Slider
              value={av.sleepSecs}
              min={0}
              max={600}
              step={1}
              onInput={(v) => update((s) => void (s.avatar.sleepSecs = v === 0 ? 0 : Math.max(v, s.avatar.awaySecs + 1)))}
              format={(v) => (v === 0 ? 'ならない' : v >= 60 ? `${Math.floor(v / 60)} 分 ${v % 60} 秒` : `${v} 秒`)}
            />
          </Row>
        </Card>
      </div>

      <Card
        title="絵"
        desc={
          <>
            枠をクリックするか、画像をドラッグ＆ドロップして設定します。<b>すべての絵を同じキャンバスサイズ・同じ位置</b>で書き出してください（Krita なら差分のレイヤーだけ切り替えて書き出す）。
          </>
        }
      >
        {view?.error && <Notice kind="error">{view.error}</Notice>}
        {view?.rig && (
          <Notice>
            この素材フォルダは<b>パーツを重ねてボーンで動かす</b>設定（avatar.json の rig）になっています。下の状態ごとの絵は使われません。
            パーツの画像を上書き保存すると自動で読み込み直します。回転の中心や動きの強さは<a href="#rig">パーツの調整</a>のページで変えられます。
          </Notice>
        )}
        <div class="state-grid">
          {view?.states.map((st) => (
            <div class="state-card" key={st.state}>
              <h3>
                {st.label} <span class="muted small">{STATE_HINT[st.state]}</span>
              </h3>
              <div class="slots">
                {st.slots.map((sl) => (
                  <div class="slot" key={sl.slot}>
                    <DropZone accept="image/png,image/webp,image/jpeg,image/svg+xml,image/avif,image/gif" onFile={(f) => upload(st.state, sl.slot, f)} class="checker">
                      {sl.file && !sl.missing ? (
                        <img src={`/avatar/${encodeURI(sl.file)}?t=${stamp}`} alt={`${st.label} ${sl.label}`} />
                      ) : (
                        <div class="drop-empty">
                          {sl.missing ? `見つかりません\n${sl.file}` : '＋'}
                          <div class="small">{SLOT_HINT[sl.slot]}</div>
                        </div>
                      )}
                    </DropZone>
                    <div class="slot-foot">
                      <span>{sl.label}</span>
                      {sl.file && !(st.state === 'idle' && sl.slot === 'image') && (
                        <button class="link" onClick={() => clear(st.state, sl.slot).catch((e) => toast(errorText(e), 'error'))}>
                          外す
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p class="hint">Krita などで同じファイル名のまま上書き保存しても、自動で読み込み直します。</p>
      </Card>

      <Card title="素材のフォルダ" desc="画像と avatar.json を置く場所">
        <Row label="いまの場所">
          <code class="path">{view?.dir ?? info?.avatarDir}</code>
          <Button small onClick={() => api.post('/api/maintenance/open', { target: 'avatar' })}>
            フォルダを開く
          </Button>
        </Row>
        <Row label="別のフォルダを使う" hint="フォルダのパスを貼り付けて「使う」。空なら既定（プロジェクトの avatar）">
          <div class="copy-field">
            <input value={dirInput} placeholder={info?.defaultAvatarDir} onInput={(e) => setDirInput((e.target as HTMLInputElement).value)} />
            <Button small onClick={() => setDir(dirInput.trim().replace(/^"|"$/g, '') || null)}>
              使う
            </Button>
            {av.dir && (
              <Button small onClick={() => setDir(null)}>
                既定に戻す
              </Button>
            )}
          </div>
        </Row>
      </Card>

      <ResetDisplay replace={replace} />
    </div>
  );
}

function ResetDisplay(props: { replace: (s: Settings) => void }) {
  const reset = async () => {
    const r = await api.post<{ settings: Settings }>('/api/settings/reset', { section: 'display' });
    props.replace(r.settings);
    const r2 = await api.post<{ settings: Settings }>('/api/settings/reset', { section: 'avatar' });
    props.replace(r2.settings);
    toast('動きの設定を初期値に戻しました');
  };
  return (
    <div class="page-foot">
      <Button small onClick={reset}>
        動きの設定を初期値に戻す
      </Button>
    </div>
  );
}
