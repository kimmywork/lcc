/**
 * Decode worker for the demo page.
 *
 * The worker owns its own lcc-decoder.wasm instance, so detection, stacking and
 * decoding no longer block the UI thread.  The main thread captures the burst,
 * transfers the RGB buffers (zero copy), and keeps painting the camera preview
 * while this worker runs.  Nothing here re-opens the camera: the whole burst is
 * processed from the frames that were handed over.
 */

import {
  decodeAutoWasm,
  detectPerspectiveWasm,
  scanFramesWasm,
  stackCanonicalFramesWasm,
} from './lcc-wasm.js';

function toImage(frame) {
  return { width: frame.width, height: frame.height, data: new Uint8Array(frame.buffer) };
}

function decodeDetected(image, detector) {
  try {
    return decodeAutoWasm(image, { detector });
  } catch {
    return null;
  }
}

function decodeBurst(images) {
  let result = null;
  try {
    result = scanFramesWasm(images);
    if (result) result.meta.detectionPath = 'detect+canonical';
  } catch {
    result = null;
  }
  if (result) return { result, stack: null };

  let stack = null;
  if (images.length > 1) {
    try {
      const detections = images.map((image) => {
        try {
          return detectPerspectiveWasm(image);
        } catch {
          return null;
        }
      });
      stack = stackCanonicalFramesWasm(images, detections, { quietZone: 4 });
    } catch {
      stack = null;
    }
    if (stack) {
      const image = stack.stacked ? stack.image : images[images.length - 1];
      result = decodeDetected(image, stack.stacked ? 'axis' : 'perspective');
      if (result) result.meta.detectionPath = stack.stacked ? 'stack+axis' : 'direct';
    }
  }
  if (!result && images.length === 1) {
    result = decodeDetected(images[0], 'auto');
    if (result) result.meta.detectionPath = 'direct';
  }
  return { result, stack };
}

self.onmessage = (event) => {
  const message = event.data;
  if (!message || message.type !== 'decode' || !message.id) return;
  const payload = { type: 'result', id: message.id, result: null, stack: null };
  try {
    const images = Array.isArray(message.frames) ? message.frames.map(toImage) : [];
    const outcome = decodeBurst(images);
    payload.result = outcome.result;
    if (outcome.stack) {
      payload.stack = {
        frames: outcome.stack.frames,
        requested: outcome.stack.requested,
        stacked: outcome.stack.stacked,
        noise: outcome.stack.noise,
        moduleSize: outcome.stack.moduleSize,
        image: outcome.stack.image ?? null,
      };
    }
  } catch (error) {
    payload.error = String(error?.message ?? error);
  }
  const transfer = [];
  if (payload.result?.payload?.buffer) transfer.push(payload.result.payload.buffer);
  if (payload.stack?.image?.data?.buffer) transfer.push(payload.stack.image.data.buffer);
  self.postMessage(payload, transfer);
};

// Module evaluation (including the WASM fetch) is asynchronous; tell the page
// when requests can be posted.  Messages sent before this point are dropped by
// some browsers, so the page waits for this handshake.
self.postMessage({ type: 'ready' });
