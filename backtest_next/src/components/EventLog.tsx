'use client';

import { useMemo, useState } from 'react';
import { cls, fmtTime } from '@/lib/format';
import type { LogEvent } from '@/lib/types';

const FILTERS: { key: string; label: string; test: (e: LogEvent) => boolean }[] = [
  { key: 'all', label: 'Tất cả', test: () => true },
  { key: 'trade', label: 'Lệnh', test: (e) => e.level === 'TRADE' || e.cat === 'CANCEL' || e.cat === 'SLMOVE' },
  { key: 'signal', label: 'Tín hiệu', test: (e) => ['SIGNAL', 'ARM', 'LOOP', 'H1', 'ADX', 'PASS', 'JK', 'EXIT'].includes(e.cat) },
  { key: 'block', label: 'Bị chặn', test: (e) => e.level === 'WARN' || e.level === 'ERROR' },
];

const MAX_ROWS = 300;

export default function EventLog({
  events,
  upto,
  offsetHours,
  onJump,
}: {
  events: LogEvent[];
  upto: number;            // số sự kiện đã xảy ra tới thời điểm replay
  offsetHours: number;
  onJump: (ms: number) => void;
}) {
  const [filter, setFilter] = useState('all');

  const rows = useMemo(() => {
    const test = FILTERS.find((f) => f.key === filter)!.test;
    const out: LogEvent[] = [];
    for (let k = Math.min(upto, events.length) - 1; k >= 0 && out.length < MAX_ROWS; k--) {
      if (test(events[k])) out.push(events[k]);
    }
    return out;
  }, [events, upto, filter]);

  return (
    <div className="panel event-panel">
      <div className="panel-head">
        <div className="panel-title">NHẬT KÝ BOT (THEO THỜI GIAN REPLAY)</div>
        <div className="filter-tabs">
          {FILTERS.map((f) => (
            <button key={f.key} className={cls(filter === f.key && 'active')} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="event-list">
        {rows.length === 0 && <div className="muted pad">Chưa có sự kiện tới thời điểm này.</div>}
        {rows.map((e, k) => (
          <div key={`${e.t}-${k}`} className={cls('event-row', `lv-${e.level.toLowerCase()}`)} onClick={() => onJump(e.t)}>
            <span className="event-time">{fmtTime(e.t, offsetHours)}</span>
            <span className="event-text">{e.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
