import 'server-only';
import { settings } from './config';
import { badRequest, notFound } from './http';
import { TIMEFRAMES, aggregate, barsToJson, lowerBound } from './market/bars';
import { availableDays, daysBetween, m1Range, resolveSymbol, ticksFrom } from './market/ticks';
import { loadFor, rangeMs, runOne, seriesOnly } from './backtest/runner';
import { STRATEGIES, isStrategy, metadata } from './backtest/strategies';
import { deleteRun, getRun, listRuns, saveRun } from './runs';

/** Toàn bộ nghiệp vụ phía server; route handler trong app/api chỉ gọi vào đây. */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

async function symbolOf(prefix?: string | null) {
  try {
    return await resolveSymbol(prefix);
  } catch (e: any) {
    if (String(e?.message || '').startsWith('Không có tick')) throw notFound(e.message);
    throw e;
  }
}

function checkRange(fromDay: any, toDay: any): [string, string] {
  if (!DAY_RE.test(String(fromDay)) || !DAY_RE.test(String(toDay))) throw badRequest('Ngày không hợp lệ (YYYY-MM-DD)');
  if (fromDay > toDay) throw badRequest('Ngày bắt đầu phải trước ngày kết thúc');
  if (daysBetween(fromDay, toDay).length > settings.maxBacktestDays) {
    throw badRequest(`Tối đa ${settings.maxBacktestDays} ngày mỗi lần chạy`);
  }
  return [fromDay, toDay];
}

// ============================================================
// MARKET
// ============================================================

export async function marketInfo(body: { symbol?: string }) {
  const symbol = await symbolOf(body.symbol);
  const days = await availableDays(symbol);
  const trading = days.filter((d) => d.ticks === null || d.ticks > 0);
  return {
    symbol,
    digits: settings.priceDigits,
    contract_size: settings.contractSize,
    session_tz_offset_hours: settings.sessionTzOffsetHours,
    first_day: trading[0]?.day ?? null,
    last_day: trading[trading.length - 1]?.day ?? null,
    days,
    max_backtest_days: settings.maxBacktestDays,
  };
}

/** Nến dựng từ tick (theo BID, giống chart MT5) cho cả khoảng ngày. */
export async function marketCandles(body: { from_day: string; to_day: string; tf?: string; symbol?: string }) {
  const [fromDay, toDay] = checkRange(body.from_day, body.to_day);
  const tf = String(body.tf || 'M1').toUpperCase();
  if (!(tf in TIMEFRAMES)) throw badRequest(`Khung không hỗ trợ: ${tf}`);

  const symbol = await symbolOf(body.symbol);
  const m1 = await m1Range(symbol, fromDay, toDay);
  const bars = tf === 'M1' ? m1 : aggregate(m1, TIMEFRAMES[tf]);
  return { symbol, tf, tf_sec: TIMEFRAMES[tf], candles: barsToJson(bars, settings.priceDigits) };
}

/**
 * Tick cho replay: `limit` tick đầu tiên có time >= from_ms.
 * Nén gọn: t = t0 + cumsum(dt) (ms) ; bid = base + b/scale ; ask = bid + s/scale.
 */
export async function marketTicks(body: { from_ms: number; limit?: number; to_ms?: number | null; symbol?: string }) {
  const fromMs = Number(body.from_ms);
  if (!Number.isFinite(fromMs)) throw badRequest('from_ms không hợp lệ');
  const limit = Math.min(Math.max(Math.trunc(Number(body.limit) || 20000), 1), 100000);

  const symbol = await symbolOf(body.symbol);
  let { t, bid, ask } = await ticksFrom(symbol, fromMs, limit);

  if (body.to_ms !== undefined && body.to_ms !== null && t.length) {
    const k = lowerBound(t, Number(body.to_ms));
    t = t.subarray(0, k);
    bid = bid.subarray(0, k);
    ask = ask.subarray(0, k);
  }

  const n = t.length;
  if (!n) return { symbol, count: 0, t0: null, dt: [], base: null, scale: null, b: [], s: [], last_ms: null };

  const scale = 10 ** settings.priceDigits;
  const base = Math.round(bid[0] * scale) / scale;
  const dt = new Array<number>(n);
  const b = new Array<number>(n);
  const s = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    dt[i] = i ? t[i] - t[i - 1] : 0;
    b[i] = Math.round((bid[i] - base) * scale);
    s[i] = Math.round((ask[i] - bid[i]) * scale);
  }
  return { symbol, count: n, t0: t[0], dt, base, scale, b, s, last_ms: t[n - 1] };
}

