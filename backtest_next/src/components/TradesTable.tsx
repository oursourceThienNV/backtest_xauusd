'use client';

import { cls, fmtDuration, fmtMoney, fmtNum, fmtTime } from '@/lib/format';
import type { Trade } from '@/lib/types';
import { EXIT_LABEL } from '@/lib/types';

export default function TradesTable({
  trades,
  digits,
  offsetHours,
  activeId,
  visibleUntil,
  onJump,
}: {
  trades: Trade[];
  digits: number;
  offsetHours: number;
  activeId?: number | null;
  visibleUntil?: number | null;
  onJump: (t: Trade) => void;
}) {
  return (
    <div className="trade-table-wrap">
      <table className="trade-table">
        <thead>
          <tr>
            <th>#</th>
            <th>LỆNH</th>
            <th>LOT</th>
            <th>VÀO LÚC</th>
            <th>GIÁ VÀO</th>
            <th>SL</th>
            <th>TP</th>
            <th>ĐÓNG LÚC</th>
            <th>GIÁ ĐÓNG</th>
            <th>KẾT THÚC</th>
            <th>THỜI GIAN</th>
            <th>PIP</th>
            <th>R</th>
            <th>MFE / MAE</th>
            <th>P/L</th>
            <th>SỐ DƯ</th>
          </tr>
        </thead>
        <tbody>
          {trades.length === 0 && (
            <tr>
              <td className="empty-table" colSpan={16}>Chưa có lệnh nào</td>
            </tr>
          )}
          {trades.map((t) => {
            const future = visibleUntil !== null && visibleUntil !== undefined && t.entry_ms > visibleUntil;
            return (
              <tr
                key={t.id}
                className={cls('clickable', activeId === t.id && 'active-row', future && 'future-row')}
                onClick={() => onJump(t)}
                title={t.reason}
              >
                <td>{t.id}</td>
                <td className={t.side === 'BUY' ? 'buy' : 'sell'}>{t.side}</td>
                <td>{t.lot}{t.level ? ` (L${t.level})` : ''}</td>
                <td>{fmtTime(t.entry_ms, offsetHours)}</td>
                <td>{t.entry.toFixed(digits)}</td>
                <td>{t.sl.toFixed(digits)}{t.sl_final !== t.sl ? ` → ${t.sl_final.toFixed(digits)}` : ''}</td>
                <td>{t.tp.toFixed(digits)}</td>
                <td>{fmtTime(t.exit_ms, offsetHours)}</td>
                <td>{t.exit.toFixed(digits)}</td>
                <td>
                  <span className={cls('result', t.profit >= 0 ? 'win' : 'loss')}>{EXIT_LABEL[t.exit_reason] || t.exit_reason}</span>
                </td>
                <td>{fmtDuration(t.exit_ms - t.entry_ms)}</td>
                <td className={t.pips >= 0 ? 'up' : 'down'}>{t.pips.toFixed(1)}</td>
                <td>{fmtNum(t.r)}</td>
                <td>{fmtNum(t.mfe)} / {fmtNum(t.mae)}</td>
                <td className={t.profit >= 0 ? 'up' : 'down'}>{fmtMoney(t.profit)}</td>
                <td>{fmtMoney(t.balance, false)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
