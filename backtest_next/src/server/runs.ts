import 'server-only';
import { exec, one, query } from './db';
import { STRATEGIES } from './backtest/strategies';
import type { RunResult } from './backtest/runner';

/**
 * Lưu lần chạy backtest vào bảng backtest_runs (cùng DB với tick).
 * Bảng tự tạo nếu chưa có (không khóa ngoại). user_id = 0 (dự án không có đăng nhập).
 */

let ready: Promise<void> | null = null;

function ensureTable() {
  if (!ready) {
    ready = exec(`CREATE TABLE IF NOT EXISTS backtest_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
      strategy VARCHAR(32) NOT NULL,
      symbol VARCHAR(32) NOT NULL,
      from_day DATE NOT NULL,
      to_day DATE NOT NULL,
      label VARCHAR(120) NULL,
      config JSON NOT NULL,
      summary JSON NOT NULL,
      result LONGTEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY ix_backtest_runs_user_id (user_id),
      KEY ix_backtest_runs_strategy (strategy),
      KEY ix_backtest_runs_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).then(
      () => undefined,
      (e) => {
        ready = null;
        throw e;
      },
    );
  }
  return ready;
}

const parse = (v: any) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

const created = (v: any) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v).replace(' ', 'T') + 'Z';
};

export async function saveRun(result: RunResult, fromDay: string, toDay: string, label?: string | null) {
  await ensureTable();
  const payload = {
    trades: result.trades,
    orders: result.orders,
    events: result.events,
    events_truncated: result.events_truncated,
    ticks: result.ticks,
    elapsed_sec: result.elapsed_sec,
  };
  const res = await exec(
    'INSERT INTO backtest_runs (user_id, strategy, symbol, from_day, to_day, label, config, summary, result, created_at) ' +
      'VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
    [result.strategy, result.symbol, fromDay, toDay, label || null, JSON.stringify(result.config), JSON.stringify(result.summary), JSON.stringify(payload)],
  );
  return res.insertId;
}

export async function listRuns(limit = 100, strategy?: string | null) {
  await ensureTable();
  const lim = Math.min(Math.max(Math.trunc(Number(limit) || 100), 1), 500);
  const rows = strategy
    ? await query<any>('SELECT id, strategy, symbol, from_day, to_day, label, summary, created_at FROM backtest_runs WHERE strategy = ? ORDER BY id DESC LIMIT ?', [strategy, lim])
    : await query<any>('SELECT id, strategy, symbol, from_day, to_day, label, summary, created_at FROM backtest_runs ORDER BY id DESC LIMIT ?', [lim]);

  return rows.map((r) => {
    const s = parse(r.summary) || {};
    return {
      id: Number(r.id),
      strategy: r.strategy,
      strategy_name: STRATEGIES[r.strategy]?.name ?? r.strategy,
      symbol: r.symbol,
      from_day: String(r.from_day),
      to_day: String(r.to_day),
      label: r.label,
      created_at: created(r.created_at),
      trades: s.trades,
      win_rate: s.win_rate,
      net_profit: s.net_profit,
      profit_factor: s.profit_factor,
      max_drawdown: s.max_drawdown,
      return_pct: s.return_pct,
    };
  });
}

export async function getRun(id: number) {
  await ensureTable();
  const r = await one<any>('SELECT * FROM backtest_runs WHERE id = ?', [id]);
  if (!r) return null;
  return {
    run_id: Number(r.id),
    strategy: r.strategy as string,
    strategy_name: STRATEGIES[r.strategy]?.name ?? r.strategy,
    symbol: r.symbol as string,
    from_day: String(r.from_day),
    to_day: String(r.to_day),
    label: r.label,
    config: parse(r.config) || {},
    summary: parse(r.summary) || {},
    ...(parse(r.result) || {}),
  };
}

export async function deleteRun(id: number) {
  await ensureTable();
  const res = await exec('DELETE FROM backtest_runs WHERE id = ?', [id]);
  return res.affectedRows > 0;
}
