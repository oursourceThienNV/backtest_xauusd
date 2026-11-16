'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import EquityChart from '@/components/EquityChart';
import TopNav from '@/components/TopNav';
import { backtestService, marketService } from '@/services';
import { addDays, cls, fmtMoney, fmtNum, storageGet, storageSet } from '@/lib/format';
import type { MarketInfo, StrategyKey, StrategyMeta, Summary } from '@/lib/types';
import { EXIT_LABEL } from '@/lib/types';

type CompareRun = {
  strategy: StrategyKey;
  strategy_name: string;
  run_id: number | null;
  config: Record<string, any>;
  summary: Summary;
  elapsed_sec: number;
};

type CompareResult = { symbol: string; from_day: string; to_day: string; ticks: number; runs: CompareRun[] };

const ROWS: { label: string; get: (s: Summary) => string; better?: (s: Summary) => number; tone?: (s: Summary) => string }[] = [
  { label: 'Tổng lệnh', get: (s) => String(s.trades) },
  { label: 'Tỷ lệ thắng', get: (s) => `${s.win_rate}%`, better: (s) => s.win_rate },
  { label: 'Lãi / lỗ ròng', get: (s) => fmtMoney(s.net_profit), better: (s) => s.net_profit, tone: (s) => (s.net_profit >= 0 ? 'up' : 'down') },
  { label: 'Lợi nhuận %', get: (s) => `${s.return_pct}%`, better: (s) => s.return_pct, tone: (s) => (s.return_pct >= 0 ? 'up' : 'down') },
  { label: 'Profit factor', get: (s) => fmtNum(s.profit_factor), better: (s) => s.profit_factor ?? 0 },
  { label: 'Kỳ vọng / lệnh', get: (s) => fmtMoney(s.expectancy), better: (s) => s.expectancy },
  { label: 'TB thắng / TB thua', get: (s) => `${fmtMoney(s.avg_win)} / ${fmtMoney(s.avg_loss)}` },
  { label: 'R trung bình', get: (s) => fmtNum(s.avg_r), better: (s) => s.avg_r ?? -99 },
  { label: 'Sụt giảm tối đa', get: (s) => `${fmtMoney(s.max_drawdown, false)} (${s.max_drawdown_pct}%)`, better: (s) => -s.max_drawdown },
  { label: 'Chuỗi thua dài nhất', get: (s) => String(s.max_consecutive_losses), better: (s) => -s.max_consecutive_losses },
  { label: 'Giữ lệnh TB', get: (s) => `${s.avg_hold_minutes} phút` },
  { label: 'Khung giờ tốt nhất', get: (s) => (s.best_hour ? `${s.best_hour.key} (${fmtMoney(s.best_hour.profit)})` : '—') },
  { label: 'Kết thúc lệnh', get: (s) => s.by_exit.map((x) => `${EXIT_LABEL[x.key] || x.key}: ${x.trades}`).join(' • ') || '—' },
];

