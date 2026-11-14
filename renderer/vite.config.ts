import { resolve } from 'node:path';

import { defineConfig } from 'vite';

// 開発中（npm run dev）は、WebSocket・画像・API をエンジンへ中継する
const engine = 'http://127.0.0.1:39540';

export default defineConfig({
  // エンジンがどのパスで配信しても動くよう相対パスにする
  base: './',
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  server: {
    proxy: {
      '/ws': { target: engine, ws: true },
      '/avatar': engine,
      '/api': engine,
    },
  },
  build: {
    // OBS 30 のブラウザソース（Chromium 103 相当）でも動くように
    target: 'chrome103',
    rollupOptions: {
      input: {
        // 描画ページ（OBS のブラウザソース）
        main: resolve(import.meta.dirname, 'index.html'),
        // 設定画面
        settings: resolve(import.meta.dirname, 'settings/index.html'),
      },
    },
  },
});
