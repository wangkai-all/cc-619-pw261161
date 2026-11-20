const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseISO(iso) {
  if (typeof iso !== 'string' || !ISO_RE.test(iso)) {
    throw new Error(`not an ISO yyyy-mm-dd date: ${String(iso)}`);
  }
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) {
    throw new Error(`invalid calendar date: ${iso}`);
  }
  return d;
}

export function toISO(date) {
  return date.toISOString().slice(0, 10);
}

export function ordinal(iso) {
  return Math.floor(parseISO(iso).getTime() / DAY_MS);
}

export function fromOrdinal(o) {
  return toISO(new Date(o * DAY_MS));
}

export function addDays(iso, n) {
  return fromOrdinal(ordinal(iso) + n);
}

export function diffDays(fromIso, toIso) {
  return ordinal(toIso) - ordinal(fromIso);
}

export function eachDay(fromIso, toIso) {
  const out = [];
  for (let o = ordinal(fromIso); o <= ordinal(toIso); o += 1) {
    out.push(fromOrdinal(o));
  }
  return out;
}

export function mean(xs) {
  if (!xs.length) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function quantile(sortedAsc, p) {
  if (!sortedAsc.length) return NaN;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}
