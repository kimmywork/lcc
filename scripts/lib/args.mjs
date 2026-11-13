/** Command-line operand validation shared by the benchmark scripts. */
export function positiveInt(value, name, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (value === true) throw new Error(`--${name} requires a numeric value`);
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new Error(`--${name} must be a positive integer <= ${max}`);
  }
  return n;
}
