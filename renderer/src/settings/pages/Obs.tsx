import { useEffect, useState } from 'preact/hooks';

import { api, runJob, type AvatarView } from '../api';
import { Button, Card, CopyField, Notice, Row } from '../components';
import { errorText, toast, useSettings } from '../store';

interface Recording {
  path: string;
  name: string;
  sizeMb: number;
  minutesAgo: number;
}

interface MeasureResult {
  file: string;
  fps: number;
  count: number;
  unmatched: number;
  medianMs: number;
  p10Ms: number;
  p90Ms: number;
  offsets: number[];
  advice: { level: 'ok' | 'adjust' | 'warn'; verdict: string; details: string[] };
}

function ago(min: number): string {
  if (min < 1) return 'たった今';
  if (min < 60) return `${Math.round(min)} 分前`;
  if (min < 60 * 24) return `${Math.round(min / 60)} 時間前`;
  return `${Math.round(min / 60 / 24)} 日前`;
}

export function Obs() {
  const { info, settings, update, reloadInfo } = useSettings();
  const [size, setSize] = useState<string | null>(null);
  const [recs, setRecs] = useState<Recording[] | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<MeasureResult | null>(null);
  const [track, setTrack] = useState(1);
  const [manual, setManual] = useState('');

  // 待機の絵の大きさ（ブラウザソースの幅・高さの目安）
  useEffect(() => {
    api.get<AvatarView>('/api/avatar').then((v) => {
      const file = v.states.find((s) => s.state === 'idle')?.slots[0].file;
      if (!file) return;
      const img = new Image();
      img.onload = () => setSize(`${img.naturalWidth} × ${img.naturalHeight}`);
      img.src = `/avatar/${encodeURI(file)}?t=${Date.now()}`;
    });
  }, []);
  const loadRecs = () => api.get<Recording[]>('/api/recordings').then(setRecs).catch((e) => toast(errorText(e), 'error'));
  useEffect(() => {
    loadRecs();
  }, []);

  const measure = async (path: string) => {
    setResult(null);
    setProgress('読み込んでいます');
    try {
      setResult(await runJob<MeasureResult>('/api/measure', { path, track }, setProgress));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setProgress(null);
    }
  };

  if (!info || !settings) return null;
  const syncUrl = `${info.obsUrl}?sync`;

  return (
    <div class="page">
      <h1>OBS</h1>

      <Card title="OBS に絵を表示する" desc="初回だけ必要な手順です">
        <ol class="steps">
          <li>
            OBS の「ソース」の ＋ から <b>ブラウザ</b> を追加
          </li>
          <li>
            URL に次を貼り付ける
            <CopyField value={info.obsUrl} />
          </li>
          <li>
            幅・高さを絵の大きさにする{size && <>（今の待機の絵は <b>{size}</b>）</>}。あとから OBS 上で拡大縮小できます
          </li>
          <li>
            「<b>カスタムフレームレートを使用</b>」にチェックし、OBS の出力と同じ fps（例: 60）にする
          </li>
          <li>
            「表示されていないときにソースをシャットダウン」と「シーンがアクティブになったときにブラウザの表示を更新」は<b>オフ</b>
          </li>
        </ol>
      </Card>

      <Card title="OBS の中でこの設定画面を開く（任意）" desc="OBS のメニュー「ドック」→「カスタムブラウザドック」で、名前を付けて次の URL を追加します">
        <CopyField value={info.settingsUrl} />
      </Card>

      <Card
        title="声と絵のずれの測定"
        desc="OBS の録画から、視聴者が見る「声が出てから絵が変わるまで」を測ります。マイクのノイズ除去などの影響も含めた本当の値が分かります"
      >
        {!info.ffmpeg && (
          <Notice kind="warn">
            録画を読むために ffmpeg（無料）が必要です。
            <Button
              small
              kind="primary"
              onClick={async () => {
                await api.post('/api/maintenance/ffmpeg');
                toast('別のウィンドウでインストールを始めました。終わったら「状態を更新」を押してください', 'info');
              }}
            >
              ffmpeg をインストール
            </Button>
            <Button small onClick={reloadInfo}>
              状態を更新
            </Button>
          </Notice>
        )}
        <ol class="steps">
          <li>
            OBS にブラウザソースをもう 1 つ追加し、URL に次を入れる（200×200 で、画面の端に）
            <CopyField value={syncUrl} />
          </li>
          <li>ゲーム音などを止めて録画を開始する</li>
          <li>「あっ」「たっ」と短く区切り、1 秒以上あけながら 15〜20 回声を出す</li>
          <li>録画を止め、下の一覧から選んで「測る」</li>
          <li>終わったら測定用のブラウザソースは削除する</li>
        </ol>

        <div class="list-head">
          <b>最近の録画</b>
          <span>
            音声トラック
            <select value={track} onChange={(e) => setTrack(Number((e.target as HTMLSelectElement).value))}>
              {[1, 2, 3, 4, 5, 6].map((t) => (
                <option value={t} key={t}>
                  {t}
                </option>
              ))}
            </select>
            <Button small onClick={loadRecs}>
              一覧を更新
            </Button>
          </span>
        </div>
        <div class="file-list">
          {recs?.length === 0 && <p class="muted">録画が見つかりません（OBS の録画フォルダを探しています）</p>}
          {recs?.map((r) => (
            <div class="file-row" key={r.path}>
              <div>
                <div>{r.name}</div>
                <div class="muted small">
                  {ago(r.minutesAgo)} ・ {r.sizeMb.toFixed(0)} MB
                </div>
              </div>
              <Button small kind="primary" disabled={!!progress || !info.ffmpeg} onClick={() => measure(r.path)}>
                測る
              </Button>
            </div>
          ))}
        </div>
        <Row label="ほかのファイル" hint="ファイルのパスを貼り付け">
          <div class="copy-field">
            <input value={manual} onInput={(e) => setManual((e.target as HTMLInputElement).value)} placeholder="C:\video editing\録画.mp4" />
            <Button small disabled={!manual || !!progress || !info.ffmpeg} onClick={() => measure(manual.trim().replace(/^"|"$/g, ''))}>
              測る
            </Button>
          </div>
        </Row>

        {progress && (
          <Notice kind="info">
            <span class="spinner" /> {progress}…
          </Notice>
        )}
        {result && (
          <div class={`result ${result.advice.level}`}>
            <div class="result-big">
              {result.medianMs >= 0 ? '絵が' : '絵が'} <b>{Math.abs(result.medianMs).toFixed(0)} ms</b> {result.medianMs >= 0 ? '遅れています' : '早く出ています'}
            </div>
            <p>{result.advice.verdict}</p>
            <ul>
              {result.advice.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
            <div class="muted small">
              測定 {result.count} 回（声が見つからなかった切り替え {result.unmatched} 回）・ 10〜90% の範囲 {result.p10Ms.toFixed(0)}〜{result.p90Ms.toFixed(0)} ms ・ 映像{' '}
              {result.fps.toFixed(0)} fps
            </div>
          </div>
        )}
      </Card>

      <Card title="ポート" desc="ほかのアプリと番号がぶつかるときだけ変えます。変更はアプリの再起動後に反映され、OBS の URL も変わります">
        <Row label="ポート番号">
          <input
            type="number"
            min={1024}
            max={65535}
            value={settings.server.port}
            onChange={(e) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (v >= 1024 && v <= 65535) update((s) => void (s.server.port = v));
            }}
          />
        </Row>
      </Card>
    </div>
  );
}
