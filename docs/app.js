import {
  encode,
  decodeAuto,
  detectPerspective,
  renderSVG,
  stackCanonicalFrames,
  LAYERS,
} from './lib/index.js';
import { decodeAutoWasm, scanFramesWasm, stackCanonicalFramesWasm } from './lib/lcc-wasm.js';
import { wasmSimdSupported } from './lib/wasm-common.js';

const $ = (id) => document.getElementById(id);
const textEl = $('text');
const encodeCanvas = $('encodeCanvas');
const scanCanvas = $('scanCanvas');
const video = $('video');

const LAYER_LIST = Object.values(LAYERS);

function layerForDimensions(kind, colors, shapes) {
  return LAYER_LIST.find((layer) => layer.kind === kind
    && layer.paletteSize === colors
    && (layer.shapeSetSize ?? 1) === shapes);
}

function refreshLayerColors() {
  const kind = $('layerKind').value;
  const values = [...new Set(LAYER_LIST
    .filter((layer) => layer.kind === kind)
    .map((layer) => layer.paletteSize))]
    .sort((a, b) => a - b);
  const previous = Number($('layerColors').value);
  $('layerColors').innerHTML = values
    .map((value) => `<option value="${value}">${kind === 'gray' ? `${value} 级灰` : `${value} 色`}</option>`)
    .join('');
  $('layerColors').value = String(values.includes(previous) ? previous : values[0]);
  refreshLayerShapes();
}

function refreshLayerShapes() {
  const kind = $('layerKind').value;
  const colors = Number($('layerColors').value);
  const values = [...new Set(LAYER_LIST
    .filter((layer) => layer.kind === kind && layer.paletteSize === colors)
    .map((layer) => layer.shapeSetSize ?? 1))]
    .sort((a, b) => a - b);
  const previous = Number($('layerShapes').value);
  $('layerShapes').innerHTML = values
    .map((value) => `<option value="${value}">${value === 1 ? '无符号' : `${value} 符号`}</option>`)
    .join('');
  $('layerShapes').value = String(values.includes(previous) ? previous : values[0]);
  applyLayerDimensions();
}

function applyLayerDimensions() {
  const kind = $('layerKind').value;
  const colors = Number($('layerColors').value);
  const shapes = Number($('layerShapes').value);
  const layer = layerForDimensions(kind, colors, shapes);
  if (layer) $('layer').value = layer.name;
}

function syncLayerDimensionControls(name = $('layer').value) {
  const layer = LAYERS[name];
  if (!layer) return;
  $('layerKind').value = layer.kind;
  refreshLayerColors();
  $('layerColors').value = String(layer.paletteSize);
  refreshLayerShapes();
  $('layerShapes').value = String(layer.shapeSetSize ?? 1);
  applyLayerDimensions();
}

let lastEncoded = null;
let cameraStream = null;
let continuousTimer = null;
let decoding = false;