// ============================================================
// BACKTEST
// ============================================================

export const strategies = () => ({ strategies: metadata() });

type RunBody = { strategy: string; symbol?: string; from_day: string; to_day: string; config?: Record<string, any>; label?: string; save?: boolean };

export async function backtestRun(body: RunBody) {
  if (!isStrategy(body.strategy)) throw badRequest(`Phương pháp không tồn tại: ${body.strategy}`);
  const [fromDay, toDay] = checkRange(body.from_day, body.to_day);

  const symbol = await symbolOf(body.symbol);
  const data = await loadFor(symbol, fromDay, toDay, [body.strategy]);
  if (!data.t.length) throw notFound('Không có tick trong khoảng ngày đã chọn');

  const [startMs, endMs] = rangeMs(fromDay, toDay);
  const result = runOne(data, body.strategy, body.config || {}, startMs, endMs);
  const runId = body.save !== false ? await saveRun(result, fromDay, toDay, body.label) : null;
  return { ...result, from_day: fromDay, to_day: toDay, run_id: runId };
}

type CompareBody = { symbol?: string; from_day: string; to_day: string; strategies?: string[]; configs?: Record<string, Record<string, any>>; save?: boolean };

export async function backtestCompare(body: CompareBody) {
  const keys = (body.strategies || Object.keys(STRATEGIES)).filter(isStrategy);
  if (!keys.length) throw badRequest('Chưa chọn phương pháp');
  const [fromDay, toDay] = checkRange(body.from_day, body.to_day);

  const symbol = await symbolOf(body.symbol);
  const data = await loadFor(symbol, fromDay, toDay, keys);
  if (!data.t.length) throw notFound('Không có tick trong khoảng ngày đã chọn');

  const [startMs, endMs] = rangeMs(fromDay, toDay);
  const runs = [];
  for (const key of keys) {
    const result = runOne(data, key, body.configs?.[key] || {}, startMs, endMs, false);
    const runId = body.save !== false ? await saveRun(result, fromDay, toDay, 'So sánh') : null;
    runs.push({
      strategy: key,
      strategy_name: result.strategy_name,
      run_id: runId,
      config: result.config,
      summary: result.summary,
      elapsed_sec: result.elapsed_sec,
    });
  }
  return { symbol, from_day: fromDay, to_day: toDay, ticks: data.t.length, runs };
}

export async function runsList(body: { limit?: number; strategy?: string | null }) {
  return { runs: await listRuns(body.limit ?? 100, body.strategy || null) };
}

export async function runDetail(body: { id: number; series?: boolean }) {
  const id = Math.trunc(Number(body.id));
  const run = id > 0 ? await getRun(id) : null;
  if (!run) throw notFound('Không tìm thấy lần chạy');

  let series: any[] | undefined;
  if (body.series !== false && isStrategy(run.strategy)) {
    const data = await loadFor(run.symbol, run.from_day, run.to_day, [run.strategy]);
    const [startMs, endMs] = rangeMs(run.from_day, run.to_day);
    series = seriesOnly(data, run.strategy, run.config, startMs, endMs);
  }
  return { ...run, series };
}

export async function runDelete(body: { id: number }) {
  const id = Math.trunc(Number(body.id));
  if (!(id > 0) || !(await deleteRun(id))) throw notFound('Không tìm thấy lần chạy');
  return { deleted: id };
}
