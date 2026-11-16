/**
 * Dựng nến từ tick (giống MT5: theo giá BID, chỉ có nến khi có tick).
 *   tick t   : epoch mili-giây (giờ MT5 = UTC)
 *   bar time : epoch giây, thời điểm MỞ nến
 */

export const TIMEFRAMES: Record<string, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400,
};

export type Bars = {
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  tickStart?: Int32Array;
  tickEnd?: Int32Array;
};

export type Ticks = { t: Float64Array; bid: Float64Array; ask: Float64Array };

export function emptyBars(): Bars {
  return {
    time: new Float64Array(0),
    open: new Float64Array(0),
    high: new Float64Array(0),
    low: new Float64Array(0),
    close: new Float64Array(0),
    volume: new Float64Array(0),
  };
}

export function emptyTicks(): Ticks {
  return { t: new Float64Array(0), bid: new Float64Array(0), ask: new Float64Array(0) };
}

function alloc(n: number): Bars {
  return {
    time: new Float64Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
  };
}

function shrink(b: Bars, n: number): Bars {
  const out: Bars = {
    time: b.time.slice(0, n),
    open: b.open.slice(0, n),
    high: b.high.slice(0, n),
    low: b.low.slice(0, n),
    close: b.close.slice(0, n),
    volume: b.volume.slice(0, n),
  };
  if (b.tickStart) out.tickStart = b.tickStart.slice(0, n);
  if (b.tickEnd) out.tickEnd = b.tickEnd.slice(0, n);
  return out;
}

/** Nến OHLC theo BID. withIndex -> thêm tickStart / tickEnd (vị trí tick trong mảng). */
export function barsFromTicks(t: Float64Array, bid: Float64Array, tfSec = 60, withIndex = false): Bars {
  const n = t.length;
  const out = alloc(n);
  const ts = withIndex ? new Int32Array(n) : null;
  const te = withIndex ? new Int32Array(n) : null;
  let k = -1;
  let cur = NaN;

  for (let i = 0; i < n; i++) {
    const bucket = Math.floor(Math.floor(t[i] / 1000) / tfSec) * tfSec;
    const p = bid[i];
    if (bucket !== cur) {
      k++;
      cur = bucket;
      out.time[k] = bucket;
      out.open[k] = out.high[k] = out.low[k] = out.close[k] = p;
      out.volume[k] = 1;
      if (ts) ts[k] = i;
      if (k > 0 && te) te[k - 1] = i;
    } else {
      if (p > out.high[k]) out.high[k] = p;
      if (p < out.low[k]) out.low[k] = p;
      out.close[k] = p;
      out.volume[k]++;
    }
  }
  if (k >= 0 && te) te[k] = n;

  if (ts && te) {
    out.tickStart = ts;
    out.tickEnd = te;
  }
  return shrink(out, k + 1);
}

/** Gộp nến nhỏ (vd M1) thành khung lớn hơn. */
export function aggregate(b: Bars, tfSec: number): Bars {
  const n = b.time.length;
  const out = alloc(n);
  let k = -1;
  let cur = NaN;

  for (let i = 0; i < n; i++) {
    const bucket = Math.floor(b.time[i] / tfSec) * tfSec;
    if (bucket !== cur) {
      k++;
      cur = bucket;
      out.time[k] = bucket;
      out.open[k] = b.open[i];
      out.high[k] = b.high[i];
      out.low[k] = b.low[i];
      out.close[k] = b.close[i];
      out.volume[k] = b.volume[i];
    } else {
      if (b.high[i] > out.high[k]) out.high[k] = b.high[i];
      if (b.low[i] < out.low[k]) out.low[k] = b.low[i];
      out.close[k] = b.close[i];
      out.volume[k] += b.volume[i];
    }
  }
  return shrink(out, k + 1);
}

export function concatBars(parts: Bars[]): Bars {
  const list = parts.filter((p) => p && p.time.length);
  const n = list.reduce((s, p) => s + p.time.length, 0);
  const out = alloc(n);
  let o = 0;
  for (const p of list) {
    out.time.set(p.time, o);
    out.open.set(p.open, o);
    out.high.set(p.high, o);
    out.low.set(p.low, o);
    out.close.set(p.close, o);
    out.volume.set(p.volume, o);
    o += p.time.length;
  }
  return out;
}

/** Số phần tử của mảng tăng dần < value (bisect_left). */
export function lowerBound(a: ArrayLike<number>, value: number) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function sliceBars(b: Bars, startSec?: number, endSec?: number): Bars {
  const a = startSec === undefined ? 0 : lowerBound(b.time, startSec);
  const e = endSec === undefined ? b.time.length : lowerBound(b.time, endSec);
  return {
    time: b.time.slice(a, e),
    open: b.open.slice(a, e),
    high: b.high.slice(a, e),
    low: b.low.slice(a, e),
    close: b.close.slice(a, e),
    volume: b.volume.slice(a, e),
  };
}

/**
 * Làm tròn giống hệt round(x, n) của Python: theo giá trị thập phân CHÍNH XÁC của số thực,
 * đúng nửa -> làm tròn về số chẵn. (Math.round(x*100)/100 sai ở các số như 0.625 -> 0.63.)
 */
export function roundTo(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x;
  const a = Math.abs(x);
  if (a >= 1e15) return x;
  const full = a.toFixed(100); // khai triển thập phân chính xác của số double
  const dot = full.indexOf('.');
  const tail = full.slice(dot + 1 + digits);
  let r: number;
  if (/^50*$/.test(tail)) {
    const head = digits > 0 ? full.slice(0, dot + 1 + digits) : full.slice(0, dot);
    const last = Number(head[head.length - 1]);
    r = last % 2 === 0 ? Number(head) : Number(a.toFixed(digits));
  } else {
    r = Number(a.toFixed(digits));
  }
  return x < 0 ? -r : r;
}

/** Làm tròn giống np.round: rint(x * 10^n) / 10^n (nhanh, dùng cho mảng nến / đường chỉ báo). */
export function npRound(x: number, digits: number): number {
  const f = 10 ** digits;
  const y = x * f;
  const fl = Math.floor(y);
  const d = y - fl;
  const r = d > 0.5 ? fl + 1 : d < 0.5 ? fl : fl % 2 === 0 ? fl : fl + 1;
  return r / f;
}

export function barsToJson(b: Bars, digits = 3) {
  const out = new Array(b.time.length);
  for (let i = 0; i < b.time.length; i++) {
    out[i] = {
      time: b.time[i],
      open: npRound(b.open[i], digits),
      high: npRound(b.high[i], digits),
      low: npRound(b.low[i], digits),
      close: npRound(b.close[i], digits),
      volume: b.volume[i],
    };
  }
  return out;
}
