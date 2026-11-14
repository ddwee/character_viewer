import { createReadStream, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig, type Plugin } from 'vite';

// 開発中（npm run dev）は、WebSocket・画像・API をエンジンへ中継する
const engine = 'http://127.0.0.1:39540';

/**
 * 顔の読み取り（MediaPipe）の WebAssembly を、/mediapipe/wasm/ で配信する。
 * ファイルは npm のパッケージに入っているので、ビルド時にそこから写す（リポジトリには入れない）。
 * モデル（public/mediapipe/face_landmarker.task）と合わせて、ネットにつながなくても動く
 */
function mediapipeWasm(): Plugin {
  const dir = resolve(import.meta.dirname, 'node_modules/@mediapipe/tasks-vision/wasm');
  const files = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'];
  return {
    name: 'cv-mediapipe-wasm',
    configureServer(server) {
      server.middlewares.use('/mediapipe/wasm', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].slice(1);
        if (!files.includes(name)) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        createReadStream(resolve(dir, name)).pipe(res);
      });
    },
    generateBundle() {
      for (const name of files) this.emitFile({ type: 'asset', fileName: `mediapipe/wasm/${name}`, source: readFileSync(resolve(dir, name)) });
    },
  };
}

export default defineConfig({
  // エンジンがどのパスで配信しても動くよう相対パスにする
  base: './',
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  plugins: [mediapipeWasm()],
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
        // カメラの読み取り（アプリの見えないウィンドウ、またはブラウザで開く）
        tracker: resolve(import.meta.dirname, 'tracker/index.html'),
      },
    },
  },
});
