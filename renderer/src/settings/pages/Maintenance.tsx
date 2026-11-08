import { useEffect, useRef, useState } from 'preact/hooks';

import { api, runJob, type LogLine } from '../api';
import { Button, Card, Modal, Notice, Row, Toggle } from '../components';
import { errorText, toast, useSettings } from '../store';

interface Versions {
  app: string;
  commit: string | null;
  branch: string | null;
  dirty: boolean;
  pinnedRust: string | null;
  tools: { name: string; role: string; version: string | null; path: string | null }[];
  packages: { name: string; kind: string; version: string }[];
  hasBackup: boolean;
}

interface UpdateCheck {
  git: { upstream: string | null; behind: number; ahead: number; dirty: boolean };
  rust: { current: string | null; latest: string | null; available: boolean };
  packages: { name: string; kind: string; current: string; wanted: string; latest: string }[];
  errors: string[];
}

export function Maintenance() {
  const { info } = useSettings();
  const [versions, setVersions] = useState<Versions | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | 'update' | 'rebuild' | 'rollback'>(null);
  const [opts, setOpts] = useState({ git: true, rust: true, deps: true });
  const [autostart, setAutostart] = useState<{ available: boolean; enabled: boolean } | null>(null);

  const loadVersions = async () => setVersions(await runJob<Versions>('/api/maintenance/versions', {}));
  useEffect(() => {
    loadVersions().catch((e) => toast(errorText(e), 'error'));
    api.get<{ available: boolean; enabled: boolean }>('/api/maintenance/autostart').then(setAutostart);
  }, []);

  const doCheck = async () => {
    setChecking('確認しています');
    try {
      const c = await runJob<UpdateCheck>('/api/maintenance/check', {}, setChecking);
      setCheck(c);
      const wantDeps = c.packages.some((p) => p.current !== p.wanted);
      setOpts({ git: c.git.behind > 0 && !c.git.dirty, rust: c.rust.available, deps: wantDeps });
    } finally {
      setChecking(null);
    }
  };

  const tool = (name: string) => versions?.tools.find((t) => t.name === name);
  const anyUpdate = check && (check.git.behind > 0 || check.rust.available || check.packages.some((p) => p.current !== p.wanted));

  return (
    <div class="page">
      <h1>メンテナンス</h1>

      <Card
        title="更新"
        desc="プロジェクト（GitHub の最新版）・Rust・部品をまとめて更新します。新しい版でビルドとテストが通ったときだけ入れ替えるので、うまくいかなくても今の版のまま動き続けます"
        actions={
          <Button kind="primary" onClick={doCheck} disabled={!!checking}>
            更新を確認
          </Button>
        }
      >
        {checking && (
          <Notice>
            <span class="spinner" /> {checking}…（ネットワークの状況により 1 分ほどかかります）
          </Notice>
        )}
        {check && (
          <>
            {check.errors.map((e) => (
              <Notice kind="warn" key={e}>
                {e}
              </Notice>
            ))}
            <div class="update-list">
              <UpdateItem
                label="プロジェクト（GitHub）"
                checked={opts.git}
                onChange={(v) => setOpts({ ...opts, git: v })}
                available={check.git.behind > 0}
                disabled={check.git.dirty}
                text={
                  check.git.dirty
                    ? '手元で変更したファイルがあるため、自動では更新しません'
                    : !check.git.upstream
                      ? 'GitHub の追跡先が設定されていません'
                      : check.git.behind > 0
                        ? `新しい変更が ${check.git.behind} 件あります`
                        : '最新です'
                }
              />
              <UpdateItem
                label="Rust"
                checked={opts.rust}
                onChange={(v) => setOpts({ ...opts, rust: v })}
                available={check.rust.available}
                text={check.rust.available ? `${check.rust.current} → ${check.rust.latest}` : `最新です（${check.rust.current ?? '不明'}）`}
              />
              <UpdateItem
                label="部品（Rust・npm）"
                checked={opts.deps}
                onChange={(v) => setOpts({ ...opts, deps: v })}
                available={check.packages.some((p) => p.current !== p.wanted)}
                text={
                  check.packages.length === 0 ? '最新です' : `互換性を保って上げられる部品が ${check.packages.filter((p) => p.current !== p.wanted).length} 個あります`
                }
              />
            </div>
            {check.packages.length > 0 && (
              <details class="advanced">
                <summary>部品の一覧</summary>
                <table class="table">
                  <thead>
                    <tr>
                      <th>部品</th>
                      <th>種類</th>
                      <th>今</th>
                      <th>更新後</th>
                      <th>最新</th>
                    </tr>
                  </thead>
                  <tbody>
                    {check.packages.map((p) => (
                      <tr key={p.kind + p.name}>
                        <td>{p.name}</td>
                        <td>{p.kind}</td>
                        <td>{p.current}</td>
                        <td>{p.wanted}</td>
                        <td class={p.latest !== p.wanted ? 'muted' : ''}>{p.latest}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p class="hint">「最新」が「更新後」と違う部品は大きな変更を含むため、自動では上げません（動かなくなるのを防ぐため）。</p>
              </details>
            )}
            <div class="actions">
              <Button kind="primary" disabled={!anyUpdate || !(opts.git || opts.rust || opts.deps)} onClick={() => setConfirm('update')}>
                選んだものを更新する
              </Button>
            </div>
          </>
        )}
      </Card>

      <div class="grid-2">
        <Card title="困ったとき">
          <Row label="PowerShell を開く" hint="エラーメッセージ・ログ・部品の版を確認できる画面を開きます">
            <Button onClick={() => api.post('/api/maintenance/terminal')}>開く</Button>
          </Row>
          <Row label="作り直す" hint="更新はせず、今のファイルからビルドし直します（表示がおかしいときなど）">
            <Button onClick={() => setConfirm('rebuild')}>作り直す</Button>
          </Row>
          <Row label="前の版に戻す" hint="更新のあとに調子が悪いとき、1 つ前の版に戻します">
            <Button disabled={!versions?.hasBackup} onClick={() => setConfirm('rollback')}>
              戻す
            </Button>
          </Row>
        </Card>

        <Card title="フォルダとアプリ">
          <Row label="フォルダを開く">
            <div class="btn-row">
              <Button small onClick={() => api.post('/api/maintenance/open', { target: 'avatar' })}>
                素材
              </Button>
              <Button small onClick={() => api.post('/api/maintenance/open', { target: 'logs' })}>
                ログ
              </Button>
              <Button small onClick={() => api.post('/api/maintenance/open', { target: 'settings' })}>
                設定
              </Button>
              <Button small onClick={() => api.post('/api/maintenance/open', { target: 'project' })}>
                プロジェクト
              </Button>
            </div>
          </Row>
          {autostart?.available && (
            <Row label="Windows の起動時に自動で起動">
              <Toggle
                checked={autostart.enabled}
                onChange={async (v) => {
                  try {
                    await api.put('/api/maintenance/autostart', { enabled: v });
                    setAutostart({ ...autostart, enabled: v });
                  } catch (e) {
                    toast(errorText(e), 'error');
                  }
                }}
              />
            </Row>
          )}
          {info?.isApp && (
            <Row label="アプリを終了" hint="OBS への表示も止まります。ウィンドウを閉じるだけならタスクトレイに残ります">
              <Button kind="danger" onClick={() => api.post('/api/app/quit')}>
                終了する
              </Button>
            </Row>
          )}
        </Card>
      </div>

      <Card title="部品のバージョン" actions={<Button small onClick={loadVersions}>再確認</Button>}>
        {versions ? (
          <>
            <div class="kv">
              <span>character_viewer</span>
              <b>
                v{versions.app}
                {versions.commit && ` （${versions.branch} / ${versions.commit}${versions.dirty ? '・手元に変更あり' : ''}）`}
              </b>
            </div>
            {versions.pinnedRust && (
              <p class="hint">Rust は動作確認済みの {versions.pinnedRust} に固定しています（新しい版でビルドできなかったため）。</p>
            )}
            <table class="table">
              <tbody>
                {versions.tools.map((t) => (
                  <tr key={t.name}>
                    <td>{t.name}</td>
                    <td class="muted">{t.role}</td>
                    <td class={t.version ? '' : 'bad'}>{t.version ?? '見つかりません'}</td>
                  </tr>
                ))}
                {versions.packages.map((p) => (
                  <tr key={p.kind + p.name}>
                    <td>{p.name}</td>
                    <td class="muted">{p.kind} の部品</td>
                    <td>{p.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!tool('cargo')?.version && <Notice kind="warn">Rust が見つからないため、更新と作り直しはできません。</Notice>}
          </>
        ) : (
          <p class="muted">
            <span class="spinner" /> 確認しています…
          </p>
        )}
      </Card>

      <Logs />

      {confirm && <ConfirmRun kind={confirm} opts={opts} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function UpdateItem(props: { label: string; text: string; available: boolean; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label class={`update-item ${props.available ? 'available' : ''}`}>
      <input type="checkbox" checked={props.checked && props.available} disabled={!props.available || props.disabled} onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)} />
      <div>
        <b>{props.label}</b>
        <div class="muted small">{props.text}</div>
      </div>
    </label>
  );
}

function ConfirmRun(props: { kind: 'update' | 'rebuild' | 'rollback'; opts: { git: boolean; rust: boolean; deps: boolean }; onClose: () => void }) {
  const title = { update: '更新する', rebuild: '作り直す', rollback: '前の版に戻す' }[props.kind];
  const run = async () => {
    if (props.kind === 'update') await api.post('/api/maintenance/update', props.opts);
    else await api.post(`/api/maintenance/${props.kind}`);
    toast('別のウィンドウで始めました。終わるとアプリが自動で起動し直します', 'info');
    props.onClose();
  };
  return (
    <Modal title={title} onClose={props.onClose}>
      <p>
        {props.kind === 'rollback'
          ? '1 つ前の版に戻します。アプリは一度終了して、自動で起動し直します。'
          : '別のウィンドウ（PowerShell）で作業の様子が表示されます。ビルドとテストに数分かかります。'}
      </p>
      {props.kind !== 'rollback' && (
        <ul>
          <li>作業中もアプリと OBS の表示はそのまま動きます</li>
          <li>成功したら、アプリが一度終了して新しい版で起動し直します（OBS の表示は数秒止まります）</li>
          <li>失敗したら、今の版のまま変わりません。ウィンドウにエラーの内容が表示されます</li>
        </ul>
      )}
      <Notice kind="warn">配信・録画中は避けてください。</Notice>
      <div class="modal-actions">
        <Button onClick={props.onClose}>やめる</Button>
        <Button kind="primary" onClick={run}>
          {title}
        </Button>
      </div>
    </Modal>
  );
}

function Logs() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const last = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const add = await api.get<LogLine[]>(`/api/logs?after=${last.current}`);
        if (add.length && alive) {
          last.current = add[add.length - 1].seq;
          setLines((l) => [...l, ...add].slice(-500));
          requestAnimationFrame(() => box.current && (box.current.scrollTop = box.current.scrollHeight));
        }
      } catch {
        /* つながらないときは次で */
      }
    };
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const shown = onlyProblems ? lines.filter((l) => l.level !== 'info') : lines;
  return (
    <Card
      title="ログ"
      desc="動作の記録です。エラー（赤）や注意（黄）があれば、ここで原因を確認できます"
      actions={
        <>
          <Toggle checked={onlyProblems} onChange={setOnlyProblems} label="エラーと注意だけ" />
          <Button small onClick={() => api.post('/api/maintenance/open', { target: 'logs' })}>
            フォルダを開く
          </Button>
        </>
      }
    >
      <div class="log" ref={box}>
        {shown.length === 0 && <div class="muted">記録はまだありません</div>}
        {shown.map((l) => (
          <div class={`log-line ${l.level}`} key={l.seq}>
            <span class="log-time">{l.time.slice(11)}</span>
            {l.message}
          </div>
        ))}
      </div>
    </Card>
  );
}
