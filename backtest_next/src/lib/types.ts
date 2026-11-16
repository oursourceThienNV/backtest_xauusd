export type StrategyKey = 'ma_cross' | 'bollinger' | 'adx' | 'sma_rsi';

export type FieldType = 'number' | 'bool' | 'select' | 'time' | 'lots';

export type StrategyField = {
  key: string;
  label: string;
  type: FieldType;
  default: any;
  group: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  help?: string;
  show_if?: string;
};

export type StrategyMeta = {
  key: StrategyKey;
  name: string;
  color: string;
  timeframes: string;
  summary: string;
  steps: string[];
  fields: StrategyField[];
  presets: Record<string, { label: string; values: Record<string, any> }>;
  defaults: Record<string, any>;
};

export type Bar = { time: number; open: number; high: number; low: number; close: number; volume?: number };

export type SeriesDef = {
  id: string;
  name: string;
  tf: string;            // 'M1' | 'M15' | 'H1' | 'ANY'
  pane: number;          // 0 = chart giá, 1 = khung dưới
  color: string;
  step?: boolean;
  levels?: number[];
  data: { time: number; value: number }[];
};

export type Trade = {
  id: number;
  side: 'BUY' | 'SELL';
  lot: number;
  level: number | null;
  entry_ms: number;
  entry: number;
  sl: number;
  sl_final: number;
  tp: number;
  exit_ms: number;
  exit: number;
  exit_reason: string;
  points: number;
  pips: number;
  r: number | null;
  profit: number;
  result: 'WIN' | 'LOSS';
  mfe: number;
  mae: number;
  balance: number;
  reason: string;
  meta: Record<string, any>;
  sl_moves: { ms: number; sl: number; kind: string }[];
};

export type PendingOrder = {
  id: number;
  type: string;
  side: 'BUY' | 'SELL';
  price: number;
  sl: number;
  tp: number;
  lot: number;
  placed_ms: number;
  end_ms: number;
  status: 'FILLED' | 'CANCELLED';
  note: string;
};

export type LogEvent = { t: number; level: string; cat: string; text: string };

export type GroupStat = { key: string; trades: number; wins: number; profit: number; win_rate: number };

export type Summary = {
  trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  net_profit: number;
  gross_profit: number;
  gross_loss: number;
  profit_factor: number | null;
  avg_win: number;
  avg_loss: number;
  expectancy: number;
  avg_r: number | null;
  best_trade: number;
  worst_trade: number;
  max_drawdown: number;
  max_drawdown_pct: number;
  max_consecutive_wins: number;
  max_consecutive_losses: number;
  avg_hold_minutes: number;
  initial_balance: number;
  final_balance: number;
  return_pct: number;
  pending_orders: number;
  pending_filled: number;
  pending_cancelled: number;
  best_hour: GroupStat | null;
  worst_hour: GroupStat | null;
  by_side: GroupStat[];
  by_exit: GroupStat[];
  by_hour: GroupStat[];
  by_day: GroupStat[];
  by_level: GroupStat[];
  equity: { time: number; value: number }[];
  start_ms: number;
  end_ms: number;
};

export type BacktestResult = {
  run_id?: number;
  strategy: StrategyKey;
  strategy_name: string;
  symbol: string;
  from_day: string;
  to_day: string;
  label?: string | null;
  config: Record<string, any>;
  summary: Summary;
  trades: Trade[];
  orders: PendingOrder[];
  events: LogEvent[];
  events_truncated?: boolean;
  ticks?: number;
  elapsed_sec?: number;
  series?: SeriesDef[];
};

export type MarketInfo = {
  symbol: string;
  digits: number;
  contract_size: number;
  session_tz_offset_hours: number;
  first_day: string | null;
  last_day: string | null;
  days: { day: string; ticks: number | null; status: string }[];
  max_backtest_days: number;
};

export type RunRow = {
  id: number;
  strategy: StrategyKey;
  strategy_name: string;
  symbol: string;
  from_day: string;
  to_day: string;
  label: string | null;
  created_at: string;
  trades: number;
  win_rate: number;
  net_profit: number;
  profit_factor: number | null;
  max_drawdown: number;
  return_pct: number;
};

export const TIMEFRAMES: Record<string, number> = { M1: 60, M5: 300, M15: 900, H1: 3600 };

export const EXIT_LABEL: Record<string, string> = {
  TP: 'Chạm TP',
  SL: 'Chạm SL',
  BE: 'Hòa vốn',
  TRAIL: 'Trailing',
  RSI_EXIT: 'Chốt theo RSI',
  WEEKEND: 'Khóa cuối tuần',
  END: 'Hết dữ liệu',
};
