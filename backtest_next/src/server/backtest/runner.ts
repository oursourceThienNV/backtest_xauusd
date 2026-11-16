import 'server-only';

import { settings } from '../config';
import { addDays, dayStartMs, m1Range, ticksRange } from '../market/ticks';
import { MarketData } from './data';
import { BacktestEngine } from './engine';
import { summarize } from './report';
import { STRATEGIES, mergedConfig } from './strategies';

/** Khoảng ms của [fromDay 00:00, toDay 24:00) giờ MT5. */
export const rangeMs = (fromDay: string, toDay: string): [number, number] => [dayStartMs(fromDay), dayStartMs(addDays(toDay, 1))];

/** Tick khoảng backtest + nến M1 warmup (đủ ngày cho phương pháp cần nhiều nhất). */
export async function loadFor(symbol: string, fromDay: string, toDay: string, keys: string[]) {
  const warmup = Math.max(...keys.map((k) => STRATEGIES[k].warmup_days));
  const [startMs, endMs] = rangeMs(fromDay, toDay);
  const ticks = await ticksRange(symbol, startMs, endMs);
  const warm = await m1Range(symbol, addDays(fromDay, -warmup), addDays(fromDay, -1));
  return new MarketData(symbol, ticks.t, ticks.bid, ticks.ask, warm, settings.priceDigits, settings.contractSize);
}

export function runOne(data: MarketData, key: string, cfgIn: Record<string, any>, startMs: number, endMs: number, withSeries = true) {
  const spec = STRATEGIES[key];
  const cfg = mergedConfig(key, cfgIn);
  const began = Date.now();

  const engine = new BacktestEngine(data, spec.cls, cfg, startMs, endMs, settings.sessionTzOffsetHours).run();
  const broker = engine.broker;
  const summary = summarize(broker.trades, broker.initialBalance, startMs, endMs, settings.sessionTzOffsetHours, broker.orders);

  return {
    strategy: key,
    strategy_name: spec.name,
    symbol: data.symbol,
    config: cfg,
    summary,
    trades: broker.trades,
    orders: broker.orders,
    events: engine.events,
    events_truncated: engine.eventsTruncated,
    ticks: data.t.length,
    elapsed_sec: Math.round((Date.now() - began) / 10) / 100,
    series: withSeries ? engine.strategy.series() : undefined,
  };
}

export type RunResult = ReturnType<typeof runOne>;

/** Chỉ tính đường chỉ báo (xem lại lần chạy đã lưu). */
export function seriesOnly(data: MarketData, key: string, cfg: Record<string, any>, startMs: number, endMs: number) {
  const spec = STRATEGIES[key];
  const engine = new BacktestEngine(data, spec.cls, mergedConfig(key, cfg), startMs, endMs, settings.sessionTzOffsetHours);
  return engine.strategy.series();
}
