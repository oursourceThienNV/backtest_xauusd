'use client';

import EquityChart from '@/components/EquityChart';
import { cls, fmtMoney, fmtNum } from '@/lib/format';
import type { GroupStat, Summary } from '@/lib/types';
import { EXIT_LABEL } from '@/lib/types';

function Bars({ title, rows, label }: { title: string; rows: GroupStat[]; label?: (k: string) => string }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.profit)));
  return (
    <div className="panel">
      <div className="panel-title">{title}</div>
      {rows.length === 0 && <div className="muted">—</div>}
      {rows.map((r) => (
        <div key={r.key} className="bar-row">
          <span className="bar-key">{label ? label(r.key) : r.key}</span>
          <span className="bar-track">
            <span
              className={cls('bar-fill', r.profit >= 0 ? 'pos' : 'neg')}
              style={{ width: `${(Math.abs(r.profit) / max) * 100}%` }}
            />
          </span>
          <span className={cls('bar-val', r.profit >= 0 ? 'up' : 'down')}>{fmtMoney(r.profit)}</span>
          <span className="bar-meta">{r.trades} lệnh • {r.win_rate}%</span>
        </div>
      ))}
    </div>
  );
}

export default function ReportPanel({ s, color, offsetHours }: { s: Summary; color: string; offsetHours: number }) {
  const metrics: [string, string, string?][] = [
    ['Tổng lệnh', String(s.trades)],
    ['Thắng / Thua', `${s.wins} / ${s.losses}`],
    ['Tỷ lệ thắng', `${s.win_rate}%`],
    ['Lãi / lỗ ròng', fmtMoney(s.net_profit), s.net_profit >= 0 ? 'up' : 'down'],
    ['Lợi nhuận %', `${s.return_pct}%`, s.return_pct >= 0 ? 'up' : 'down'],
    ['Profit factor', fmtNum(s.profit_factor)],
    ['TB lệnh thắng', fmtMoney(s.avg_win), 'up'],
    ['TB lệnh thua', fmtMoney(s.avg_loss), 'down'],
    ['Kỳ vọng / lệnh', fmtMoney(s.expectancy), s.expectancy >= 0 ? 'up' : 'down'],
    ['R trung bình', fmtNum(s.avg_r)],
    ['Sụt giảm tối đa', `${fmtMoney(s.max_drawdown, false)} (${s.max_drawdown_pct}%)`, 'down'],
    ['Chuỗi thắng / thua', `${s.max_consecutive_wins} / ${s.max_consecutive_losses}`],
    ['Lệnh tốt nhất', fmtMoney(s.best_trade), 'up'],
    ['Lệnh tệ nhất', fmtMoney(s.worst_trade), 'down'],
    ['Giữ lệnh TB', `${s.avg_hold_minutes} phút`],
    ['Số dư cuối', fmtMoney(s.final_balance, false)],
  ];

  if (s.pending_orders) {
    metrics.push(['Lệnh chờ đặt / khớp / hủy', `${s.pending_orders} / ${s.pending_filled} / ${s.pending_cancelled}`]);
  }

  return (
    <div className="report">
      <div className="metric-grid">
        {metrics.map(([k, v, c]) => (
          <div key={k}>
            <span>{k}</span>
            <b className={c}>{v}</b>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-title">ĐƯỜNG SỐ DƯ (SAU MỖI LỆNH)</div>
        <EquityChart lines={[{ name: 'Số dư', color, points: s.equity }]} height={230} offsetHours={offsetHours} />
      </div>

      <div className="report-grid">
        <Bars title="THEO CÁCH KẾT THÚC LỆNH" rows={s.by_exit} label={(k) => EXIT_LABEL[k] || k} />
        <Bars title="THEO CHIỀU LỆNH" rows={s.by_side} />
        <Bars title="THEO GIỜ VÀO LỆNH (GIỜ VN)" rows={s.by_hour} />
        <Bars title="THEO NGÀY (GIỜ VN)" rows={s.by_day} />
        {s.by_level.length > 1 && <Bars title="THEO LEVEL LOT" rows={s.by_level} />}
      </div>

      {(s.best_hour || s.worst_hour) && (
        <div className="advice-list">
          {s.best_hour && (
            <div>
              Khung giờ hiệu quả nhất: <b>{s.best_hour.key}</b> ({fmtMoney(s.best_hour.profit)}, {s.best_hour.trades} lệnh,
              thắng {s.best_hour.win_rate}%).
            </div>
          )}
          {s.worst_hour && s.worst_hour.profit < 0 && (
            <div>
              Khung giờ lỗ nhiều nhất: <b>{s.worst_hour.key}</b> ({fmtMoney(s.worst_hour.profit)}, {s.worst_hour.trades} lệnh) —
              cân nhắc tắt giao dịch giờ này bằng khung giờ giao dịch.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
