// Gọi API Next.js trong cùng dự án (src/app/api/**). Mỗi hàm trả về `body` của server.
import { post } from '@/lib/api';
import { ApiUrl } from '@/lib/env';
import type { BacktestResult, Bar, MarketInfo, RunRow, StrategyMeta } from '@/lib/types';

const api = (p: string) => `${ApiUrl.get()}/api${p}`;

export const marketService = {
  info: (body: { symbol?: string } = {}) => post<MarketInfo>(api('/market/info'), body),
  candles: (body: { from_day: string; to_day: string; tf?: string; symbol?: string }) =>
    post<{ candles: Bar[]; symbol: string; tf: string; tf_sec: number }>(api('/market/candles'), body),
  ticks: (body: { from_ms: number; limit?: number; to_ms?: number | null; symbol?: string | null }) => post(api('/market/ticks'), body),
};

export const backtestService = {
  strategies: () => post<{ strategies: StrategyMeta[] }>(api('/strategies')),
  run: (body: { strategy: string; from_day: string; to_day: string; config?: any; label?: string; save?: boolean; symbol?: string }) =>
    post<BacktestResult>(api('/backtest/run'), body),
  compare: <T = any>(body: { from_day: string; to_day: string; strategies: string[]; configs?: any; save?: boolean }) =>
    post<T>(api('/backtest/compare'), body),
  runs: (body: { limit?: number; strategy?: string | null } = {}) => post<{ runs: RunRow[] }>(api('/backtest/runs'), body),
  detail: (id: number, series = true) => post<BacktestResult>(api('/backtest/run-detail'), { id, series }),
  remove: (id: number) => post(api('/backtest/delete'), { id }),
};
