import { STATE_LABELS, type Status } from '../api';
import { Card, LevelMeter, Notice, ms } from '../components';
import { useMeter, useSettings } from '../store';
import { Preview } from './Preview';

const STATE_ICON = { idle: '🙂', talk: '🗣️', away: '💭', sleep: '💤' } as const;

export function Home(props: { status: Status | null; go: (page: string) => void }) {
  const { settings, info } = useSettings();
  const meter = useMeter();
  const s = props.status;
  const lat = s?.latency;

  return (
    <div class="page">
      <h1>ホーム</h1>

      {info?.notices.map((n) => (
        <Notice kind="warn" key={n}>
          {n}
        </Notice>
      ))}
      {s?.inputError && (
        <Notice kind="error">
          マイクを開けません: {s.inputError}
          <br />
          <a onClick={() => props.go('mic')}>マイクの設定を開く →</a>
        </Notice>
      )}
      {info && !info.rendererBuilt && (
        <Notice kind="error">
          描画ページが見つかりません。<a onClick={() => props.go('maintenance')}>メンテナンスの「作り直す」</a>を実行してください。
        </Notice>
      )}

      <div class="grid-2">
        <Card title="いまの状態">
          <div class={`state-big state-${s?.state ?? 'idle'}`}>
            <span class="state-icon">{STATE_ICON[s?.state ?? 'idle']}</span>
            <div>
              <div class="state-label">{s ? (s.speaking ? '話しています' : STATE_LABELS[s.state]) : '接続中…'}</div>
              <div class="state-sub">
                {s?.silentSecs != null && `無言 ${s.silentSecs.toFixed(0)} 秒`}
                {s?.input && ` ・ ${s.input.name}`}
              </div>
            </div>
          </div>
          <LevelMeter db={meter.db} on={settings?.audio.onDb} off={settings?.audio.offDb} active={s?.speaking} />
          <div class="kv">
            <span>OBS の表示</span>
            <b class={s && s.clients > 0 ? 'good' : 'warn'}>{s ? (s.clients > 0 ? `${s.clients} 個つながっています` : 'つながっていません') : '―'}</b>
          </div>
          {s && s.clients === 0 && (
            <p class="hint">
              OBS にまだ追加していなければ、<a onClick={() => props.go('obs')}>OBS の設定</a>を見てください。
            </p>
          )}
        </Card>

        <Card title="表示の確認" desc="OBS に映るのと同じ絵です（背景の市松模様は透明の部分）">
          <Preview height={260} />
        </Card>
      </div>

      <Card title="反応の速さ" desc="声を出してから絵が切り替わるまで（このアプリを起動してからの実績）">
        <div class="stats">
          <div>
            <div class="stat-label">声 → 判定</div>
            <div class="stat-value">{ms(lat?.detect.count ? lat.detect.avg : null)}</div>
          </div>
          <div>
            <div class="stat-label">判定 → 画面</div>
            <div class="stat-value">{ms(lat?.display.count ? lat.display.avg : null)}</div>
          </div>
          <div>
            <div class="stat-label">合計</div>
            <div class="stat-value accent">{ms(lat?.total.count ? lat.total.avg : null)}</div>
          </div>
          <div>
            <div class="stat-label">回数</div>
            <div class="stat-value">{lat?.total.count ?? 0}</div>
          </div>
        </div>
        <p class="hint">
          OBS の映像合成・マイクのフィルタの時間は含みません。録画での実測は <a onClick={() => props.go('obs')}>OBS の「ずれの測定」</a> でできます。
        </p>
      </Card>
    </div>
  );
}
