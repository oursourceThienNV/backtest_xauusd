import type { ChartHandle, ChartLine, ChartMarker } from '@/components/ReplayChart';
import { TickFeed } from './tickFeed';
import type { BacktestResult, Bar, PendingOrder, SeriesDef, Trade } from './types';

/**
 * Phát lại thị trường từ TICK THẬT:
 *   - Thời gian replay chạy theo đồng hồ × tốc độ, áp từng tick đúng thứ tự.
 *   - Nến hiện tại được dựng dần từ tick (Open/High/Low/Close nhảy theo giá thật),
 *     nến đóng khi tick đầu của nến kế tiếp xuất hiện — giống chart MT5.
 *   - Lệnh, SL/TP (kể cả SL dời theo BE/Trailing), lệnh chờ, log của bot
 *     hiện đúng thời điểm chúng xảy ra.
 */

export type ReplayState = {
  simMs: number;
  playing: boolean;
  speed: number;
  loading: boolean;
  ended: boolean;
  bid: number | null;
  ask: number | null;
  balance: number;
  floating: number;
  openTrade: Trade | null;
  openSl: number | null;
  pending: PendingOrder | null;
  closedTrades: number;
  eventIndex: number;
  progress: number;
};

const GAP_JUMP_MS = 120_000;      // không có tick > 2 phút (cuối tuần...) -> nhảy tới tick kế
const NOTIFY_MS = 120;
const PRE_SEEK_MS = 5 * 60_000;

function lowerBound(arr: number[], value: number) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo; // số phần tử <= value
}

export class Replayer {
  simMs: number;
  playing = false;
  speed = 60;
  loading = false;

  private feed: TickFeed;
  private forming: Bar | null = null;
  private bid: number | null = null;
  private ask: number | null = null;
  private raf = 0;
  private lastFrame = 0;
  private lastNotify = 0;
  private markerKey = '';
  private seekToken = 0;

  private trades: Trade[];
  private entryMs: number[];
  private exitMs: number[];
  private balanceAfter: number[];
  private orders: PendingOrder[];
  private eventMs: number[];
  private candleTimes: number[];

  constructor(
    private chart: ChartHandle,
    private opts: {
      symbol?: string;
      tfName: string;
      tfSec: number;
      candles: Bar[];
      startMs: number;
      endMs: number;
      contractSize: number;
      digits: number;
      result: BacktestResult | null;
      series: SeriesDef[];
      onUpdate: (s: ReplayState) => void;
    },
  ) {
    this.simMs = opts.startMs;
    this.feed = new TickFeed(opts.symbol, opts.endMs);

    const r = opts.result;
    this.trades = r ? [...r.trades].sort((a, b) => a.entry_ms - b.entry_ms) : [];
    this.entryMs = this.trades.map((t) => t.entry_ms);
    this.exitMs = this.trades.map((t) => t.exit_ms);
    this.balanceAfter = this.trades.map((t) => t.balance);
    this.orders = r ? [...r.orders].sort((a, b) => a.placed_ms - b.placed_ms) : [];
    this.eventMs = r ? r.events.map((e) => e.t) : [];
    this.candleTimes = opts.candles.map((c) => c.time);
  }

  destroy() {
    this.pause();
    this.seekToken += 1;
  }

  // ----------------------------------------------------------
  // ĐIỀU KHIỂN
  // ----------------------------------------------------------

