import { Broker, type Trade } from './broker';
import type { MarketData } from './data';
import type { Strategy, StrategyClass } from './strategies/base';

/**
 * Vòng lặp backtest theo thời gian thực của thị trường.
 *
 * Bot live chạy vòng lặp 0.5 giây và chỉ dùng NẾN ĐÃ ĐÓNG; nến mới chỉ xuất hiện khi có
 * tick đầu tiên của nó -> bot "thấy" nến vừa đóng ở tick đầu của nến kế tiếp.
 * Với mỗi nến M1 b (đang chạy):
 *   1. Tick đầu của nến b     : xử lý SL/TP/lệnh chờ trước
 *   2. Bot quyết định         : dùng nến đã đóng [0..b-1], Bid/Ask của tick đó
 *   3. Các tick còn lại của b : SL/TP, lệnh chờ, BE/Trailing từng tick.
 *      Lệnh vừa đóng / lệnh chờ hết hạn giữa nến -> bot xét lại ngay ở tick kế tiếp.
 * Khung giờ giao dịch + khóa cuối tuần tính theo giờ máy chạy bot (mặc định +7).
 */

export type LogEvent = { t: number; level: string; cat: string; text: string };

const MAX_EVENTS = 40000;

function parseMinutes(text: any) {
  const m = /^\s*(\d{1,2}):(\d{1,2})\s*$/.exec(String(text ?? ''));
  if (!m) throw new Error('time');
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!(h >= 0 && h < 24 && mi >= 0 && mi < 60)) throw new Error('time');
  return h * 60 + mi;
}

export class BacktestEngine {
  readonly broker: Broker;
  readonly strategy: Strategy;
  readonly events: LogEvent[] = [];
  eventsTruncated = false;

  private lastLog = new Map<string, string>();
  private weekendLogged: number | null = null;
  private offsetMs: number;

  constructor(
    readonly data: MarketData,
    StrategyCls: StrategyClass,
    readonly cfg: Record<string, any>,
    readonly startMs: number,
    readonly endMs: number,
    sessionOffsetHours = 7,
  ) {
    this.offsetMs = sessionOffsetHours * 3600_000;
    this.broker = new Broker(data, cfg, (ms, level, cat, text) => this.log(ms, level, cat, text));
    this.strategy = new StrategyCls(this, cfg).init();

    for (const err of this.broker.configErrors) {
      this.log(this.startMs, 'ERROR', 'CONFIG', `❌ BE/Trailing nhập sai: ${err} | Đã tắt BE/Trailing`);
    }
  }

  // ----------------------------------------------------------
  // LOG (force=false: chỉ ghi khi nội dung nhóm thay đổi)
  // ----------------------------------------------------------

  log(ms: number, level: string, category: string, text: string, force = true) {
    if (!force && this.lastLog.get(category) === text) return;
    this.lastLog.set(category, text);
    if (this.events.length >= MAX_EVENTS) {
      this.eventsTruncated = true;
      return;
    }
    this.events.push({ t: ms, level, cat: category, text });
  }

  // ----------------------------------------------------------
  // GIỜ MÁY
  // ----------------------------------------------------------

  private local(ms: number) {
    return new Date(ms + this.offsetMs);
  }

  inTradingTime(ms: number) {
    if (!this.cfg.trading_time_enabled) return true;
    let start: number;
    let end: number;
    try {
      start = parseMinutes(this.cfg.trading_time_from ?? '06:00');
      end = parseMinutes(this.cfg.trading_time_to ?? '12:00');
    } catch {
      return false;
    }
    const d = this.local(ms);
    const cur = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (start === end) return true;
    if (start < end) return start <= cur && cur < end;
    return cur >= start || cur < end;
  }

  /** Từ 00:01 thứ 7 tới hết chủ nhật (giờ máy). */
  weekendLocked(ms: number) {
    if (!this.cfg.friday_lock) return false;
    const d = this.local(ms);
    const wd = d.getUTCDay(); // 0 = CN, 6 = T7
    if (wd === 6) return d.getUTCHours() > 0 || d.getUTCMinutes() >= 1;
    return wd === 0;
  }

  // ----------------------------------------------------------
  // CHẠY
  // ----------------------------------------------------------

  run() {
    const { m1, t } = this.data;
    if (!t.length) return this;

    const startSec = Math.floor(this.startMs / 1000);

    for (let b = 0; b < m1.time.length; b++) {
      if (m1.tickStart[b] < 0 || m1.time[b] < startSec) continue;
      const s = m1.tickStart[b];
      const e = m1.tickEnd[b];
      if (t[s] >= this.endMs) break;

      this.handle(s, s + 1, b);
      this.decide(s, b);
      this.handle(s + 1, e, b);
    }

    const last = t.length - 1;
    if (this.broker.pending) this.broker.cancelPending(last, 'Hết dữ liệu backtest');
    if (this.broker.position) {
      const trade = this.broker.close(last, 'END');
      this.strategy.onClosed(trade);
    }
    return this;
  }

  private decide(i: number, b: number) {
    const ms = this.data.t[i];
    const broker = this.broker;

    if (this.weekendLocked(ms)) {
      const week = Math.floor(((ms + this.offsetMs) / 86_400_000 + 3) / 7);
      if (broker.pending) broker.cancelPending(i, 'Khóa lệnh cuối tuần');
      if (broker.position) {
        const trade = broker.close(i, 'WEEKEND');
        this.strategy.onClosed(trade);
      }
      if (this.weekendLogged !== week) {
        this.weekendLogged = week;
        this.log(ms, 'WARN', 'WEEKEND', '🔒 WEEKEND LOCK | 00:01 Thứ 7 (giờ máy) -> đóng toàn bộ lệnh, nghỉ tới thứ 2');
      }
      return;
    }

    this.strategy.decide(i, b, this.inTradingTime(ms));
  }

  private handle(a: number, e: number, b: number) {
    let p = a;
    while (p < e) {
      const ev = this.broker.process(p, e);
      if (!ev) return;
      const [kind, i] = ev;

      if (kind === 'closed') this.strategy.onClosed(this.broker.trades[this.broker.trades.length - 1] as Trade);
      else if (kind === 'filled') this.strategy.onFilled();
      else if (kind === 'expired') this.strategy.onExpired();

      p = i + 1;
      if ((kind === 'closed' || kind === 'expired') && p < e) {
        this.decide(p, b);
        p += 1;
      }
    }
  }
}