function rgbToImageData(image) {
  const { width, height, data } = image;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
    rgba[j] = data[i];
    rgba[j + 1] = data[i + 1];
    rgba[j + 2] = data[i + 2];
    rgba[j + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}

function imageDataToRGB(imageData) {
  const { width, height, data } = imageData;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  return { width, height, data: rgb };
}

function drawImage(canvas, image) {
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(rgbToImageData(image), 0, 0);
}

function setStatus(message, kind = '') {
  const el = $('scanStatus');
  el.textContent = message;
  el.className = `status ${kind}`;
}

function encodeMetaText(meta) {
  return [
    `layer ${meta.layer} · v${meta.version} / N=${meta.N} · module ${meta.moduleSize}px`,
    `${meta.bitsPerModule.toFixed(3)} bit/module · payload ${meta.payloadSize}B / capacity ${meta.payloadCapacity}B`,
    `palette ${meta.paletteMode}${meta.harmony ? '+harmony' : ''} · constraint ${meta.constraint ? 'on' : 'off'} · seed ${meta.seed}`,
  ].join('\n');
}

function decodeMetaText(result) {
  const m = result.meta;
  const d = result.detection ?? {};
  return [
    `layer ${m.layer} · v${m.version} / N=${m.N} · module ${Number.isFinite(m.moduleSize) ? Number(m.moduleSize).toFixed(2) : 'n/a'}px`,
    `palette ${m.paletteMode} · constraint ${m.constraint ? 'on' : 'off'} · seed ${m.seed} · calibration ${m.calibration}`,
    `RS symbols ${m.rsSymbols} · corrected ${m.correctedSymbols} · detection ${m.detectionPath ?? 'direct'} · score ${d.score ? Number(d.score).toFixed(2) : 'n/a'}`,
  ].join('\n');
}

function friendlyError(error) {
  const meta = error?.lccMeta;
  if (meta) {
    if (meta.shapeSetSize > 1) {
      return `检测到 ${meta.layer} 形状码，但纠错失败：形状层需要更大模块（建议 16px）和更清晰的画面；请靠近、保持对焦、避开运动模糊。`;
    }
    if (meta.layer === 'G10' || meta.layer === 'G20' || meta.layer === 'C30' || meta.layer === 'C40') {
      return `检测到 ${meta.layer} 码，但纠错失败：请靠近、保持清晰、避开反光。`;
    }
    if (meta.layer === 'G30') {
      const c = meta.constraint ? '，且开启了 constraint' : '';
      return `G30 是支持的；这次是真实纠错失败（检测到 G30 8 灰${c}）。8 灰间距较小，强反光/摩尔纹下容易跨级；请换角度/靠近，或改用 G20（4 灰）或 C30/C40 + constraint off。`;
    }
    const extra = meta.constraint ? '，且开启了 constraint' : '';
    return `检测到 ${meta.layer} 多级色码${extra}；摄像头建议 C30/C40/C33，C60/C80 仅用于清洁/数字/打印。`;
  }
  const msg = String(error?.message ?? error);
  if (msg.includes('no contrast')) return '画面没有足够对比度，请对准码面并避免过曝。';
  if (msg.includes('not enough')) return '没有找到 LCC 定位图案，请让码面完整进入画面。';
  if (msg.includes('format band')) return '格式带读取失败，请靠近一点或换一个角度。';
  if (msg.includes('version range does not fit')) {
    return '当前层/载荷在画布内放不下：请增大画布、减小静区，或缩短载荷。';
  }
  if (msg.includes('RS:')) return '纠错失败：屏幕反光/高光削顶会破坏多级灰/彩。摄像头场景请改用 G10 黑白 + constraint off，或换角度避开反光。';
  if (msg.includes('constraint')) return '约束解码失败；摄像头场景请生成 constraint off 的码面。';
  return msg;
}

function renderStats(container, meta) {
  const items = [
    ['层', meta.layer],
    ['版本', `v${meta.version} / N=${meta.N}`],
    ['模块', `${meta.moduleSize}px`],
    ['静区', `${meta.quietZone ?? '—'} 模块`],
    ['色板', `${meta.paletteSize} 色 · min ΔE ${Number(meta.minDeltaE).toFixed(1)}`],
    ['形态', meta.shapeSetSize > 1
      ? `${meta.shapeSetSize} 种 · ${meta.shapeBits} bit`
      : '无图案'],
    ['ECC', `${meta.eccLevel ?? '—'} (${(meta.ecc * 100).toFixed(0)}%)`],
    ['约束', meta.constraint
      ? `on · rank ${meta.constraintRankCount} / Δ≤${meta.constraintMaxDiff}`
      : 'off'],
    ['数据/功能', `${meta.dataCount} / ${meta.functionCount}`],
    ['载荷/容量', `${meta.payloadSize}B / ${meta.payloadCapacity}B`],
    ['bit/模块', Number(meta.bitsPerModule).toFixed(3)],
    ['格式带', `${meta.formatBlocks} 块/副本`],
    ['种子', meta.seed],
  ];
  container.innerHTML = items
    .map(([k, v]) => `<div class="stat"><span>${k}</span><strong>${v}</strong></div>`)
    .join('');
}

function renderScanStats(container, meta) {
  const items = [
    ['层', meta.layer],
    ['版本', `v${meta.version} / N=${meta.N}`],
    ['模块', `${Number(meta.moduleSize).toFixed(2)}px`],
    ['色板', `${meta.paletteSize} 色 · min ΔE ${Number(meta.minDeltaE).toFixed(1)}`],
    ['形态', meta.shapeSetSize > 1
      ? `${meta.shapeSetSize} 种 · ${meta.shapeBits} bit`
      : '无图案'],
    ['ECC', `${meta.eccLevel ?? '—'} (${(meta.ecc * 100).toFixed(0)}%)`],
    ['约束', meta.constraint
      ? `on · rank ${meta.constraintRankCount} / Δ≤${meta.constraintMaxDiff}`
      : 'off'],
    ['校准', meta.calibration],
    ['RS 符号', `${meta.rsSymbols} · 校正 ${meta.correctedSymbols}`],
    ['bit/模块', Number(meta.bitsPerModule ?? 0).toFixed(3)],
    ['格式带', `${meta.formatBlocks ?? '—'} 块/副本`],
  ];
  if (meta.stackRequested > 1 || meta.stackFrames > 1) {
    const noise = Number.isFinite(meta.stackNoise) ? ` · σ≈${meta.stackNoise.toFixed(1)}` : '';
    items.push([
      '叠加',
      `${meta.stackFrames}/${meta.stackRequested ?? meta.stackFrames} 帧` +
        (meta.stackModuleSize ? ` · ${meta.stackModuleSize}px` : '') +
        noise,
    ]);
  }
  container.innerHTML = items
    .map(([k, v]) => `<div class="stat"><span>${k}</span><strong>${v}</strong></div>`)
    .join('');
}

function generate() {
  const text = textEl.value;
  if (!text.trim()) {
    $('encodeStats').innerHTML = '';
    $('encodeMeta').textContent = '请输入要编码的文本。';
    return;
  }
  const layer = $('layer').value;
  const paletteMode = $('palette').value;
  const mode = $('mode').value;
  const size = Number($('size').value);
  const constraint = $('constraint').checked;
  const eccLevel = $('ecc').value;
  const minVersion = Number($('minVersion').value) || 1;
  const maxVersion = Number($('maxVersion').value) || 100;
  const moduleSize = $('moduleSize').value === 'auto' ? undefined : Number($('moduleSize').value);
  const quietZone = $('quietZone').value === 'auto' ? undefined : Number($('quietZone').value);
  const boostEcc = $('boostEcc').checked;
  try {
    const result = encode(text, {
      layer,
      paletteMode,
      mode,
      width: size,
      height: size,
      constraint,
      maxModulePx: 32,
      eccLevel,
      minVersion,
      maxVersion,
      moduleSize,
      quietZone,
      boostEcc,
    });
    lastEncoded = result;
    drawImage(encodeCanvas, result.image);
    renderStats($('encodeStats'), result.meta);
    $('encodeMeta').textContent = '';
    $('download').disabled = false;
    $('downloadSvg').disabled = false;
  } catch (e) {
    lastEncoded = null;
    $('encodeStats').innerHTML = '';
    $('download').disabled = true;
    $('downloadSvg').disabled = true;
    $('encodeMeta').textContent = `生成失败：${friendlyError(e)}`;
  }
}

async function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('无法读取图片'));
    img.src = URL.createObjectURL(file);
  });
}

