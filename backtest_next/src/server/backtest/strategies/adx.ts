import { adxMt5, adxWilder } from '../../indicators';
import { roundTo, type Bars } from '../../market/bars';
import { PIP_TO_PRICE, Strategy, g, intOrNull, num, seriesPoints, timeText, type SeriesDef } from './base';

/**
 * PHƯƠNG PHÁP ADX(14) — logic từ adx_engine.py (AdxBot)
 *   1. H1 vừa đóng: ADX >= ngưỡng -> DỪNG (bỏ chờ, hủy lệnh chờ); ADX < ngưỡng -> ghi H1-High / H1-Low
 *   2. M1 vừa đóng (sau khi nến H1 ghi nhận đã đóng):
 *        MUA : Low M1  <= H1-Low  - N pip -> chờ nến M1 XANH đóng trên H1-Low
 *        BÁN : High M1 >= H1-High + N pip -> chờ nến M1 ĐỎ đóng dưới H1-High
 *   3. MUA đặt BUY STOP = giá đóng cửa ĐỈNH M1 gần nhất (trên Ask)
 *      BÁN đặt SELL STOP = giá đóng cửa ĐÁY M1 gần nhất (dưới Bid)  (fractal N nến mỗi bên)
 *   4. SL = đáy/đỉnh M1 gần nhất ± 0.1, khoảng SL 4–8 giá; TP = SL × min(R:R, 0.75), tối đa 10 giá
 *   5. Mỗi lần chọc thủng 1 lệnh; lệnh chờ chưa khớp khi hết giờ H1 hiện tại -> hủy.
 */

const SL_BUFFER = 0.1;
const SL_MIN_DISTANCE = 4.0;
const SL_MAX_DISTANCE = 8.0;
const TP_MAX_RR = 0.75;
const TP_MAX_DISTANCE = 10.0;
const SWING_LOOKBACK = 120;
const H1 = 3600;

type H1Info = { adx: number; strong: boolean; high: number; low: number; time: number };
type Swing = { time: number; high: number; low: number; close: number };

export class AdxStrategy extends Strategy {
  static key = 'adx';

  private period!: number;
  private adxMax!: number;
  private pierce!: number;
  private swingBars!: number;
  private rr!: number;
  private h1!: Bars;
  private adx!: Float64Array;

  private h1Time: number | null = null;
  private armed: { side: 'BUY' | 'SELL'; time: number } | null = null;
  private lastM1: number | null = null;
  private expireAt: number | null = null;

  protected prepare() {
    const cfg = this.cfg;
    const period = intOrNull(cfg.adx_period);
    const adxMax = num(cfg.adx_max);
    const method = String(cfg.adx_method || '').toUpperCase();
    const pierce = num(cfg.pierce_pips);
    const swing = intOrNull(cfg.swing_bars);
    const risk = num(cfg.rr_risk);
    const reward = num(cfg.rr_reward);

    const errors: string[] = [];
    if (period === null || period < 2) errors.push(`Chu kỳ ADX=${cfg.adx_period}`);
    if (adxMax === null || adxMax <= 0) errors.push(`Ngưỡng ADX=${cfg.adx_max}`);
    if (method !== 'MT5' && method !== 'WILDER') errors.push(`Cách tính ADX=${cfg.adx_method}`);
    if (pierce === null || pierce < 0) errors.push(`Chọc thủng (pip)=${cfg.pierce_pips}`);
    if (swing === null || swing < 1) errors.push(`Số nến đỉnh/đáy=${cfg.swing_bars}`);
    if (!risk || risk <= 0 || !reward || reward <= 0) errors.push(`R:R=${cfg.rr_risk}:${cfg.rr_reward}`);
    if (errors.length) {
      this.invalid = errors.join('; ');
      return;
    }

    this.period = period!;
    this.adxMax = adxMax!;
    this.pierce = pierce!;
    this.swingBars = swing!;
    this.rr = Math.min(reward! / risk!, TP_MAX_RR);
    this.h1 = this.data.bars(H1);
    const fn = method === 'MT5' ? adxMt5 : adxWilder;
    this.adx = fn(this.h1.high, this.h1.low, this.h1.close, this.period);
  }

  private h1Info(i: number): H1Info | null {
    const nh = this.data.closedCount(H1, this.nowSec(i));
    if (nh < this.period * 3) return null;
    const j = nh - 1;
    const value = this.adx[j];
    if (!Number.isFinite(value)) return null;
    return { adx: value, strong: value >= this.adxMax, high: this.h1.high[j], low: this.h1.low[j], time: this.h1.time[j] };
  }

