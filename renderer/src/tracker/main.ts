// カメラの読み取りページ。顔の向きと表情を読み取って、エンジン経由で描画ページへ送る。
//
// アプリでは見えないウィンドウで開いたままにする（設定画面の「カメラの映像を表示」で見える）。
// ブラウザで使うときは http://127.0.0.1:39540/tracker/ を開いたままにする。
//
// - 設定（カメラを使うか・どのカメラか・感度）はエンジンから読み、変わったら追従する
// - 読み取りは MediaPipe Face Landmarker（この PC の中だけで動く。映像はどこにも送らない）
// - ウィンドウが隠れていても止まらないよう、合図は Worker のタイマーで出す
//   （ページのタイマーや requestAnimationFrame は、隠れると止まるか遅くなる）
//
// URL のオプション
//   ?engine=127.0.0.1:39540  エンジンの場所（通常は不要）

import type { FaceLandmarker } from '@mediapipe/tasks-vision';

import { toFaceMsg, type CameraConfig, type FaceMsg, type RawFace } from '../rig/track';
import { rawFace } from './signals';

const params = new URLSearchParams(location.search);
const host = params.get('engine') ?? location.host;
const base = `${location.protocol}//${host}`;

const video = document.getElementById('video') as HTMLVideoElement;
const marks = document.getElementById('marks') as HTMLCanvasElement;
const stage = document.getElementById('stage')!;
const statusEl = document.getElementById('status')!;
const detailEl = document.getElementById('detail')!;

/** 設定を読み直す間隔（ms） */
const SETTINGS_POLL_MS = 1500;
/** 顔が見つからないときなどに、状況を送る間隔（ms） */
const STATUS_INTERVAL_MS = 500;
/** カメラに求める大きさと速さ（顔の読み取りには十分。大きくしても精度はほぼ変わらず、遅くなる） */
const VIDEO = { width: 640, height: 480, frameRate: 30 };

let config: CameraConfig | null = null;
let landmarker: FaceLandmarker | null = null;
let stream: MediaStream | null = null;
/** いま開いているカメラの名前 */
let streamLabel = '';
let starting = false;
let lastVideoTime = -1;
let lastStatusAt = 0;
let fps = 0;
let frames = 0;
let fpsAt = performance.now();
let raw: RawFace | null = null;

function setStatus(text: string, kind: 'ok' | 'bad' | '' = ''): void {
  if (statusEl.textContent !== text) statusEl.textContent = text;
  statusEl.className = kind;
}

// ───────────────────────── エンジンとの接続 ─────────────────────────

let ws: WebSocket | null = null;

function connect(): void {
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws?role=tracker`);
  socket.onopen = () => (ws = socket);
  socket.onclose = () => {
    if (ws === socket) ws = null;
    setTimeout(connect, 1000);
  };
}

function send(msg: FaceMsg): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** 読み取れていないときの状況を送る（設定画面に表示される） */
function sendStatus(status: string, now: number): void {
  if (now - lastStatusAt < STATUS_INTERVAL_MS) return;
  lastStatusAt = now;
  send({ type: 'face', ok: false, status });
}

async function loadConfig(): Promise<void> {
  try {
    const res = await fetch(`${base}/api/settings`, { cache: 'no-store' });
    if (!res.ok) return;
    config = ((await res.json()) as { camera: CameraConfig }).camera;
    stage.classList.toggle('mirror', config.mirror);
  } catch {
    // エンジンが再起動中など。次の回でまた読む
  }
}

// ───────────────────────── カメラと読み取り ─────────────────────────

async function loadLandmarker(): Promise<FaceLandmarker> {
  const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const files = await FilesetResolver.forVisionTasks(new URL('../mediapipe/wasm', location.href).href);
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: new URL('../mediapipe/face_landmarker.task', location.href).href, delegate },
    runningMode: 'VIDEO' as const,
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  try {
    return await FaceLandmarker.createFromOptions(files, options('GPU'));
  } catch (e) {
    console.warn('GPU で読み取れないため、CPU で読み取ります', e);
    return FaceLandmarker.createFromOptions(files, options('CPU'));
  }
}

/** 名前でカメラを探す（見つからなければ既定のカメラ） */
async function findDevice(label: string | null): Promise<string | undefined> {
  if (!label) return undefined;
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.find((d) => d.kind === 'videoinput' && d.label === label)?.deviceId;
}

async function openCamera(label: string | null): Promise<void> {
  let deviceId = await findDevice(label);
  let s = await navigator.mediaDevices.getUserMedia({ video: { ...VIDEO, ...(deviceId && { deviceId: { exact: deviceId } }) }, audio: false });
  // カメラの名前は、一度許可されるまで分からない。許可された後でもう一度探す
  if (label && !deviceId && (deviceId = await findDevice(label)) && s.getVideoTracks()[0]?.getSettings().deviceId !== deviceId) {
    s.getTracks().forEach((t) => t.stop());
    s = await navigator.mediaDevices.getUserMedia({ video: { ...VIDEO, deviceId: { exact: deviceId } }, audio: false });
  }
  stream = s;
  streamLabel = label ?? '';
  video.srcObject = s;
  await video.play();
  s.getVideoTracks()[0]?.addEventListener('ended', () => stop('カメラが切断されました'));
}

function stop(reason?: string): void {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  raw = null;
  marks.getContext('2d')?.clearRect(0, 0, marks.width, marks.height);
  if (reason) setStatus(reason, 'bad');
}

function cameraError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError') return 'カメラの使用が許可されていません（このウィンドウに出る確認で「許可」を選んでください）';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'カメラが見つかりません';
  if (name === 'NotReadableError') return 'カメラを開けません（ほかのアプリが使っている可能性があります）';
  return `カメラを開けません: ${e instanceof Error ? e.message : String(e)}`;
}

/** 設定に合わせて、カメラと読み取りを始める / 止める */
async function sync(): Promise<void> {
  if (starting || !config) return;
  if (!config.enabled) {
    if (stream) stop();
    setStatus('カメラは使っていません（設定画面の「カメラ」で使うようにできます）');
    return;
  }
  if (stream && streamLabel === (config.device ?? '')) return;
  starting = true;
  try {
    if (stream) stop();
    setStatus('カメラを開いています…');
    await openCamera(config.device);
    if (!landmarker) {
      setStatus('顔の読み取りを準備しています…');
      landmarker = await loadLandmarker();
    }
    setStatus('読み取っています', 'ok');
  } catch (e) {
    stop(landmarker || !stream ? cameraError(e) : `顔の読み取りを始められません: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    starting = false;
  }
}