  play() {
    if (this.playing) return;
    if (this.simMs >= this.opts.endMs - 1) return;
    this.playing = true;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    this.notify(true);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.notify(true);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  setSpeed(speed: number) {
    this.speed = speed;
    this.notify(true);
  }

  async seek(ms: number) {
    const token = ++this.seekToken;
    const wasPlaying = this.playing;
    this.playing = false;
    cancelAnimationFrame(this.raf);

    const { tfSec, startMs, endMs } = this.opts;
    ms = Math.max(startMs, Math.min(ms, endMs - 1));

    this.loading = true;
    this.notify(true);

    const formingOpen = Math.floor(ms / 1000 / tfSec) * tfSec;
    const closedCount = lowerBound(this.candleTimes, formingOpen - 1);
    const closed = this.opts.candles.slice(0, closedCount);

    // Nạp thêm vài phút trước nến hiện tại để có Bid/Ask gần nhất
    // (trường hợp nến hiện tại chưa có tick nào tới thời điểm ms).
    await this.feed.reset(formingOpen * 1000 - PRE_SEEK_MS);
    if (token !== this.seekToken) return;

    this.forming = null;
    this.bid = null;
    this.ask = null;

    const f = this.feed;
    while (f.head < f.t.length && f.t[f.head] < formingOpen * 1000) {
      this.bid = f.bid[f.head];
      this.ask = f.ask[f.head];
      f.head++;
    }

    // Dựng nến đang chạy từ tick, tới đúng thời điểm ms
    while (true) {
      this.consumeUntil(ms, false);
      const next = this.feed.peekTime();
      if (next !== null || this.feed.ended) break;
      await this.feed.fetchMore();
      if (token !== this.seekToken) return;
    }

    // Không có tick trong nến này (đang ở khoảng nghỉ) -> nến trước là nến cuối
    this.chart.reset(closed, this.forming);
    const minSec = this.opts.candles.length ? this.opts.candles[0].time : 0;
    this.chart.setIndicators(this.opts.series, this.opts.tfName, Math.floor(ms / 1000), minSec);

    if (this.bid === null && closed.length) {
      this.bid = closed[closed.length - 1].close;
    }

    this.simMs = ms;
    this.loading = false;
    this.markerKey = '';
    this.render(true);
    this.chart.scrollToEnd();

    if (wasPlaying) this.play();
  }

  async stepBar() {
    if (this.loading) return;
    this.pause();

    const tf = this.opts.tfSec * 1000;
    const base = this.forming ? this.forming.time * 1000 : Math.floor(this.simMs / tf) * tf;
    const target = base + tf;

    for (let guard = 0; guard < 50; guard++) {
      this.consumeUntil(target - 1, true);
      if (this.feed.available > 0 || this.feed.ended) break;
      await this.feed.fetchMore();
    }

    // Nến đóng khi tick đầu tiên của nến kế tiếp tới
    const next = this.feed.peekTime();
    if (next !== null && next < this.opts.endMs) {
      this.consumeUntil(next, true);
      this.simMs = next;
    } else {
      this.simMs = Math.min(target, this.opts.endMs - 1);
    }

    this.render(true);
  }

  nextTradeTime(direction: 1 | -1): number | null {
    if (!this.trades.length) return null;
    if (direction > 0) {
      const t = this.trades.find((x) => x.entry_ms > this.simMs + 1000);
      return t ? t.entry_ms : null;
    }
    const before = this.trades.filter((x) => x.entry_ms < this.simMs - 1000);
    return before.length ? before[before.length - 1].entry_ms : null;
  }

  // ----------------------------------------------------------
  // TICK
  // ----------------------------------------------------------

  private consumeUntil(targetMs: number, render: boolean) {
    const f = this.feed;
    const tfSec = this.opts.tfSec;
    const endMs = this.opts.endMs;

    while (f.head < f.t.length) {
      const t = f.t[f.head];
      if (t > targetMs || t >= endMs) break;

      const bid = f.bid[f.head];
      const ask = f.ask[f.head];
      f.head++;

      const bucket = Math.floor(t / 1000 / tfSec) * tfSec;
      const bar = this.forming;

      if (!bar || bucket !== bar.time) {
        if (bar && render) this.chart.updateBar(bar);
        this.forming = { time: bucket, open: bid, high: bid, low: bid, close: bid };
      } else {
        if (bid > bar.high) bar.high = bid;
        if (bid < bar.low) bar.low = bid;
        bar.close = bid;
      }

      this.bid = bid;
      this.ask = ask;
    }
  }

  private frame = (now: number) => {
    if (!this.playing) return;

    const dt = Math.min(Math.max(now - this.lastFrame, 0), 100);
    this.lastFrame = now;

    const f = this.feed;
    f.maintain();

    let target = this.simMs + dt * this.speed;
    const next = f.peekTime();

    if (next !== null && next - target > GAP_JUMP_MS) {
      target = next;
    }

    this.consumeUntil(target, true);

    if (f.available === 0 && !f.ended) {
      // đang chờ gói tick kế tiếp: không cho thời gian vượt quá dữ liệu đã có
      const last = f.t.length ? f.t[f.t.length - 1] : this.simMs;
      this.simMs = Math.max(this.simMs, Math.min(target, last));
    } else {
      this.simMs = target;
    }

    if (this.simMs >= this.opts.endMs - 1 || (f.available === 0 && f.ended)) {
      this.simMs = Math.min(Math.max(this.simMs, f.t.length ? f.t[f.t.length - 1] : this.simMs), this.opts.endMs - 1);
      this.render(true);
      this.pause();
      return;
    }

    this.render(false);
    this.raf = requestAnimationFrame(this.frame);
  };

  // ----------------------------------------------------------
  // VẼ
  // ----------------------------------------------------------

  private render(force: boolean) {
    if (this.forming) this.chart.updateBar(this.forming);
    this.chart.advanceIndicators(Math.floor(this.simMs / 1000));
    this.updateOverlays();
    this.notify(force);
  }

  private tradeIndex() {
    return {
      entered: lowerBound(this.entryMs, this.simMs),
      exited: lowerBound(this.exitMs, this.simMs),
    };
  }

  private currentSl(t: Trade) {
    let sl = t.sl;
    for (const m of t.sl_moves || []) {
      if (m.ms <= this.simMs) sl = m.sl;
      else break;
    }
    return sl;
  }

  private activeOrder(): PendingOrder | null {
    for (let k = this.orders.length - 1; k >= 0; k--) {
      const o = this.orders[k];
      if (o.placed_ms <= this.simMs) {
        return o.end_ms > this.simMs ? o : null;
      }
    }
    return null;
  }

  private updateOverlays() {
    const { tfSec, digits } = this.opts;
    const { entered, exited } = this.tradeIndex();
    const key = `${entered}:${exited}`;

    if (key !== this.markerKey) {
      this.markerKey = key;
      const marks: ChartMarker[] = [];
      const bucket = (ms: number) => Math.floor(ms / 1000 / tfSec) * tfSec;

      for (let k = 0; k < entered; k++) {
        const t = this.trades[k];
        const buy = t.side === 'BUY';
        marks.push({
          time: bucket(t.entry_ms),
          position: buy ? 'belowBar' : 'aboveBar',
          color: buy ? '#22c55e' : '#ef4444',
          shape: buy ? 'arrowUp' : 'arrowDown',
          text: `#${t.id} ${t.side}`,
        });
        if (k < exited) {
          marks.push({
            time: bucket(t.exit_ms),
            position: buy ? 'aboveBar' : 'belowBar',
            color: t.profit >= 0 ? '#86efac' : '#fca5a5',
            shape: 'circle',
            text: `${t.exit_reason} ${t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)}`,
          });
        }
      }
      this.chart.setMarkers(marks);
    }

    const lines: ChartLine[] = [];

    if (this.bid !== null) lines.push({ id: 'bid', price: this.bid, color: '#ef4444', title: 'Bid', style: 'dotted' });
    if (this.ask !== null) lines.push({ id: 'ask', price: this.ask, color: '#94a3b8', title: 'Ask', style: 'dotted' });

    if (entered > exited) {
      const t = this.trades[entered - 1];
      const sl = this.currentSl(t);
      lines.push({ id: 'entry', price: t.entry, color: '#3b82f6', title: `#${t.id} ${t.side} ${t.lot}`, width: 2 });
      lines.push({ id: 'sl', price: sl, color: '#ef4444', title: sl !== t.sl ? 'SL (dời)' : 'SL', style: 'dashed', width: 2 });
      lines.push({ id: 'tp', price: t.tp, color: '#22c55e', title: 'TP', style: 'dashed', width: 2 });
    }

    const order = this.activeOrder();
    if (order) {
      lines.push({ id: 'order', price: order.price, color: '#f59e0b', title: order.type.replace('_', ' '), width: 2 });
      lines.push({ id: 'order_sl', price: order.sl, color: '#b45309', title: 'SL chờ', style: 'dotted' });
      lines.push({ id: 'order_tp', price: order.tp, color: '#15803d', title: 'TP chờ', style: 'dotted' });
    }

    this.chart.setLines(lines.map((l) => ({ ...l, price: Number(l.price.toFixed(digits)) })));
  }

  private notify(force: boolean) {
    const now = performance.now();
    if (!force && now - this.lastNotify < NOTIFY_MS) return;
    this.lastNotify = now;

    const { entered, exited } = this.tradeIndex();
    const initial = this.opts.result?.summary.initial_balance ?? 0;
    const balance = exited > 0 ? this.balanceAfter[exited - 1] : initial;

    let openTrade: Trade | null = null;
    let openSl: number | null = null;
    let floating = 0;

    if (entered > exited) {
      openTrade = this.trades[entered - 1];
      openSl = this.currentSl(openTrade);
      const price = openTrade.side === 'BUY' ? this.bid : this.ask;
      if (price !== null) {
        const diff = openTrade.side === 'BUY' ? price - openTrade.entry : openTrade.entry - price;
        floating = diff * this.opts.contractSize * openTrade.lot;
      }
    }

    const span = this.opts.endMs - this.opts.startMs;

    this.opts.onUpdate({
      simMs: this.simMs,
      playing: this.playing,
      speed: this.speed,
      loading: this.loading,
      ended: this.simMs >= this.opts.endMs - 1,
      bid: this.bid,
      ask: this.ask,
      balance,
      floating,
      openTrade,
      openSl,
      pending: this.activeOrder(),
      closedTrades: exited,
      eventIndex: lowerBound(this.eventMs, this.simMs),
      progress: span > 0 ? (this.simMs - this.opts.startMs) / span : 0,
    });
  }
}
