import { useRef } from 'preact/hooks';

import type { AvatarState } from '../api';

/** 描画ページをそのまま埋め込んだプレビュー。ボタンで状態を試せる（OBS の表示には影響しない） */
export function Preview(props: { height: number; controls?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const send = (msg: { type: 'preview-state'; state: AvatarState } | { type: 'preview-blink' }) => frame.current?.contentWindow?.postMessage(msg, location.origin);
  return (
    <div class="preview">
      <iframe ref={frame} src="/?embed&checker" style={{ height: `${props.height}px` }} title="プレビュー" />
      {props.controls && (
        <div class="preview-buttons">
          {(['idle', 'talk', 'away', 'sleep'] as const).map((s) => (
            <button class="btn small" onClick={() => send({ type: 'preview-state', state: s })} key={s}>
              {{ idle: '待機', talk: '発話', away: '放置', sleep: '寝落ち' }[s]}
            </button>
          ))}
          <button class="btn small" onClick={() => send({ type: 'preview-blink' })}>
            まばたき
          </button>
        </div>
      )}
    </div>
  );
}