function imageElementToRGB(img, maxDim = 2000) {
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  return imageDataToRGB(ctx.getImageData(0, 0, w, h));
}

function captureFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) throw new Error('摄像头画面尚未就绪');
  const scale = Math.min(1, 1600 / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);
  return imageDataToRGB(ctx.getImageData(0, 0, w, h));
}

async function captureStack(count, onProgress) {
  const frames = [];
  const detections = [];
  for (let i = 0; i < count; i++) {
    const frame = captureFrame();
    let det = null;
    try {
      det = detectPerspective(frame);
    } catch {
      // Skip frames without a usable symbol.
    }
    frames.push(frame);
    detections.push(det);
    onProgress?.(i + 1, count);
    if (i < count - 1) await new Promise((resolve) => setTimeout(resolve, 90));
  }
  try {
    try {
      return await stackCanonicalFramesWasm(frames, detections, { quietZone: 4 });
    } catch {
      return stackCanonicalFrames(frames, detections, { quietZone: 4 });
    }
  } catch {
    return {
      image: frames[frames.length - 1],
      frames: 1,
      requested: count,
      stacked: false,
    };
  }
}

async function decodeRGB(image, options = {}) {
  if (decoding) return false;
  decoding = true;
  if (!options.silent) setStatus('解码中…', 'busy');
  await new Promise((resolve) => setTimeout(resolve, 20));
  try {
    let result = options.result ?? null;
    // Single uploads: detect the symbol geometry first, warp one canonical
    // frame, then decode that.  This is the same path as the multi-frame
    // scanner, so the UI no longer sends a raw full image straight to decode.
    if (!result && !options.detector && !options.stackInfo) {
      try {
        result = await scanFramesWasm([image]);
        if (result) result.meta.detectionPath = 'detect+canonical';
      } catch {
        result = null;
      }
    }
    if (!result) {
      try {
        result = await decodeAutoWasm(image, options.detector ? { detector: options.detector } : {});
        if (result) result.meta.detectionPath = 'direct';
      } catch {
        result = null;
      }
    }
    if (!result) {
      result = decodeAuto(image, options.detector ? { detector: options.detector } : {});
      result.meta.detectionPath = 'direct';
    }
    if (options.stackInfo) {
      result.meta.stackFrames = options.stackInfo.frames;
      result.meta.stackRequested = options.stackInfo.requested;
      result.meta.stackModuleSize = options.stackInfo.moduleSize;
      result.meta.stackNoise = options.stackInfo.noise;
    }
    const payload = result.payload;
    let text = result.text;
    if (text === null) {
      text = `[二进制 ${payload.length} 字节]\n` +
        Array.from(payload).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    }
    $('scanText').textContent = text;
    renderScanStats($('scanStats'), result.meta);
    $('scanMeta').textContent = decodeMetaText(result);
    $('scanResult').hidden = false;
    const stackNote = result.meta.stackRequested > 1
      ? ` · 叠加 ${result.meta.stackFrames}/${result.meta.stackRequested} 帧`
      : '';
    setStatus(
      `识别成功 · ${result.meta.layer} v${result.meta.version} · 校正 ${result.meta.correctedSymbols} 个 RS 符号${stackNote}`,
      'ok',
    );
    return true;
  } catch (e) {
    if (!options.silent) setStatus(`识别失败：${friendlyError(e)}`, 'err');
    return false;
  } finally {
    decoding = false;
  }
}