  private updateSignal(i: number, b: number, h1: H1Info, canArm: boolean): ['BUY' | 'SELL' | null, string] {
    if (this.h1Time !== h1.time) {
      if (this.h1Time !== null && this.armed) {
        this.log(i, 'INFO', 'ARM', `↩️ BỎ CHỜ ${this.armed.side} | Đã sang nến H1 mới (H1-High=${h1.high.toFixed(2)} H1-Low=${h1.low.toFixed(2)})`);
      }
      this.h1Time = h1.time;
      this.armed = null;
      this.lastM1 = null;
    }

    if (b < 1) return [null, ''];
    const k = b - 1;
    const barTime = this.m1.time[k];
    if (barTime < h1.time + H1 || barTime === this.lastM1) return [null, ''];
    this.lastM1 = barTime;
    if (!canArm) return [null, ''];

    const pierce = this.pierce * PIP_TO_PRICE;
    const m1 = this.m1;
    const o = m1.open[k];
    const hi = m1.high[k];
    const lo = m1.low[k];
    const c = m1.close[k];

    if (lo <= h1.low - pierce) {
      if (!this.armed || this.armed.side !== 'BUY') {
        this.log(i, 'INFO', 'ARM',
          `📍 CHỌC THỦNG H1-LOW | MUA | M1 ${timeText(barTime)} Low=${lo.toFixed(2)} <= H1-Low ${h1.low.toFixed(2)} - ${g(pierce)} | Chờ nến M1 xanh đóng trên H1-Low`);
      }
      this.armed = { side: 'BUY', time: barTime };
    } else if (hi >= h1.high + pierce) {
      if (!this.armed || this.armed.side !== 'SELL') {
        this.log(i, 'INFO', 'ARM',
          `📍 CHỌC THỦNG H1-HIGH | BÁN | M1 ${timeText(barTime)} High=${hi.toFixed(2)} >= H1-High ${h1.high.toFixed(2)} + ${g(pierce)} | Chờ nến M1 đỏ đóng dưới H1-High`);
      }
      this.armed = { side: 'SELL', time: barTime };
    }

    if (!this.armed) return [null, ''];

    let ok: boolean;
    let text: string;
    if (this.armed.side === 'BUY') {
      ok = c > o && c > h1.low;
      text = `M1 ${timeText(barTime)} O=${o.toFixed(2)} C=${c.toFixed(2)} | ${c > o ? 'XANH' : 'không xanh'}, ${c > h1.low ? 'trên' : 'chưa trên'} H1-Low ${h1.low.toFixed(2)}`;
    } else {
      ok = c < o && c < h1.high;
      text = `M1 ${timeText(barTime)} O=${o.toFixed(2)} C=${c.toFixed(2)} | ${c < o ? 'ĐỎ' : 'không đỏ'}, ${c < h1.high ? 'dưới' : 'chưa dưới'} H1-High ${h1.high.toFixed(2)}`;
    }
    return [ok ? this.armed.side : null, text];
  }

  /** Đỉnh / đáy fractal trên nến M1 đã đóng (mới nhất trước). */
  private findSwings(b: number): [Swing[], Swing[]] {
    const bars = this.swingBars;
    const start = Math.max(0, b - (SWING_LOOKBACK + bars));
    const n = b - start;
    const m1 = this.m1;
    const highs: Swing[] = [];
    const lows: Swing[] = [];

    for (let k = n - 1 - bars; k >= bars; k--) {
      const idx = start + k;
      const hi = m1.high[idx];
      const lo = m1.low[idx];
      let isHigh = true;
      let isLow = true;
      for (let q = 1; q <= bars; q++) {
        if (!(m1.high[idx - q] < hi) || !(m1.high[idx + q] <= hi)) isHigh = false;
        if (!(m1.low[idx - q] > lo) || !(m1.low[idx + q] >= lo)) isLow = false;
      }
      const item = { time: m1.time[idx], high: hi, low: lo, close: m1.close[idx] };
      if (isHigh) highs.push(item);
      if (isLow) lows.push(item);
    }
    return [highs, lows];
  }

  private plan(side: 'BUY' | 'SELL', b: number, bid: number, ask: number) {
    const [highs, lows] = this.findSwings(b);
    let entry: number;
    let risk: number;
    let anchor: Swing;

    if (side === 'BUY') {
      const top = highs.find((s) => s.close > ask);
      if (!top) return { plan: null, why: 'Không có đỉnh M1 nào có giá đóng cửa trên giá Ask' };
      entry = top.close;
      const bottom = lows.find((s) => s.low - SL_BUFFER < entry);
      if (!bottom) return { plan: null, why: 'Không tìm thấy đáy M1 gần nhất để đặt SL' };
      risk = entry - (bottom.low - SL_BUFFER);
      anchor = top;
    } else {
      const bottom = lows.find((s) => s.close < bid);
      if (!bottom) return { plan: null, why: 'Không có đáy M1 nào có giá đóng cửa dưới giá Bid' };
      entry = bottom.close;
      const top = highs.find((s) => s.high + SL_BUFFER > entry);
      if (!top) return { plan: null, why: 'Không tìm thấy đỉnh M1 gần nhất để đặt SL' };
      risk = top.high + SL_BUFFER - entry;
      anchor = bottom;
    }

    risk = Math.min(Math.max(risk, SL_MIN_DISTANCE), SL_MAX_DISTANCE);
    const reward = Math.min(risk * this.rr, TP_MAX_DISTANCE);
    const sl = side === 'BUY' ? entry - risk : entry + risk;
    const tp = side === 'BUY' ? entry + reward : entry - reward;
    if (risk <= 0) return { plan: null, why: `Khoảng SL quá nhỏ (${risk.toFixed(2)})` };
    return { plan: { entry, sl, tp, risk, entryBar: anchor.time }, why: '' };
  }