/** 顔の点を映像に重ねて描く（ウィンドウが見えているときだけ） */
function drawMarks(points: readonly { x: number; y: number }[] | undefined): void {
  if (document.visibilityState !== 'visible') return;
  if (marks.width !== video.videoWidth || marks.height !== video.videoHeight) {
    marks.width = video.videoWidth;
    marks.height = video.videoHeight;
  }
  const ctx = marks.getContext('2d')!;
  ctx.clearRect(0, 0, marks.width, marks.height);
  if (!points) return;
  ctx.fillStyle = 'rgb(120 220 255 / 0.8)';
  for (const p of points) ctx.fillRect(p.x * marks.width - 1, p.y * marks.height - 1, 2, 2);
}

function tick(): void {
  const now = performance.now();
  if (!config?.enabled) return;
  if (!stream || !landmarker) {
    if (!starting) sendStatus(statusEl.textContent ?? '', now);
    return;
  }
  // 新しいコマが来たときだけ読み取る
  if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const result = landmarker.detectForVideo(video, now);
  const shapes = result.faceBlendshapes?.[0]?.categories;
  const matrix = result.facialTransformationMatrixes?.[0]?.data;
  drawMarks(result.faceLandmarks?.[0]);

  frames++;
  if (now - fpsAt >= 1000) {
    fps = Math.round((frames * 1000) / (now - fpsAt));
    frames = 0;
    fpsAt = now;
  }

  if (!shapes || !matrix) {
    raw = null;
    setStatus('顔が見つかりません（カメラに顔が映るようにしてください）', 'bad');
    sendStatus('顔が見つかりません', now);
    return;
  }
  raw = rawFace(shapes, matrix, result.faceLandmarks?.[0], video.videoWidth / Math.max(1, video.videoHeight));
  send({ ...toFaceMsg(raw, config), fps, raw });
  setStatus(`読み取っています（${fps} 回/秒）`, 'ok');
  if (document.visibilityState === 'visible') {
    detailEl.textContent = `向き ${raw.yaw.toFixed(0)}° / ${raw.pitch.toFixed(0)}° / 傾き ${raw.roll.toFixed(0)}°\nこのウィンドウは閉じても、顔の読み取りは続きます。`;
  }
}

// ───────────────────────── 起動 ─────────────────────────

/**
 * 隠れたウィンドウでも止まらない合図（Worker のタイマーは絞られない）。
 * 次の合図は、前の処理が終わってから `intervalMs` 後に出す
 * （読み取りが遅い PC で、合図が溜まり続けて固まらないように）
 */
function startTicker(onTick: () => void, intervalMs: number): void {
  const code = `onmessage = () => setTimeout(() => postMessage(0), ${intervalMs}); postMessage(0);`;
  try {
    const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    worker.onmessage = () => {
      onTick();
      worker.postMessage(0);
    };
  } catch {
    setInterval(onTick, intervalMs);
  }
}

async function main(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('この画面ではカメラを使えません', 'bad');
    return;
  }
  connect();
  await loadConfig();
  await sync();
  startTicker(() => {
    try {
      tick();
    } catch (e) {
      console.error(e);
    }
  }, 8);
  startTicker(() => void loadConfig().then(sync), SETTINGS_POLL_MS);
}

void main();
