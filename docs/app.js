import { encode, decodeAuto, renderSVG } from './lib/index.js';

const $ = (id) => document.getElementById(id);
const textEl = $('text');
const encodeCanvas = $('encodeCanvas');
const scanCanvas = $('scanCanvas');
const video = $('video');

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
    `RS symbols ${m.rsSymbols} · corrected ${m.correctedSymbols} · detection score ${d.score ? Number(d.score).toFixed(2) : 'n/a'}`,
  ].join('\n');
}

function friendlyError(error) {
  const meta = error?.lccMeta;
  if (meta) {
    if (meta.layer === 'L1' || meta.layer === 'L2a' || meta.layer === 'L3c') {
      return `检测到 ${meta.layer} 码，但纠错失败：请靠近、保持清晰、避开反光。`;
    }
    if (meta.layer === 'L2b') {
      const c = meta.constraint ? '，且开启了 constraint' : '';
      return `L2b 是支持的；这次是真实纠错失败（检测到 L2b 8 灰${c}）。8 灰间距较小，强反光/摩尔纹下容易跨级；请换角度/靠近，或改用 L2a（4 灰）或 L3c（16 色）+ constraint off。`;
    }
    const extra = meta.constraint ? '，且开启了 constraint' : '';
    return `检测到 ${meta.layer} 多级色码${extra}；摄像头建议 L3c/L3d，L4e/L4f 仅用于清洁/数字/打印。`;
  }
  const msg = String(error?.message ?? error);
  if (msg.includes('no contrast')) return '画面没有足够对比度，请对准码面并避免过曝。';
  if (msg.includes('not enough')) return '没有找到 LCC 定位图案，请让码面完整进入画面。';
  if (msg.includes('format band')) return '格式带读取失败，请靠近一点或换一个角度。';
  if (msg.includes('RS:')) return '纠错失败：屏幕反光/高光削顶会破坏多级灰/彩。摄像头场景请改用 L1 黑白 + constraint off，或换角度避开反光。';
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
    ['ECC', `${meta.eccLevel ?? '—'} (${(meta.ecc * 100).toFixed(0)}%)`],
    ['约束', meta.constraint
      ? `on · rank ${meta.constraintRankCount} / Δ≤${meta.constraintMaxDiff}`
      : 'off'],
    ['校准', meta.calibration],
    ['RS 符号', `${meta.rsSymbols} · 校正 ${meta.correctedSymbols}`],
    ['bit/模块', Number(meta.bitsPerModule ?? 0).toFixed(3)],
    ['格式带', `${meta.formatBlocks ?? '—'} 块/副本`],
  ];
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

async function decodeRGB(image, options = {}) {
  if (decoding) return false;
  decoding = true;
  if (!options.silent) setStatus('解码中…', 'busy');
  await new Promise((resolve) => setTimeout(resolve, 20));
  try {
    const result = decodeAuto(image, options.detector ? { detector: options.detector } : {});
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
    setStatus(`识别成功 · ${result.meta.layer} v${result.meta.version} · 校正 ${result.meta.correctedSymbols} 个 RS 符号`, 'ok');
    return true;
  } catch (e) {
    if (!options.silent) setStatus(`识别失败：${friendlyError(e)}`, 'err');
    return false;
  } finally {
    decoding = false;
  }
}

function scheduleContinuous() {
  clearTimeout(continuousTimer);
  if (!$('continuous').checked || !cameraStream) return;
  continuousTimer = setTimeout(async () => {
    if (!$('continuous').checked || !cameraStream) return;
    try {
      const image = captureFrame();
      drawImage(scanCanvas, image);
      setStatus('扫描中…请让码面完整进入画面', 'busy');
      const ok = await decodeRGB(image, { silent: true, detector: 'perspective' });
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

async function startCamera() {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    video.srcObject = cameraStream;
    await video.play();
    $('cameraHint').style.display = 'none';
    $('capture').disabled = false;
    $('cameraStop').disabled = false;
    $('cameraStart').disabled = true;
    setStatus('摄像头已开启。把 LCC 码放进画面，点击拍照或开启连续扫描。', '');
  } catch (e) {
    setStatus(`无法打开摄像头：${e.message}`, 'err');
  }
}

function stopCamera() {
  $('continuous').checked = false;
  clearTimeout(continuousTimer);
  if (cameraStream) {
    for (const track of cameraStream.getTracks()) track.stop();
    cameraStream = null;
  }
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

document.getElementById('cameraPreset').addEventListener('click', () => {
  $('layer').value = 'L1';
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
  setStatus('已切换到摄像头黑白预设：L1 + Q + Boost ECC + 静区 4。', '');
});

document.getElementById('cameraColorPreset').addEventListener('click', () => {
  $('layer').value = 'L3c';
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
  setStatus('已切换到摄像头彩色预设：L3c（16 色，min ΔE ≈ 49）+ Q + Boost ECC + 静区 4。', '');
});

document.querySelectorAll('[data-example]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      const name = btn.dataset.example;
      const response = await fetch(`./examples/${encodeURIComponent(name)}`);
      if (!response.ok) throw new Error(`示例加载失败 (${response.status})`);
      textEl.value = await response.text();
      $('layer').value = 'L4f';
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
      setStatus(`已加载示例：${name}。摄像头场景建议使用 L1/L2a/L3c + constraint off。`, '');
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
$('capture').addEventListener('click', async () => {
  try {
    const image = captureFrame();
    drawImage(scanCanvas, image);
    await decodeRGB(image, { detector: 'perspective' });
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