async function captureAndDecode({ silent = false } = {}) {
  const count = Number($('stackFrames').value) || 1;
  const frames = [];
  for (let i = 0; i < count; i++) {
    if (count > 1) setStatus(`多帧叠加：${i}/${count}…`, 'busy');
    frames.push(captureFrame());
    if (i < count - 1) await new Promise((resolve) => setTimeout(resolve, 90));
  }
  try {
    const scanned = await scanFramesWasm(frames);
    if (scanned) {
      drawImage(scanCanvas, frames[frames.length - 1]);
      return decodeRGB(frames[frames.length - 1], {
        result: scanned,
        stackInfo: {
          frames: count,
          requested: count,
          stacked: count > 1,
        },
        silent,
      });
    }
  } catch {
    // C scan missed the symbol; the JS detector is the fallback.
  }
  let stack;
  if (count > 1) {
    stack = await captureStack(count);
  } else {
    stack = {
      image: frames[0],
      frames: 1,
      requested: 1,
      stacked: false,
    };
  }
  drawImage(scanCanvas, stack.image);
  return decodeRGB(stack.image, {
    detector: stack.stacked ? 'axis' : 'perspective',
    stackInfo: stack,
    silent,
  });
}

function scheduleContinuous() {
  clearTimeout(continuousTimer);
  if (!$('continuous').checked || !cameraStream) return;
  continuousTimer = setTimeout(async () => {
    if (!$('continuous').checked || !cameraStream) return;
    try {
      setStatus('扫描中…请让码面完整进入画面', 'busy');
      const ok = await captureAndDecode({ silent: true });
      if (ok) {
        $('continuous').checked = false;
        return;
      }
    } catch {
      // Ignore transient camera errors and try again.
    }
    scheduleContinuous();
  }, 750);
}

function cameraErrorMessage(error) {
  const name = error?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '权限被拒绝。请在浏览器/系统设置中允许摄像头；iOS 还需在“设置 > Safari > 相机”中允许。';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '没有找到摄像头。';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '摄像头被其他应用占用，请关闭其他相机应用后重试。';
  }
  if (name === 'OverconstrainedError') {
    return '摄像头不支持请求的分辨率，请重试。';
  }
  return error?.message ?? String(error);
}

