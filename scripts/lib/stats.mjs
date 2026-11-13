/** Small statistics helpers shared by tests and benchmark scripts. */

export function quantile(values, q) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function summarize(values) {
  if (values.length === 0) {
    return { n: 0, mean: 0, median: 0, p95: 0, p99: 0, min: 0, max: 0, stddev: 0, cv: 0 };
  }
  const n = values.length;
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  return {
    n,
    mean,
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    min: Math.min(...values),
    max: Math.max(...values),
    stddev,
    cv: mean === 0 ? 0 : stddev / mean,
  };
}

/** Batch means; useful to detect drift over long runs. */
export function batchMeans(values, batchSize) {
  const batches = [];
  for (let i = 0; i < values.length; i += batchSize) {
    const batch = values.slice(i, i + batchSize);
    batches.push(batch.reduce((a, b) => a + b, 0) / batch.length);
  }
  return batches;
}

export function fmt(value, digits = 2) {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(digits === 0 ? 0 : 1);
  return value.toFixed(digits);
}

export function fmtMs(value) {
  return `${fmt(value, 2)} ms`;
}

export function fmtBytes(value) {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

export function table(rows, columns) {
  if (rows.length === 0) return '';
  const cells = rows.map((row) => columns.map((col) => String(col.format ? col.format(row) : row[col.key] ?? '')));
  const widths = columns.map((col, i) => Math.max(col.title.length, ...cells.map((row) => row[i].length)));
  const line = (parts) => parts.map((part, i) => part.padEnd(widths[i])).join('  ');
  const out = [line(columns.map((c) => c.title)), line(widths.map((w) => '-'.repeat(w)))];
  for (const row of cells) out.push(line(row));
  return out.join('\n');
}
