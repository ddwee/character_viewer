// 設定画面の部品。

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { errorText, toast } from './store';

export function Card(props: { title?: ComponentChildren; desc?: ComponentChildren; actions?: ComponentChildren; children?: ComponentChildren; class?: string }) {
  return (
    <section class={`card ${props.class ?? ''}`}>
      {(props.title || props.actions) && (
        <header class="card-head">
          <div>
            {props.title && <h2>{props.title}</h2>}
            {props.desc && <p class="desc">{props.desc}</p>}
          </div>
          {props.actions && <div class="card-actions">{props.actions}</div>}
        </header>
      )}
      {props.children}
    </section>
  );
}

export function Button(props: {
  onClick?: () => unknown;
  kind?: 'primary' | 'danger' | 'ghost' | 'default';
  disabled?: boolean;
  title?: string;
  children: ComponentChildren;
  small?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const click = async () => {
    if (!props.onClick || busy) return;
    const r = props.onClick();
    if (r instanceof Promise) {
      setBusy(true);
      try {
        await r;
      } catch (e) {
        toast(errorText(e), 'error');
      } finally {
        setBusy(false);
      }
    }
  };
  return (
    <button
      type="button"
      class={`btn ${props.kind ?? 'default'} ${props.small ? 'small' : ''}`}
      disabled={props.disabled || busy}
      title={props.title}
      onClick={click}
    >
      {busy && <span class="spinner" />}
      {props.children}
    </button>
  );
}

/** 説明つきの 1 行 */
export function Row(props: { label: ComponentChildren; hint?: ComponentChildren; children: ComponentChildren }) {
  return (
    <div class="row">
      <div class="row-label">
        <div class="label">{props.label}</div>
        {props.hint && <div class="hint">{props.hint}</div>}
      </div>
      <div class="row-control">{props.children}</div>
    </div>
  );
}

export function Slider(props: {
  value: number;
  min: number;
  max: number;
  step: number;
  onInput: (v: number) => void;
  format?: (v: number) => string;
  /** 目盛りの左右の言葉（例: 敏感 / 鈍感） */
  ends?: [string, string];
  disabled?: boolean;
}) {
  return (
    <div class="slider">
      <div class="slider-line">
        <input
          type="range"
          min={props.min}
          max={props.max}
          step={props.step}
          value={props.value}
          disabled={props.disabled}
          onInput={(e) => props.onInput(Number((e.target as HTMLInputElement).value))}
        />
        <output>{props.format ? props.format(props.value) : props.value}</output>
      </div>
      {props.ends && (
        <div class="slider-ends">
          <span>{props.ends[0]}</span>
          <span>{props.ends[1]}</span>
        </div>
      )}
    </div>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <label class={`toggle ${props.disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)} />
      <span class="track">
        <span class="thumb" />
      </span>
      {props.label && <span>{props.label}</span>}
    </label>
  );
}

export function Select<T extends string | number>(props: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <select
      value={String(props.value)}
      disabled={props.disabled}
      onChange={(e) => {
        const raw = (e.target as HTMLSelectElement).value;
        const found = props.options.find((o) => String(o.value) === raw);
        if (found) props.onChange(found.value);
      }}
    >
      {props.options.map((o) => (
        <option value={String(o.value)} key={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export const METER_MIN = -70;
const pct = (db: number) => `${Math.max(0, Math.min(100, ((db - METER_MIN) / -METER_MIN) * 100))}%`;

/** 音量メーター。話し始め（on）・話し終わり（off）のしきい値の位置を示す */
export function LevelMeter(props: { db: number; on?: number; off?: number; active?: boolean; tall?: boolean }) {
  // 表示を滑らかに（下がるときはゆっくり）
  const [shown, setShown] = useState(props.db);
  const target = useRef(props.db);
  target.current = props.db;
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let v = shown;
    const step = (t: number) => {
      const dt = (t - last) / 1000;
      last = t;
      v = target.current > v ? target.current : v + (target.current - v) * Math.min(1, dt * 8);
      setShown(v);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div class={`meter ${props.tall ? 'tall' : ''} ${props.active ? 'active' : ''}`}>
      <div class="meter-fill" style={{ width: pct(shown) }} />
      {props.off !== undefined && <div class="meter-mark off" style={{ left: pct(props.off) }} title="話し終わりの音量" />}
      {props.on !== undefined && <div class="meter-mark on" style={{ left: pct(props.on) }} title="話し始めの音量" />}
      <div class="meter-scale">
        {[-60, -50, -40, -30, -20, -10].map((d) => (
          <span style={{ left: pct(d) }} key={d}>
            {d}
          </span>
        ))}
      </div>
    </div>
  );
}

/** クリップボードにコピーできる文字列 */
export function CopyField(props: { value: string; label?: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.value);
      toast('コピーしました');
    } catch {
      toast('コピーできませんでした。手で選択してコピーしてください', 'error');
    }
  };
  return (
    <div class="copy-field">
      <input readOnly value={props.value} onFocus={(e) => (e.target as HTMLInputElement).select()} />
      <Button small onClick={copy}>
        {props.label ?? 'コピー'}
      </Button>
    </div>
  );
}

/** ファイルを落とす・選ぶ枠 */
export function DropZone(props: { onFile: (f: File) => Promise<void>; accept?: string; children: ComponentChildren; class?: string }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const take = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      await props.onFile(f);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    take(e.dataTransfer?.files[0]);
  };
  return (
    <div
      class={`drop ${over ? 'over' : ''} ${busy ? 'busy' : ''} ${props.class ?? ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      onClick={() => input.current?.click()}
      role="button"
      tabIndex={0}
    >
      {props.children}
      {busy && <div class="drop-busy">保存しています…</div>}
      <input
        ref={input}
        type="file"
        accept={props.accept}
        hidden
        onChange={(e) => {
          const el = e.target as HTMLInputElement;
          take(el.files?.[0]);
          el.value = '';
        }}
      />
    </div>
  );
}

export function Notice(props: { kind?: 'info' | 'warn' | 'error' | 'ok'; children: ComponentChildren }) {
  return <div class={`notice ${props.kind ?? 'info'}`}>{props.children}</div>;
}

export function Modal(props: { title: string; onClose?: () => void; children: ComponentChildren; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose?.();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [props.onClose]);
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && props.onClose?.()}>
      <div class={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-label={props.title}>
        <header>
          <h2>{props.title}</h2>
          {props.onClose && (
            <button class="close" onClick={props.onClose} aria-label="閉じる">
              ×
            </button>
          )}
        </header>
        <div class="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

export function ms(v: number | null | undefined): string {
  return v == null ? '―' : `${v.toFixed(1)} ms`;
}