export default function ComparePage() {
  const router = useRouter();
  const [metas, setMetas] = useState<StrategyMeta[]>([]);
  const [info, setInfo] = useState<MarketInfo | null>(null);
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [selected, setSelected] = useState<StrategyKey[]>(['ma_cross', 'bollinger', 'adx', 'sma_rsi']);
  const [useSaved, setUseSaved] = useState(true);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [s, m] = await Promise.all([
          backtestService.strategies(),
          marketService.info(),
        ]);
        setMetas(s.strategies);
        setInfo(m);
        const last = m.last_day || new Date().toISOString().slice(0, 10);
        setToDay(storageGet('ui:to', last));
        setFromDay(storageGet('ui:from', addDays(last, -6)));
      } catch (e: any) {
        setError(e.message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    setRunning(true);
    setError('');
    storageSet('ui:from', fromDay);
    storageSet('ui:to', toDay);

    const configs: Record<string, any> = {};
    if (useSaved) for (const m of metas) configs[m.key] = storageGet(`cfg:${m.key}`, {});

    try {
      const r = await backtestService.compare<CompareResult>({ from_day: fromDay, to_day: toDay, strategies: selected, configs });
      setResult(r);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  }

  const colorOf = (k: string) => metas.find((m) => m.key === k)?.color || '#94a3b8';

  const bestIndex = (row: (typeof ROWS)[number]) => {
    if (!row.better || !result || result.runs.length < 2) return -1;
    let best = -1;
    let value = -Infinity;
    result.runs.forEach((r, k) => {
      if (!r.summary.trades) return;
      const v = row.better!(r.summary);
      if (v > value) {
        value = v;
        best = k;
      }
    });
    return best;
  };

  return (
    <main className="terminal">
      <TopNav />
      <div className="page-wrap">
        <section className="panel compare-form">
          <div className="panel-title">SO SÁNH 4 PHƯƠNG PHÁP TRÊN CÙNG DỮ LIỆU TICK</div>
          <div className="compare-controls">
            <label>
              Từ ngày
              <input type="date" value={fromDay} min={info?.first_day || undefined} max={info?.last_day || undefined} onChange={(e) => setFromDay(e.target.value)} />
            </label>
            <label>
              Đến ngày
              <input type="date" value={toDay} min={info?.first_day || undefined} max={info?.last_day || undefined} onChange={(e) => setToDay(e.target.value)} />
            </label>
            <div className="compare-methods">
              {metas.map((m) => (
                <label key={m.key} className="check" style={{ color: m.color }}>
                  <input
                    type="checkbox"
                    checked={selected.includes(m.key)}
                    onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, m.key] : prev.filter((x) => x !== m.key)))}
                  />
                  {m.name}
                </label>
              ))}
            </div>
            <label className="check">
              <input type="checkbox" checked={useSaved} onChange={(e) => setUseSaved(e.target.checked)} />
              Dùng cấu hình đã chỉnh ở trang Replay (bỏ chọn = mặc định)
            </label>
            <button className="bot-button" disabled={running || !selected.length || !fromDay || !toDay} onClick={run}>
              {running ? 'ĐANG CHẠY…' : '▶ CHẠY SO SÁNH'}
            </button>
          </div>
          {error && <div className="error">{error}</div>}
        </section>

        {result && (
          <>
            <section className="panel">
              <div className="panel-title">
                KẾT QUẢ {result.from_day} → {result.to_day} • {result.symbol} • {result.ticks.toLocaleString()} tick
              </div>
              <div className="trade-table-wrap">
                <table className="trade-table compare-table">
                  <thead>
                    <tr>
                      <th>CHỈ SỐ</th>
                      {result.runs.map((r) => (
                        <th key={r.strategy} style={{ color: colorOf(r.strategy) }}>{r.strategy_name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ROWS.map((row) => {
                      const best = bestIndex(row);
                      return (
                        <tr key={row.label}>
                          <td className="row-label">{row.label}</td>
                          {result.runs.map((r, k) => (
                            <td key={r.strategy} className={cls(row.tone?.(r.summary), k === best && 'best-cell')}>
                              {row.get(r.summary)}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                    <tr>
                      <td className="row-label">Xem chi tiết</td>
                      {result.runs.map((r) => (
                        <td key={r.strategy}>
                          {r.run_id ? (
                            <button className="recommendation-run" onClick={() => router.push(`/backtest?run=${r.run_id}`)}>
                              Replay + báo cáo →
                            </button>
                          ) : '—'}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="hint">Ô viền xanh = phương pháp tốt nhất ở chỉ số đó.</div>
            </section>

            <section className="panel">
              <div className="panel-title">ĐƯỜNG SỐ DƯ CỦA TỪNG PHƯƠNG PHÁP</div>
              <EquityChart
                height={320}
                lines={result.runs.map((r) => ({ name: r.strategy_name, color: colorOf(r.strategy), points: r.summary.equity }))}
              />
            </section>
          </>
        )}
      </div>
    </main>
  );
}