  decide(i: number, b: number, inTime: boolean) {
    if (this.invalid) return;

    const broker = this.broker;
    const pos = broker.position;
    const order = broker.pending;
    const canArm = !pos && !order && inTime;
    const h1 = this.h1Info(i);
    if (!h1) return;

    const adxText = `ADX${this.period} H1=${h1.adx.toFixed(2)}`;

    // ---------- ADX mạnh: dừng giao dịch ----------
    if (h1.strong) {
      if (this.armed) this.log(i, 'INFO', 'ARM', `↩️ BỎ CHỜ ${this.armed.side} | ${adxText} >= ${g(this.adxMax)}`);
      this.armed = null;
      this.log(i, 'INFO', 'ADX', `🌪 ${adxText} >= ${g(this.adxMax)} | Thị trường biến động mạnh – dừng giao dịch`, false);
      if (order) broker.cancelPending(i, 'ADX vượt ngưỡng');
      return;
    }

    this.log(i, 'INFO', 'ADX', `${adxText} < ${g(this.adxMax)} | H1 ${timeText(h1.time)}: H1-High=${h1.high.toFixed(2)} H1-Low=${h1.low.toFixed(2)}`, false);

    const [side, m1Text] = this.updateSignal(i, b, h1, canArm);

    if (pos) {
      if (order) broker.cancelPending(i, 'Đã có lệnh đang chạy');
      return;
    }

    if (order) {
      let reason: string | null = null;
      if (!inTime) reason = 'Ra ngoài khung giờ giao dịch';
      else if (this.expireAt && this.nowSec(i) >= this.expireAt) reason = 'Hết giờ H1 hiện tại mà chưa khớp';
      if (reason) broker.cancelPending(i, reason);
      return;
    }

    if (!inTime) {
      this.log(i, 'INFO', 'TIME', '⏰ TRADING TIME BLOCK | Ngoài khung giờ – tạm chờ', false);
      return;
    }

    if (!this.armed || !side) return;

    const { plan, why } = this.plan(side, b, this.bid(i), this.ask(i));
    if (!plan) {
      this.log(i, 'WARN', 'PLAN', `⛔ ${side}: ${m1Text} | ${why} | Giữ trạng thái chờ`);
      return;
    }

    const entry = this.round(plan.entry);
    const sl = this.round(plan.sl);
    const tp = this.round(plan.tp);
    const signalTime = this.armed.time;
    this.armed = null;
    this.expireAt = h1.time + 2 * H1;

    const decision = side === 'BUY' ? 'BUY_STOP' : 'SELL_STOP';
    const reason = `${adxText} | ${m1Text} | ${decision} @ ${entry} (đóng cửa ${side === 'BUY' ? 'đỉnh' : 'đáy'} M1 ${timeText(plan.entryBar)})`;

    this.log(i, 'TRADE', 'PASS',
      `💹 ĐẶT ${decision} | ${reason} | SL=${sl} | TP=${tp} | SL=${Math.abs(entry - sl).toFixed(2)} TP=${Math.abs(tp - entry).toFixed(2)}`);

    broker.placeStop(i, side, entry, sl, tp, this.expireAt * 1000, reason, {
      adx: roundTo(h1.adx, 2), h1_high: h1.high, h1_low: h1.low, signal_time: signalTime, entry_bar: plan.entryBar,
    });
  }

  series(): SeriesDef[] {
    if (this.invalid) return [];
    const t = this.h1.time;
    return [
      { id: 'h1_high', name: 'H1-High', tf: 'ANY', pane: 0, color: '#f97316', step: true, data: seriesPoints(t, this.h1.high, 3, H1) },
      { id: 'h1_low', name: 'H1-Low', tf: 'ANY', pane: 0, color: '#22d3ee', step: true, data: seriesPoints(t, this.h1.low, 3, H1) },
      { id: 'adx', name: `ADX${this.period} H1`, tf: 'ANY', pane: 1, color: '#facc15', step: true, levels: [this.adxMax], data: seriesPoints(t, this.adx, 2, H1) },
    ];
  }
}
