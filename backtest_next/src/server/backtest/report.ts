import { roundTo } from '../market/bars';
import type { OrderRecord, Trade } from './broker';

/** Thống kê kết quả backtest (giờ / ngày theo giờ máy, mặc định +7). */

const r2 = (x: number) => roundTo(x, 2);
const r1 = (x: number) => roundTo(x, 1);
const ratio = (a: number, b: number) => (b ? r2(a / b) : null);
const pad = (n: number) => String(n).padStart(2, '0');

type Group = { key: string; trades: number; wins: number; profit: number; win_rate: number };

export function summarize(
  trades: Trade[],
  initialBalance: number,
  startMs: number,
  endMs: number,
  sessionOffsetHours = 7,
  orders: OrderRecord[] = [],
) {
  const off = sessionOffsetHours * 3600_000;
  const n = trades.length;
  const wins = trades.filter((t) => t.profit >= 0);
  const losses = trades.filter((t) => t.profit < 0);
  const grossWin = wins.reduce((s, t) => s + t.profit, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.profit, 0);
  const net = r2(grossWin - grossLoss);

  // ---------------- Equity / drawdown ----------------
  const equity = [{ time: Math.floor(startMs / 1000), value: r2(initialBalance) }];
  let peak = initialBalance;
  let maxDd = 0;
  let maxDdPct = 0;
  let balance = initialBalance;
  for (const t of trades) {
    balance = t.balance;
    equity.push({ time: Math.floor(t.exit_ms / 1000), value: balance });
    peak = Math.max(peak, balance);
    const dd = peak - balance;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPct = peak ? (dd / peak) * 100 : 0;
    }
  }

  // ---------------- Chuỗi thắng / thua ----------------
  let bestWin = 0, bestLoss = 0, curWin = 0, curLoss = 0;
  for (const t of trades) {
    if (t.profit >= 0) {
      curWin++;
      curLoss = 0;
    } else {
      curLoss++;
      curWin = 0;
    }
    bestWin = Math.max(bestWin, curWin);
    bestLoss = Math.max(bestLoss, curLoss);
  }

  // ---------------- Phân nhóm ----------------
  const group = (keyFn: (t: Trade) => string): Group[] => {
    const m = new Map<string, { trades: number; wins: number; profit: number }>();
    for (const t of trades) {
      const k = keyFn(t);
      const v = m.get(k) || { trades: 0, wins: 0, profit: 0 };
      v.trades++;
      v.wins += t.profit >= 0 ? 1 : 0;
      v.profit = r2(v.profit + t.profit);
      m.set(k, v);
    }
    return [...m.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([key, v]) => ({ key, ...v, win_rate: v.trades ? r1((v.wins / v.trades) * 100) : 0 }));
  };

  const local = (ms: number) => new Date(ms + off);
  const bySide = group((t) => t.side);
  const byExit = group((t) => t.exit_reason);
  const byHour = group((t) => `${pad(local(t.entry_ms).getUTCHours())}h`);
  const byDay = group((t) => local(t.entry_ms).toISOString().slice(0, 10));
  const byLevel = group((t) => (t.level ? `L${t.level}` : '—'));

  const hold = trades.map((t) => (t.exit_ms - t.entry_ms) / 60000);
  const rs = trades.map((t) => t.r).filter((x): x is number => x !== null && x !== undefined);

  const pick = (cmp: (a: Group, b: Group) => boolean) =>
    byHour.length ? byHour.reduce((best, x) => (cmp(x, best) ? x : best)) : null;

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    win_rate: n ? r1((wins.length / n) * 100) : 0,
    net_profit: net,
    gross_profit: r2(grossWin),
    gross_loss: r2(grossLoss),
    profit_factor: ratio(grossWin, grossLoss),
    avg_win: wins.length ? r2(grossWin / wins.length) : 0,
    avg_loss: losses.length ? r2(-grossLoss / losses.length) : 0,
    expectancy: n ? r2(net / n) : 0,
    avg_r: rs.length ? r2(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
    best_trade: n ? Math.max(...trades.map((t) => t.profit)) : 0,
    worst_trade: n ? Math.min(...trades.map((t) => t.profit)) : 0,
    max_drawdown: r2(maxDd),
    max_drawdown_pct: r2(maxDdPct),
    max_consecutive_wins: bestWin,
    max_consecutive_losses: bestLoss,
    avg_hold_minutes: hold.length ? r1(hold.reduce((a, b) => a + b, 0) / hold.length) : 0,
    initial_balance: r2(initialBalance),
    final_balance: r2(balance),
    return_pct: initialBalance ? r2((net / initialBalance) * 100) : 0,
    pending_orders: orders.length,
    pending_filled: orders.filter((o) => o.status === 'FILLED').length,
    pending_cancelled: orders.filter((o) => o.status === 'CANCELLED').length,
    best_hour: pick((a, b) => a.profit > b.profit),
    worst_hour: pick((a, b) => a.profit < b.profit),
    by_side: bySide,
    by_exit: byExit,
    by_hour: byHour,
    by_day: byDay,
    by_level: byLevel,
    equity,
    start_ms: Math.trunc(startMs),
    end_ms: Math.trunc(endMs),
  };
}

export type Summary = ReturnType<typeof summarize>;