async function getCameraStream() {
  const attempts = [
    {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    },
    {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    },
    { video: { facingMode: 'environment' }, audio: false },
    { video: true, audio: false },
  ];
  let lastError = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error('无法获取摄像头视频流');
}

async function waitForVideoReady(element) {
  if (element.readyState >= 2 && element.videoWidth) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('摄像头画面尚未就绪'));
    }, 8000);
    const check = () => {
      if (element.videoWidth && element.readyState >= 2) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      element.removeEventListener('loadedmetadata', check);
      element.removeEventListener('canplay', check);
    };
    element.addEventListener('loadedmetadata', check);
    element.addEventListener('canplay', check);
    check();
  });
}

async function startCamera() {
  const startButton = $('cameraStart');
  startButton.disabled = true;
  setStatus('正在请求摄像头…', 'busy');
  try {
    if (!window.isSecureContext) {
      throw new Error(
        '当前地址不是 HTTPS/localhost（例如 http://192.168.x.x），Safari/Chrome 会禁用摄像头。' +
        '请用 HTTPS 隧道、GitHub Pages 或 localhost 打开。',
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持摄像头 API；请使用 iOS 14.3+ 的 Safari 或最新版 Chrome。');
    }
    cameraStream = await getCameraStream();
    // iOS Safari needs these attributes before srcObject/play(), otherwise
    // playback can stay suspended or open fullscreen.
    video.muted = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.playsInline = true;
    video.srcObject = cameraStream;
    await video.play();
    await waitForVideoReady(video);
    $('cameraHint').style.display = 'none';
    $('capture').disabled = false;
    $('cameraStop').disabled = false;
    startButton.disabled = true;
    setStatus(
      `摄像头已开启（${video.videoWidth}×${video.videoHeight}）。把 LCC 码放进画面，点击拍照或开启连续扫描。`,
      '',
    );
  } catch (e) {
    if (cameraStream) {
      for (const track of cameraStream.getTracks()) track.stop();
      cameraStream = null;
    }
    video.srcObject = null;
    $('cameraHint').style.display = '';
    startButton.disabled = false;
    const diagnostic = [
      `secure=${window.isSecureContext}`,
      `protocol=${location.protocol}`,
      `mediaDevices=${!!navigator.mediaDevices}`,
      `wasm=${typeof WebAssembly !== 'undefined'}`,
      `simd=${wasmSimdSupported()}`,
      `error=${e?.name ?? 'Error'}`,
    ].join(' · ');
    setStatus(`无法打开摄像头：${cameraErrorMessage(e)}（${diagnostic}）`, 'err');
  }
}

function stopCamera() {
  $('continuous').checked = false;
  clearTimeout(continuousTimer);
  if (cameraStream) {
    for (const track of cameraStream.getTracks()) track.stop();
    cameraStream = null;
  }
  video.pause();
  video.srcObject = null;
  $('cameraHint').style.display = '';
  $('capture').disabled = true;
  $('cameraStop').disabled = true;
  $('cameraStart').disabled = false;
  setStatus('摄像头已关闭。', '');
}

$('generate').addEventListener('click', generate);
$('download').addEventListener('click', () => {
  if (!lastEncoded) return;
  encodeCanvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lcc_${lastEncoded.meta.layer}_v${lastEncoded.meta.version}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }, 'image/png');
});

$('downloadSvg').addEventListener('click', () => {
  if (!lastEncoded) return;
  const svg = renderSVG({
    symbols: lastEncoded.symbols,
    layout: lastEncoded.layout,
    palette: lastEncoded.paletteInfo.palette,
    moduleSize: lastEncoded.meta.moduleSize,
    quietZone: lastEncoded.meta.quietZone,
  });
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lcc_${lastEncoded.meta.layer}_v${lastEncoded.meta.version}.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
});

$('layerKind').addEventListener('change', refreshLayerColors);
$('layerColors').addEventListener('change', refreshLayerShapes);
$('layerShapes').addEventListener('change', applyLayerDimensions);
$('layer').value = 'G10';
syncLayerDimensionControls('G10');

