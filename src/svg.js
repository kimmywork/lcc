/**
 * Vector output for LCC symbols.
 *
 * The SVG uses module coordinates as the viewBox, so it scales cleanly for
 * print and desktop publishing.
 */

export function renderSVG({ symbols, layout, palette, moduleSize = 1, quietZone = 2 }) {
  const N = layout.N;
  const total = N + 2 * quietZone;
  const size = total * moduleSize;
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`,
  );
  parts.push(`<rect width="${total}" height="${total}" fill="#ffffff"/>`);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const i = r * N + c;
      let color;
      if (layout.hasFixedColor[i]) {
        color = [
          layout.fixedColor[i * 3],
          layout.fixedColor[i * 3 + 1],
          layout.fixedColor[i * 3 + 2],
        ];
      } else {
        const sym = symbols[i];
        if (sym < 0 || sym >= palette.length) continue;
        color = palette[sym];
      }
      parts.push(
        `<rect x="${c + quietZone}" y="${r + quietZone}" width="1" height="1" ` +
        `fill="rgb(${color[0]},${color[1]},${color[2]})"/>`,
      );
    }
  }
  parts.push('</svg>');
  return parts.join('');
}
