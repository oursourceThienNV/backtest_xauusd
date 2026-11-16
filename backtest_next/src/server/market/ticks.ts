import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { settings } from '../config';
import { pool, query } from '../db';
import { type Bars, type Ticks, barsFromTicks, concatBars, emptyBars, emptyTicks, lowerBound } from './bars';

/**
 * Đọc tick từ bảng do tool mt5_history ghi (mặc định xauusd_ticks).
 *   - Mỗi lần đọc 1 ngày (giờ MT5 = UTC), ORDER BY time_msc, seq -> đúng thứ tự tick đã xảy ra.
 *   - Ngày đã kết thúc được lưu cache file (.cache/ticks/<symbol>/<ngày>.bin),
 *     lần sau đọc file, không tải lại từ DB.
 *   - Nến M1 từng ngày cũng cache riêng (dùng cho warmup chỉ báo).
 */

export const DAY_MS = 86_400_000;
const MEM_CACHE_DAYS = 40;

export const dayStartMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
export const msToDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => msToDay(dayStartMs(day) + n * DAY_MS);

export function daysBetween(first: string, last: string): string[] {
  const out: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

function table() {
  const name = settings.ticksTable;
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Tên bảng tick không hợp lệ: ${name}`);
  return name;
}

type Cache = {
  symbols: Map<string, string>;
  ticks: Map<string, Ticks>;
  m1: Map<string, Bars>;
  loading: Map<string, Promise<Ticks>>;
};

const g = globalThis as unknown as { __tickCache?: Cache };
const cache: Cache = (g.__tickCache ||= { symbols: new Map(), ticks: new Map(), m1: new Map(), loading: new Map() });

function remember<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MEM_CACHE_DAYS) map.delete(map.keys().next().value as string);
}

const dayComplete = (day: string) => dayStartMs(day) + DAY_MS <= Date.now() - 600_000;

function cachePath(kind: string, symbol: string, day: string) {
  const dir = path.join(settings.cacheDir, kind, symbol);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${day}.bin`);
}

/** Ghi / đọc nhiều mảng Float64 cùng độ dài vào 1 file nhị phân. */
function writeArrays(file: string, arrays: Float64Array[]) {
  const n = arrays[0]?.length ?? 0;
  const buf = new Float64Array(1 + n * arrays.length);
  buf[0] = n;
  arrays.forEach((a, k) => buf.set(a, 1 + k * n));
  fs.writeFileSync(file, Buffer.from(buf.buffer));
}

function readArrays(file: string, count: number): Float64Array[] {
  const raw = fs.readFileSync(file);
  const all = new Float64Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const n = all[0];
  const out: Float64Array[] = [];
  for (let k = 0; k < count; k++) out.push(all.slice(1 + k * n, 1 + (k + 1) * n));
  return out;
}

// ------------------------------------------------------------
// SYMBOL / NGÀY CÓ DỮ LIỆU
// ------------------------------------------------------------

export async function resolveSymbol(prefix?: string | null): Promise<string> {
  const p = (prefix || settings.marketSymbol).trim();
  const hit = cache.symbols.get(p);
  if (hit) return hit;

  let names: string[] = [];
  try {
    const rows = await query<any>("SELECT DISTINCT symbol FROM sync_log WHERE timeframe = 'TICK' AND symbol LIKE ?", [p + '%']);
    names = rows.map((r) => r.symbol);
  } catch {
    names = [];
  }

  if (!names.length) {
    const rows = await query<any>(`SELECT symbol FROM ${table()} WHERE symbol LIKE ? LIMIT 1`, [p + '%']);
    names = rows.map((r) => r.symbol);
  }

  if (!names.length) throw new Error(`Không có tick nào của ${p} trong bảng ${table()}`);

  const symbol = names.sort((a, b) => a.length - b.length)[0];
  cache.symbols.set(p, symbol);
  return symbol;
}

export async function availableDays(symbol: string) {
  try {
    const rows = await query<any>(
      "SELECT trade_day, row_count, status FROM sync_log WHERE symbol = ? AND timeframe = 'TICK' ORDER BY trade_day",
      [symbol],
    );
    if (rows.length) {
      return rows.map((r) => ({
        day: typeof r.trade_day === 'string' ? r.trade_day : msToDay(new Date(r.trade_day).getTime()),
        ticks: Number(r.row_count || 0),
        status: r.status as string,
      }));
    }
  } catch {
    /* không có bảng sync_log */
  }

  const row = (await query<any>(`SELECT MIN(time_msc) AS a, MAX(time_msc) AS b FROM ${table()} WHERE symbol = ?`, [symbol]))[0];
  if (!row || row.a === null) return [];
  return daysBetween(msToDay(Number(row.a)), msToDay(Number(row.b))).map((day) => ({ day, ticks: null, status: 'unknown' }));
}

// ------------------------------------------------------------
// TICK
// ------------------------------------------------------------

