/**
 * Chỉ báo (cũ -> mới), cùng công thức với bot live:
 *   sma         = pandas close.rolling(n).mean()
 *   rollingStd  = pandas close.rolling(n).std(ddof=0)
 *   rsiWilder   = calc_rsi() của rsi_engine.py (RSI mặc định MT5)
 *   adxMt5      = calc_adx(method="MT5")    của adx_engine.py (iADX)
 *   adxWilder   = calc_adx(method="WILDER") của adx_engine.py (iADXWilder)
 * Chưa đủ dữ liệu = NaN.
 */

export type Arr = Float64Array;

export function sma(x: ArrayLike<number>, period: number): Arr {
  const n = x.length;
  const out = new Float64Array(n).fill(NaN);
  if (period <= 0 || n < period) return out;
  // tổng tích lũy giống numpy cumsum để khớp số học
  const csum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) csum[i + 1] = csum[i] + x[i];
  for (let i = period - 1; i < n; i++) out[i] = (csum[i + 1] - csum[i + 1 - period]) / period;
  return out;
}

export function rollingStd(x: ArrayLike<number>, period: number): Arr {
  const n = x.length;
  const out = new Float64Array(n).fill(NaN);
  if (period <= 0 || n < period) return out;
  for (let i = period - 1; i < n; i++) {
    let mean = 0;
    for (let k = i - period + 1; k <= i; k++) mean += x[k];
    mean /= period;
    let v = 0;
    for (let k = i - period + 1; k <= i; k++) v += (x[k] - mean) * (x[k] - mean);
    out[i] = Math.sqrt(v / period);
  }
  return out;
}

export function bollinger(close: ArrayLike<number>, period = 20, mult = 2): [Arr, Arr, Arr] {
  const mid = sma(close, period);
  const sd = rollingStd(close, period);
  const up = new Float64Array(mid.length);
  const low = new Float64Array(mid.length);
  for (let i = 0; i < mid.length; i++) {
    up[i] = mid[i] + mult * sd[i];
    low[i] = mid[i] - mult * sd[i];
  }
  return [mid, up, low];
}

export function rsiWilder(close: ArrayLike<number>, period = 14): Arr {
  const n = close.length;
  const out = new Float64Array(n).fill(NaN);
  if (n <= period) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const ch = close[i] - close[i - 1];
    gains += Math.max(ch, 0);
    losses += Math.max(-ch, 0);
  }
  let g = gains / period;
  let l = losses / period;
  const value = (a: number, b: number) => (b === 0 ? (a > 0 ? 100 : 50) : 100 - 100 / (1 + a / b));
  out[period] = value(g, l);

  for (let i = period + 1; i < n; i++) {
    const ch = close[i] - close[i - 1];
    g = (g * (period - 1) + Math.max(ch, 0)) / period;
    l = (l * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = value(g, l);
  }
  return out;
}

export function adxMt5(high: ArrayLike<number>, low: ArrayLike<number>, close: ArrayLike<number>, period = 14): Arr {
  const n = high.length;
  const out = new Float64Array(n).fill(NaN);
  if (n < 2) return out;

  const alpha = 2 / (period + 1);
  let pdi = 0;
  let ndi = 0;
  let adx = 0;

  for (let i = 1; i < n; i++) {
    let up = Math.max(high[i] - high[i - 1], 0);
    let down = Math.max(low[i - 1] - low[i], 0);
    if (up > down) down = 0;
    else if (down > up) up = 0;
    else up = down = 0;

    const tr = Math.max(Math.abs(high[i] - low[i]), Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    const pRaw = tr ? (100 * up) / tr : 0;
    const nRaw = tr ? (100 * down) / tr : 0;

    pdi = pRaw * alpha + pdi * (1 - alpha);
    ndi = nRaw * alpha + ndi * (1 - alpha);
    const total = pdi + ndi;
    const dx = total ? (100 * Math.abs(pdi - ndi)) / total : 0;
    adx = dx * alpha + adx * (1 - alpha);
    out[i] = adx;
  }
  return out;
}

export function adxWilder(high: ArrayLike<number>, low: ArrayLike<number>, close: ArrayLike<number>, period = 14): Arr {
  const n = high.length;
  const out = new Float64Array(n).fill(NaN);
  if (n < period * 2 + 1) return out;

  const tr: number[] = [];
  const p: number[] = [];
  const m: number[] = [];

  for (let i = 1; i < n; i++) {
    const up = high[i] - high[i - 1];
    const down = low[i - 1] - low[i];
    p.push(up > down && up > 0 ? up : 0);
    m.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
  }

  let trS = 0;
  let pS = 0;
  let mS = 0;
  for (let k = 0; k < period; k++) {
    trS += tr[k];
    pS += p[k];
    mS += m[k];
  }

  const dx: [number, number][] = [];
  for (let j = period; j <= tr.length; j++) {
    if (j > period) {
      trS = trS - trS / period + tr[j - 1];
      pS = pS - pS / period + p[j - 1];
      mS = mS - mS / period + m[j - 1];
    }
    const pdi = trS ? (100 * pS) / trS : 0;
    const ndi = trS ? (100 * mS) / trS : 0;
    const total = pdi + ndi;
    dx.push([j, total ? (100 * Math.abs(pdi - ndi)) / total : 0]);
  }

  let adx = 0;
  for (let k = 0; k < dx.length; k++) {
    const [j, d] = dx[k];
    if (k + 1 < period) continue;
    if (k + 1 === period) {
      let s = 0;
      for (let q = 0; q < period; q++) s += dx[q][1];
      adx = s / period;
    } else {
      adx = (adx * (period - 1) + d) / period;
    }
    out[j] = adx;
  }
  return out;
}
