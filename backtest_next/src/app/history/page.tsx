'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import TopNav from '@/components/TopNav';
import { backtestService } from '@/services';
import { fmtMoney, fmtNum } from '@/lib/format';
import type { RunRow } from '@/lib/types';

const FILTERS = [
  { key: '', label: 'Tất cả' },
  { key: 'ma_cross', label: 'MA Cross' },
  { key: 'bollinger', label: 'Bollinger' },
  { key: 'adx', label: 'ADX' },
  { key: 'sma_rsi', label: 'SMA20 + RSI' },
];

export default function HistoryPage() {
  const router = useRouter();
  const [rows, setRows] = useState<RunRow[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load(strategy: string) {
    setLoading(true);
    setError('');
    try {
      const r = await backtestService.runs({ strategy: strategy || null, limit: 200 });
      setRows(r.runs);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function remove(id: number) {
    if (!window.confirm(`Xóa lần chạy #${id}?`)) return;
    try {
      await backtestService.remove(id);
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <main className="terminal">
      <TopNav />
      <div className="page-wrap">
        <section className="panel">
          <div className="panel-head">
            <div className="panel-title">LỊCH SỬ CÁC LẦN CHẠY BACKTEST</div>
            <div className="filter-tabs">
              {FILTERS.map((f) => (
                <button key={f.key} className={filter === f.key ? 'active' : ''} onClick={() => setFilter(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          {error && <div className="error">{error}</div>}
          <div className="trade-table-wrap">
            <table className="trade-table">
              <thead>
                <tr>
                  <th>#</th><th>PHƯƠNG PHÁP</th><th>KHOẢNG NGÀY</th><th>GHI CHÚ</th><th>LỆNH</th><th>THẮNG</th>
                  <th>LÃI/LỖ</th><th>LỢI NHUẬN</th><th>PF</th><th>SỤT GIẢM</th><th>CHẠY LÚC</th><th></th>
                </tr>
              </thead>
              <tbody>
                {!loading && rows.length === 0 && (
                  <tr><td className="empty-table" colSpan={12}>Chưa có lần chạy nào</td></tr>
                )}
                {rows.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => router.push(`/backtest?run=${r.id}`)}>
                    <td>{r.id}</td>
                    <td>{r.strategy_name}</td>
                    <td>{r.from_day} → {r.to_day}</td>
                    <td>{r.label || ''}</td>
                    <td>{r.trades}</td>
                    <td>{r.win_rate}%</td>
                    <td className={r.net_profit >= 0 ? 'up' : 'down'}>{fmtMoney(r.net_profit)}</td>
                    <td className={r.return_pct >= 0 ? 'up' : 'down'}>{r.return_pct}%</td>
                    <td>{fmtNum(r.profit_factor)}</td>
                    <td className="down">{fmtMoney(r.max_drawdown, false)}</td>
                    <td>{new Date(r.created_at).toLocaleString('vi-VN')}</td>
                    <td>
                      <button className="ghost small" onClick={(e) => { e.stopPropagation(); remove(r.id); }}>Xóa</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
