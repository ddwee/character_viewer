import { defineConfig } from 'vite';

// 開発中（npm run dev）は、WebSocket と画像をエンジンへ中継する
const engine = 'http://127.0.0.1:39540';

export default defineConfig({
  // エンジンがどのパスで配信しても動くよう相対パスにする
  base: './',
  server: {
    proxy: {
      '/ws': { target: engine, ws: true },
      '/avatar': engine,
    },
  },
  build: {
    // OBS 30 のブラウザソース（Chromium 103 相当）でも動くように
    target: 'chrome103',
  },
});