document.getElementById('cameraPreset').addEventListener('click', () => {
  $('layer').value = 'G10';
  syncLayerDimensionControls('G10');
  $('palette').value = 'maxmin';
  $('mode').value = 'fill';
  $('size').value = '1024';
  $('constraint').checked = false;
  $('ecc').value = 'Q';
  $('boostEcc').checked = true;
  $('quietZone').value = '4';
  $('moduleSize').value = 'auto';
  $('minVersion').value = '1';
  $('maxVersion').value = '100';
  if (!textEl.value.trim()) textEl.value = 'https://example.com/lcc';
  generate();
  setStatus('已切换到摄像头黑白预设：G10 + Q + Boost ECC + 静区 4。', '');
});

document.getElementById('cameraColorPreset').addEventListener('click', () => {
  $('layer').value = 'C40';
  syncLayerDimensionControls('C40');
  $('palette').value = 'maxmin';
  $('mode').value = 'fill';
  $('size').value = '1024';
  $('constraint').checked = false;
  $('ecc').value = 'Q';
  $('boostEcc').checked = true;
  $('quietZone').value = '4';
  $('moduleSize').value = 'auto';
  $('minVersion').value = '1';
  $('maxVersion').value = '100';
  if (!textEl.value.trim()) textEl.value = 'https://example.com/lcc';
  generate();
  setStatus('已切换到摄像头彩色预设：C40（16 色，min ΔE ≈ 49）+ Q + Boost ECC + 静区 4。', '');
});

document.getElementById('cameraShapePreset').addEventListener('click', () => {
  $('layer').value = 'C33';
  syncLayerDimensionControls('C33');
  $('palette').value = 'maxmin';
  $('mode').value = 'fill';
  $('size').value = '1024';
  $('constraint').checked = false;
  $('ecc').value = 'Q';
  $('boostEcc').checked = true;
  $('quietZone').value = '4';
  $('moduleSize').value = 'auto';
  $('minVersion').value = '1';
  $('maxVersion').value = '100';
  if (!textEl.value.trim()) textEl.value = 'https://example.com/lcc';
  generate();
  setStatus('已切换到摄像头形态预设：C33（8 色 + 8 符号，6 bit）+ Q + 静区 4；模块尺寸 auto，优先选能放下的最大模块（摄像头最低建议 16px）。', '');
});

document.querySelectorAll('[data-example]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      const name = btn.dataset.example;
      const response = await fetch(`./examples/${encodeURIComponent(name)}`);
      if (!response.ok) throw new Error(`示例加载失败 (${response.status})`);
      textEl.value = await response.text();
      $('layer').value = 'C80';
      syncLayerDimensionControls('C80');
      $('palette').value = 'maxmin';
      $('constraint').checked = false;
      $('ecc').value = 'auto';
      $('boostEcc').checked = false;
      $('quietZone').value = 'auto';
      $('moduleSize').value = 'auto';
      $('minVersion').value = '1';
      $('maxVersion').value = '100';
      $('size').value = name.includes('金刚经') ? '2048' : '1024';
      generate();
      setStatus(`已加载示例：${name}。摄像头场景建议使用 G10/G20/C30/C40/C33 + constraint off。`, '');
    } catch (e) {
      setStatus(friendlyError(e), 'err');
    }
  });
});

$('file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    setStatus('正在读取图片…', 'busy');
    const img = await loadImageFile(file);
    const image = imageElementToRGB(img, 2000);
    drawImage(scanCanvas, image);
    await decodeRGB(image);
  } catch (e) {
    setStatus(friendlyError(e), 'err');
  } finally {
    event.target.value = '';
  }
});

$('cameraStart').addEventListener('click', startCamera);
$('cameraStop').addEventListener('click', stopCamera);
$('cameraHint').addEventListener('click', () => {
  if (!cameraStream) startCamera();
});
$('capture').addEventListener('click', async () => {
  try {
    await captureAndDecode();
  } catch (e) {
    setStatus(friendlyError(e), 'err');
  }
});
$('continuous').addEventListener('change', () => {
  if ($('continuous').checked) {
    if (!cameraStream) {
      $('continuous').checked = false;
      setStatus('请先打开摄像头，再开启连续扫描。', 'err');
      return;
    }
    scheduleContinuous();
  } else {
    clearTimeout(continuousTimer);
  }
});
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('scanText').textContent ?? '');
    setStatus('识别结果已复制。', 'ok');
  } catch {
    setStatus('复制失败，请手动选择文本。', 'err');
  }
});

// Default demo on first load.
textEl.value = 'https://example.com/lcc?demo=1';
generate();