async function queryDay(symbol: string, day: string): Promise<Ticks> {
  const a = dayStartMs(day);
  const b = a + DAY_MS;
  const sql =
    `SELECT time_msc, bid + 0e0, ask + 0e0 FROM ${table()} ` +
    'WHERE symbol = ? AND time_msc >= ? AND time_msc < ? ORDER BY time_msc, seq';

  const [rows] = (await pool().query({ sql, values: [symbol, a, b], rowsAsArray: true })) as any;

  const n = rows.length;
  const t = new Float64Array(n);
  const bid = new Float64Array(n);
  const ask = new Float64Array(n);
  let k = 0;

  for (let i = 0; i < n; i++) {
    const r = rows[i];
    const pb = Number(r[1]);
    const pa = Number(r[2]);
    if (!(pb > 0 && pa > 0)) continue; // bỏ tick không có giá
    t[k] = Number(r[0]);
    bid[k] = pb;
    ask[k] = pa;
    k++;
  }

  return { t: t.slice(0, k), bid: bid.slice(0, k), ask: ask.slice(0, k) };
}

export async function dayTicks(symbol: string, day: string): Promise<Ticks> {
  const key = `${symbol}|${day}`;
  const mem = cache.ticks.get(key);
  if (mem) {
    remember(cache.ticks, key, mem);
    return mem;
  }

  const pending = cache.loading.get(key);
  if (pending) return pending;

  const job = (async () => {
    const file = cachePath('ticks', symbol, day);
    let value: Ticks;

    if (fs.existsSync(file)) {
      const [t, bid, ask] = readArrays(file, 3);
      value = { t, bid, ask };
    } else {
      value = await queryDay(symbol, day);
      if (dayComplete(day)) writeArrays(file, [value.t, value.bid, value.ask]);
    }

    remember(cache.ticks, key, value);
    return value;
  })();

  cache.loading.set(key, job);
  try {
    return await job;
  } finally {
    cache.loading.delete(key);
  }
}

function concatTicks(parts: Ticks[]): Ticks {
  const n = parts.reduce((s, p) => s + p.t.length, 0);
  const out = { t: new Float64Array(n), bid: new Float64Array(n), ask: new Float64Array(n) };
  let o = 0;
  for (const p of parts) {
    out.t.set(p.t, o);
    out.bid.set(p.bid, o);
    out.ask.set(p.ask, o);
    o += p.t.length;
  }
  return out;
}

/** Tick trong [startMs, endMs). */
export async function ticksRange(symbol: string, startMs: number, endMs: number): Promise<Ticks> {
  if (endMs <= startMs) return emptyTicks();
  const parts: Ticks[] = [];

  for (const day of daysBetween(msToDay(startMs), msToDay(endMs - 1))) {
    const d = await dayTicks(symbol, day);
    const lo = lowerBound(d.t, startMs);
    const hi = lowerBound(d.t, endMs);
    if (hi > lo) parts.push({ t: d.t.subarray(lo, hi), bid: d.bid.subarray(lo, hi), ask: d.ask.subarray(lo, hi) });
  }

  return parts.length ? concatTicks(parts) : emptyTicks();
}

/** `limit` tick đầu tiên có time >= fromMs (bỏ qua ngày trống, tìm tối đa maxDays ngày). */
export async function ticksFrom(symbol: string, fromMs: number, limit: number, maxDays = 7): Promise<Ticks> {
  const parts: Ticks[] = [];
  let count = 0;
  let day = msToDay(fromMs);
  const lastDay = msToDay(Date.now());

  for (let k = 0; k < maxDays && day <= lastDay; k++) {
    const d = await dayTicks(symbol, day);
    const lo = lowerBound(d.t, fromMs);
    const take = Math.min(d.t.length - lo, limit - count);
    if (take > 0) {
      parts.push({ t: d.t.subarray(lo, lo + take), bid: d.bid.subarray(lo, lo + take), ask: d.ask.subarray(lo, lo + take) });
      count += take;
    }
    if (count >= limit) break;
    day = addDays(day, 1);
  }

  return parts.length ? concatTicks(parts) : emptyTicks();
}

// ------------------------------------------------------------
// NẾN M1 THEO NGÀY
// ------------------------------------------------------------

export async function dayM1(symbol: string, day: string): Promise<Bars> {
  const key = `${symbol}|${day}`;
  const mem = cache.m1.get(key);
  if (mem) return mem;

  const file = cachePath('m1', symbol, day);
  let bars: Bars;

  if (fs.existsSync(file)) {
    const [time, open, high, low, close, volume] = readArrays(file, 6);
    bars = { time, open, high, low, close, volume };
  } else {
    const d = await dayTicks(symbol, day);
    bars = barsFromTicks(d.t, d.bid, 60);
    delete bars.tickStart;
    delete bars.tickEnd;
    if (dayComplete(day)) writeArrays(file, [bars.time, bars.open, bars.high, bars.low, bars.close, bars.volume]);
  }

  remember(cache.m1, key, bars);
  return bars;
}

export async function m1Range(symbol: string, firstDay: string, lastDay: string): Promise<Bars> {
  if (lastDay < firstDay) return emptyBars();
  const parts: Bars[] = [];
  for (const d of daysBetween(firstDay, lastDay)) parts.push(await dayM1(symbol, d));
  return concatBars(parts);
}
