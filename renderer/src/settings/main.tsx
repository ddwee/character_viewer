// 設定画面（アプリのウィンドウ・ブラウザ・OBS のカスタムブラウザドックで開く）。

import './style.css';

import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { STATE_LABELS } from './api';
import { Camera } from './pages/Camera';
import { Home } from './pages/Home';
import { Images } from './pages/Images';
import { Maintenance } from './pages/Maintenance';
import { Mic } from './pages/Mic';
import { Obs } from './pages/Obs';
import { Rig } from './pages/Rig';
import { SettingsProvider, useSettings, useStatus, useToasts } from './store';

const PAGES = [
  { id: 'home', label: 'ホーム', icon: '🏠' },
  { id: 'mic', label: 'マイク', icon: '🎙️' },
  { id: 'images', label: '画像と動き', icon: '🖼️' },
  { id: 'rig', label: 'パーツの調整', icon: '🦴' },
  { id: 'camera', label: 'カメラ', icon: '📷' },
  { id: 'obs', label: 'OBS', icon: '📺' },
  { id: 'maintenance', label: 'メンテナンス', icon: '🛠️' },
] as const;
type PageId = (typeof PAGES)[number]['id'];

function currentPage(): PageId {
  const h = location.hash.slice(1);
  return (PAGES.find((p) => p.id === h)?.id ?? 'home') as PageId;
}

function App() {
  const [page, setPage] = useState<PageId>(currentPage());
  const status = useStatus(page === 'mic' ? 150 : 400);
  const { saving, info } = useSettings();
  const toasts = useToasts();

  useEffect(() => {
    const on = () => setPage(currentPage());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (id: string) => (location.hash = id);

  const problems = (status?.inputError ? 1 : 0) + (info && !info.rendererBuilt ? 1 : 0) + (info?.notices.length ?? 0);
  // ドック（幅の狭い表示）では左のメニューを上に並べる
  return (
    <div class="app">
      <nav class="side">
        <div class="brand">
          <img src="../favicon.svg" alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
          character_viewer
        </div>
        {PAGES.map((p) => (
          <a class={`nav ${p.id === page ? 'active' : ''}`} href={`#${p.id}`} key={p.id}>
            <span class="nav-icon">{p.icon}</span>
            {p.label}
            {p.id === 'home' && problems > 0 && <span class="badge">{problems}</span>}
          </a>
        ))}
        <div class="side-foot">
          <div class={`live ${status ? (status.speaking ? 'talk' : 'ok') : 'down'}`}>
            <span class="live-dot" />
            {status ? (status.speaking ? '話しています' : STATE_LABELS[status.state]) : 'エンジンに接続中…'}
          </div>
          <div class="muted small">
            {saving ? '保存しています…' : '変更は自動で保存されます'}
            {info && <div>v{info.version}</div>}
          </div>
        </div>
      </nav>
      <main class="content">
        {!status && (
          <div class="notice error">
            エンジンに接続できません。アプリが起動しているか確認してください（自動で再接続します）。
          </div>
        )}
        {page === 'home' && <Home status={status} go={go} />}
        {page === 'mic' && <Mic status={status} />}
        {page === 'images' && <Images />}
        {page === 'rig' && <Rig />}
        {page === 'camera' && <Camera />}
        {page === 'obs' && <Obs />}
        {page === 'maintenance' && <Maintenance />}
      </main>
      <div class="toasts">
        {toasts.map((t) => (
          <div class={`toast ${t.kind}`} key={t.id}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

render(
  <SettingsProvider>
    <App />
  </SettingsProvider>,
  document.getElementById('root')!,
);
