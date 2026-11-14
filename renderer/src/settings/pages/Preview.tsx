import { useRef, useState } from 'preact/hooks';

import { api, STATE_LABELS, type AvatarState } from '../api';
import { Button } from '../components';
import { errorText, toast } from '../store';

type PreviewMsg = { type: 'preview-state'; state: AvatarState } | { type: 'preview-blink' } | { type: 'snapshot'; id: number };

let snapshotId = 0;

/** 埋め込んだ描画ページに、いまの絵の PNG を作ってもらう */
function requestSnapshot(win: Window): Promise<{ png: Blob; state: AvatarState }> {
  const id = ++snapshotId;
  return new Promise((resolve, reject) => {
    const done = () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
    };
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; id?: number; png?: Blob; state?: AvatarState; error?: string };
      if (e.origin !== location.origin || e.source !== win || m.type !== 'snapshot-result' || m.id !== id) return;
      done();
      if (m.png && m.state) resolve({ png: m.png, state: m.state });
      else reject(new Error(m.error ?? 'PNG を作れませんでした'));
    };
    // 大きな素材でも数秒で終わる。返事がなければプレビューがまだ読み込み中
    const timer = setTimeout(() => {
      done();
      reject(new Error('プレビューから返事がありません。少し待ってからもう一度押してください'));
    }, 20000);
    window.addEventListener('message', onMessage);
    win.postMessage({ type: 'snapshot', id } satisfies PreviewMsg, location.origin);
  });
}

/** 描画ページをそのまま埋め込んだプレビュー。ボタンで状態を試せる（OBS の表示には影響しない） */
export function Preview(props: { height: number; controls?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const send = (msg: PreviewMsg) => frame.current?.contentWindow?.postMessage(msg, location.origin);

  const save = async () => {
    const win = frame.current?.contentWindow;
    if (!win) return;
    const { png, state } = await requestSnapshot(win);
    const { path } = await api.upload<{ path: string }>(`/api/snapshot?state=${state}`, png);
    setSaved(path);
    toast(`${STATE_LABELS[state]}の絵を保存しました`);
  };

  return (
    <div class="preview">
      <iframe ref={frame} src="/?embed&checker" style={{ height: `${props.height}px` }} title="プレビュー" />
      <div class="preview-buttons">
        {props.controls && (
          <>
            {(['idle', 'talk', 'away', 'sleep'] as const).map((s) => (
              <button class="btn small" onClick={() => send({ type: 'preview-state', state: s })} key={s}>
                {STATE_LABELS[s]}
              </button>
            ))}
            <button class="btn small" onClick={() => send({ type: 'preview-blink' })}>
              まばたき
            </button>
          </>
        )}
        <span class="preview-save">
          <Button small onClick={save} title="いまの絵を、素材の解像度の透過 PNG で「ピクチャ」の character_viewer フォルダに保存します（サムネイル作りなどに）">
            📷 PNG で保存
          </Button>
        </span>
      </div>
      {saved && (
        <p class="hint preview-saved">
          保存しました: <code>{saved.split(/[\\/]/).pop()}</code>{' '}
          <a onClick={() => api.post('/api/maintenance/open', { target: 'snapshots' }).catch((e) => toast(errorText(e), 'error'))}>フォルダを開く</a>
        </p>
      )}
    </div>
  );
}
