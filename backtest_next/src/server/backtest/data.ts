import { type Bars, aggregate, barsFromTicks, concatBars, lowerBound, sliceBars } from '../market/bars';

/**
 * Dữ liệu cho 1 lần backtest:
 *   ticks (t, bid, ask) của khoảng backtest -> khớp lệnh, SL/TP theo từng tick
 *   nến M1 = nến warmup (trước ngày bắt đầu, để chỉ báo đủ dữ liệu)
 *            + nến dựng từ tick của khoảng backtest (có chỉ số tick)
 *   nến khung lớn (M5, M15, H1...) = gộp từ M1
 */
export type M1Bars = Bars & { tickStart: Int32Array; tickEnd: Int32Array };

export class MarketData {
  readonly m1: M1Bars;
  readonly warmCount: number;
  private htf = new Map<number, Bars>();

  constructor(
    readonly symbol: string,
    readonly t: Float64Array,
    readonly bid: Float64Array,
    readonly ask: Float64Array,
    warm: Bars,
    readonly digits = 3,
    readonly contractSize = 100,
  ) {
    const trade = barsFromTicks(t, bid, 60, true);
    const warmBars = trade.time.length && warm.time.length ? sliceBars(warm, undefined, trade.time[0]) : warm;
    this.warmCount = warmBars.time.length;

    const m1 = concatBars([warmBars, trade]);
    const n = m1.time.length;
    const ts = new Int32Array(n).fill(-1);
    const te = new Int32Array(n).fill(-1);
    ts.set(trade.tickStart!, this.warmCount);
    te.set(trade.tickEnd!, this.warmCount);
    this.m1 = { ...m1, tickStart: ts, tickEnd: te };
    this.htf.set(60, this.m1);
  }

  bars(tfSec: number): Bars {
    let b = this.htf.get(tfSec);
    if (!b) {
      b = aggregate(this.m1, tfSec);
      this.htf.set(tfSec, b);
    }
    return b;
  }

  /** Số nến khung tf ĐÃ ĐÓNG tại nowSec (nến chứa nowSec đang chạy -> chưa đóng, giống iloc[:-1]). */
  closedCount(tfSec: number, nowSec: number) {
    const currentOpen = Math.floor(nowSec / tfSec) * tfSec;
    return lowerBound(this.bars(tfSec).time, currentOpen);
  }
}
