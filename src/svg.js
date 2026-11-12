/**
 * Vector output for LCC symbols.
 *
 * The SVG uses module coordinates as the viewBox, so it scales cleanly for
 * print and desktop publishing.  Shape-bearing modules are emitted as a
 * background rect plus foreground line segments.
 */

import { LAYERS, resolveLayerName } from './constants.js';
import {
  foregroundFor,
  shapeFillsNormalized,
  shapeLineWidth,
  shapeSegmentsNormalized,
} from './shapes.js';

function rgbCss(rgb) {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

export function renderSVG({
  symbols,
  layout,
  palette,
  moduleSize = 1,
  quietZone = 2,
  layer = null,
}) {
  const N = layout.N;
  const total = N + 2 * quietZone;
  const size = total * moduleSize;
  const layerInfo = (layer ? LAYERS[resolveLayerName(layer)] : LAYERS[layout.layer]) ?? null;
  const shapeSetSize = layerInfo?.shapeSetSize ?? 1;
  const colorCount = palette.length;
  const lineWidthPx = shapeLineWidth(moduleSize);
  const lineWidth = moduleSize > 1 ? lineWidthPx / moduleSize : 1 / 8;
  const insetPx = Math.max(1, Math.round(moduleSize / 16));
  const inset = moduleSize > 1 ? insetPx / moduleSize : 1 / 16;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`,
  );
  parts.push(`<rect width="${total}" height="${total}" fill="#ffffff"/>`);

  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const i = r * N + c;
      let background;
      let shapeIndex = -1;
      if (layout.hasFixedColor[i]) {
        background = [
          layout.fixedColor[i * 3],
          layout.fixedColor[i * 3 + 1],
          layout.fixedColor[i * 3 + 2],
        ];
        if (layout.hasFixedShape[i]) shapeIndex = layout.fixedShape[i];
      } else {
        const sym = symbols[i];
        if (sym < 0 || sym >= shapeSetSize * colorCount) continue;
        if (shapeSetSize > 1) {
          shapeIndex = Math.floor(sym / colorCount);
          background = palette[sym % colorCount];
        } else {
          background = palette[sym];
        }
      }

      const x = c + quietZone;
      const y = r + quietZone;
      parts.push(
        `<rect x="${x}" y="${y}" width="1" height="1" fill="${rgbCss(background)}"/>`,
      );

      if (shapeIndex > 0) {
        const foreground = foregroundFor(background);
        const fills = shapeFillsNormalized(shapeIndex, inset);
        for (const [x0, y0, x1, y1] of fills) {
          parts.push(
            `<rect x="${x + x0}" y="${y + y0}" width="${x1 - x0}" height="${y1 - y0}" ` +
            `fill="${rgbCss(foreground)}"/>`,
          );
        }
        const segments = shapeSegmentsNormalized(shapeIndex, inset);
        for (const [x1, y1, x2, y2] of segments) {
          parts.push(
            `<line x1="${x + x1}" y1="${y + y1}" x2="${x + x2}" y2="${y + y2}" ` +
            `stroke="${rgbCss(foreground)}" stroke-width="${lineWidth}" ` +
            `stroke-linecap="square"/>`,
          );
        }
      }
    }
  }
  parts.push('</svg>');
  return parts.join('');
}
