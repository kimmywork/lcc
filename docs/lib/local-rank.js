/**
 * Local rank classification for L2 grayscale.
 *
 * Whitening makes the 16 gray symbols roughly uniformly distributed.  In a
 * local window we can therefore classify by luminance rank rather than by an
 * absolute global gray ramp.  Rank is invariant to monotonic gain/offset
 * changes, so screen reflections and lighting gradients do not shift the
 * gray levels.
 */

export function localRankSymbols({ layout, rgbSamples, window = 3, levels = 16 }) {
  const N = layout.N;
  const D = layout.dataCoords.length;
  const lum = new Float64Array(D);
  for (let i = 0; i < D; i++) {
    const [r, g, b] = rgbSamples[i];
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  const idxGrid = new Int32Array(N * N).fill(-1);
  for (let i = 0; i < D; i++) {
    const [r, c] = layout.dataCoords[i];
    idxGrid[r * N + c] = i;
  }

  const symbols = new Int16Array(D);
  const percentiles = new Float64Array(D);
  const pts = [];
  for (let i = 0; i < D; i++) {
    const [r, c] = layout.dataCoords[i];
    pts.length = 0;
    for (let dr = -window; dr <= window; dr++) {
      const rr = r + dr;
      if (rr < 0 || rr >= N) continue;
      for (let dc = -window; dc <= window; dc++) {
        const cc = c + dc;
        if (cc < 0 || cc >= N) continue;
        const j = idxGrid[rr * N + cc];
        if (j >= 0) pts.push({ dr, dc, lum: lum[j] });
      }
    }
    // Remove the local illumination plane before ranking.  A screen
    // reflection produces a smooth gradient that would otherwise dominate
    // the rank order.
    let a = 0;
    let b = 0;
    let c0 = 0;
    if (pts.length >= 6) {
      let n = 0, sd = 0, sc = 0, sdd = 0, scc = 0, sdc = 0;
      let sl = 0, sdl = 0, scl = 0;
      for (const p of pts) {
        n++;
        sd += p.dr;
        sc += p.dc;
        sdd += p.dr * p.dr;
        scc += p.dc * p.dc;
        sdc += p.dr * p.dc;
        sl += p.lum;
        sdl += p.dr * p.lum;
        scl += p.dc * p.lum;
      }
      const A = [[n, sd, sc], [sd, sdd, sdc], [sc, sdc, scc]];
      const rhs = [sl, sdl, scl];
      const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1])
        - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0])
        + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
      if (Math.abs(det) > 1e-6) {
        const inv = (m) => {
          const d = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
          const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
          out[0][0] = (m[1][1] * m[2][2] - m[1][2] * m[2][1]) / d;
          out[0][1] = (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / d;
          out[0][2] = (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / d;
          out[1][0] = (m[1][2] * m[2][0] - m[1][0] * m[2][2]) / d;
          out[1][1] = (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / d;
          out[1][2] = (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / d;
          out[2][0] = (m[1][0] * m[2][1] - m[1][1] * m[2][0]) / d;
          out[2][1] = (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / d;
          out[2][2] = (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / d;
          return out;
        };
        const invA = inv(A);
        a = invA[0][0] * rhs[0] + invA[0][1] * rhs[1] + invA[0][2] * rhs[2];
        b = invA[1][0] * rhs[0] + invA[1][1] * rhs[1] + invA[1][2] * rhs[2];
        c0 = invA[2][0] * rhs[0] + invA[2][1] * rhs[1] + invA[2][2] * rhs[2];
      }
    }
    const residuals = pts.map((p) => p.lum - (a + b * p.dr + c0 * p.dc));
    residuals.sort((x, y) => x - y);
    const center = lum[i] - a;
    let lo = 0;
    let hi = residuals.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (residuals[mid] < center) lo = mid + 1;
      else hi = mid;
    }
    const p = residuals.length > 1 ? lo / (residuals.length - 1) : 0.5;
    percentiles[i] = p;
    symbols[i] = Math.max(0, Math.min(levels - 1, Math.round(p * (levels - 1))));
  }

  const costs = new Array(D);
  for (let i = 0; i < D; i++) {
    const target = percentiles[i] * (levels - 1);
    const c = new Float64Array(levels);
    for (let j = 0; j < levels; j++) c[j] = (target - j) ** 2;
    costs[i] = c;
  }

  return { symbols, costs, percentiles };
}
