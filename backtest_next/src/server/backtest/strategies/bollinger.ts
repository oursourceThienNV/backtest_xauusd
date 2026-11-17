import { bollinger } from '../../indicators';
import { roundTo, type Bars } from '../../market/bars';
import { PIP_TO_PRICE, Strategy, finite, g, getRr, num, seriesPoints, timeText, type SeriesDef } from './base';

/**
 * PHƯƠNG PHÁP BOLLINGER (SMA20 ± 2σ) — VÒNG LẶP M15 — logic từ bollinger_engine.decide_loop
 *   ① M15 vừa đóng: Delta = SMA20[1] - SMA20[2]
 *        |Delta| < ngưỡng -> SIDEWAY, dừng ; |Delta| >= ngưỡng -> TREND MẠNH, bắt đầu vòng lặp
 *   ② Trong vòng lặp: nến M15 đóng cùng chiều SMA20 và NGOÀI biên -> sang M1 (hiệu lực 1 nến M15)
 *   ③ M1: Dist Upper-Lower < ngưỡng -> sideway; cặp nến: nến 1 cùng phía SMA20,
 *        nến 2 cùng phía + thân >= 70% -> vào lệnh MARKET
 *   ④ SL/TP theo 10 nến trước nến 2: SL = đáy/đỉnh ± 0.1 (tối đa 10 giá), TP = khoảng SL × R:R (đúng tỉ lệ nhập)
 *   Vòng lặp kết thúc khi dấu Delta đổi.
 */

const BB_PERIOD = 20;
const BODY_RATIO_MIN = 0.7;
const SL_LOOKBACK = 10;
const SL_BUFFER = 0.1;
const SL_MAX_DISTANCE = 10.0;
const M15 = 900;

type Trend = 'UP' | 'DOWN';
const trendVi = (t: Trend | null) => (t === 'UP' ? 'TĂNG' : t === 'DOWN' ? 'GIẢM' : '—');

type Signal = { side: 'BUY' | 'SELL'; price: number; time: number; body_ratio: number; width_pips?: number; index?: number };

export class BollingerStrategy extends Strategy {
  static key = 'bollinger';

  private deltaPips!: number;
  private widthM1Pips!: number;
  private rrRisk!: number;
  private rrReward!: number;
  private rr!: number;
  private mid1!: Float64Array;
  private up1!: Float64Array;
  private low1!: Float64Array;
  private m15!: Bars;
  private mid15!: Float64Array;
  private up15!: Float64Array;
  private low15!: Float64Array;

  private trend: Trend | null = null;
  private armed: { side: 'BUY' | 'SELL'; m15_time: number } | null = null;
  private lastM15: number | null = null;
  private lastM1: number | null = null;

  protected prepare() {
    const cfg = this.cfg;
    const delta = num(cfg.bb_delta_pips);
    const width = num(cfg.bb_width_m1_pips);
    const [risk, reward, rr] = getRr(cfg);

    const errors: string[] = [];
    if (delta === null || delta <= 0) errors.push(`Ngưỡng Delta SMA20 M15 (pip)=${cfg.bb_delta_pips}`);
    if (width === null || width < 0) errors.push(`Dist Upper-Lower M1 (pip)=${cfg.bb_width_m1_pips}`);
    if (rr === null) errors.push(`R:R=${cfg.rr_risk}:${cfg.rr_reward}`);
    if (errors.length) {
      this.invalid = errors.join('; ');
      return;
    }

    this.deltaPips = delta!;
    this.widthM1Pips = width!;
    this.rrRisk = risk!;
    this.rrReward = reward!;
    this.rr = rr!;

    [this.mid1, this.up1, this.low1] = bollinger(this.m1.close, BB_PERIOD, 2);
    this.m15 = this.data.bars(M15);
    [this.mid15, this.up15, this.low15] = bollinger(this.m15.close, BB_PERIOD, 2);
  }

  // ① ② M15
  private updateM15(i: number, canArm: boolean) {
    const nc = this.data.closedCount(M15, this.nowSec(i));
    if (nc + 1 < BB_PERIOD + 3) return;

    const j = nc - 1;
    const barTime = this.m15.time[j];
    if (barTime === this.lastM15) return;
    this.lastM15 = barTime;

    const close = this.m15.close[j];
    const mid = this.mid15[j];
    const upper = this.up15[j];
    const lower = this.low15[j];
    const prevMid = this.mid15[j - 1];
    if (!finite(mid, upper, lower, prevMid)) return;

    const delta = mid - prevMid;
    const threshold = this.deltaPips * PIP_TO_PRICE;
    const sign = (x: number, d: number) => (x >= 0 ? '+' : '') + x.toFixed(d);
    const deltaText = `Delta_sma20=${sign(delta / PIP_TO_PRICE, 1)} pip (${sign(delta, 2)})`;

    if (this.armed && barTime > this.armed.m15_time) {
      this.log(i, 'INFO', 'ARM', `↩️ HẾT HẠN tìm điểm vào ${this.armed.side} ở M1 | Nến M15 kế tiếp đã đóng`);
      this.armed = null;
    }

    if (this.trend !== null) {
      const direction: Trend = delta > 0 ? 'UP' : delta < 0 ? 'DOWN' : this.trend;
      if (direction !== this.trend) {
        this.log(i, 'INFO', 'LOOP',
          `🔚 KẾT THÚC VÒNG LẶP | Xu hướng ${trendVi(this.trend)} -> ${trendVi(direction)} | M15 ${timeText(barTime)} | ${deltaText}`);
        this.trend = null;
        this.armed = null;
      }
    }

    if (this.trend === null) {
      if (Math.abs(delta) < threshold) return;
      this.trend = delta > 0 ? 'UP' : 'DOWN';
      this.log(i, 'INFO', 'LOOP',
        `🔁 BẮT ĐẦU VÒNG LẶP | TREND MẠNH ${trendVi(this.trend)} | M15 ${timeText(barTime)} | ${deltaText} >= ±${g(this.deltaPips)} pip | ` +
          `Chỉ ${this.trend === 'UP' ? 'BUY' : 'SELL'}`);
    }

    if (!canArm) return;

    const ok = this.trend === 'UP' ? delta > 0 && close > mid && close > upper : delta < 0 && close < mid && close < lower;
    if (ok) {
      const side = this.trend === 'UP' ? 'BUY' : 'SELL';
      this.armed = { side, m15_time: barTime };
      this.lastM1 = null;
      this.log(i, 'INFO', 'ARM',
        `📍 M15 ĐÓNG NGOÀI BIÊN | ${side} | M15 ${timeText(barTime)} Close=${close.toFixed(2)} ` +
          `${side === 'BUY' ? '> Upper' : '< Lower'}=${(side === 'BUY' ? upper : lower).toFixed(2)} | ${deltaText} | Sang M1 tìm điểm vào lệnh`);
    }
  }

  // ③ M1
  private checkM1(i: number, b: number): [Signal | null, string] {
    const armed = this.armed;
    if (!armed || b + 1 < BB_PERIOD + SL_LOOKBACK + 2) return [null, ''];

    const k = b - 1;
    const barTime = this.m1.time[k];
    if (barTime < armed.m15_time + M15 || barTime === this.lastM1) return [null, ''];
    this.lastM1 = barTime;

    const upper = this.up1[k];
    const lower = this.low1[k];
    if (!finite(upper, lower)) return [null, 'M1 chưa đủ dữ liệu Bollinger'];

    const widthPips = (upper - lower) / PIP_TO_PRICE;
    if (widthPips < this.widthM1Pips) {
      return [null, `SIDEWAY M1 | Dist Upper-Lower=${widthPips.toFixed(0)} pip < ${g(this.widthM1Pips)} pip – không vào lệnh`];
    }

    const signal = this.detectSignal(k);
    if (!signal || signal.side !== armed.side) {
      return [null, `TREND MẠNH M1 (Dist=${widthPips.toFixed(0)} pip) | Cặp nến ${timeText(barTime)} chưa đạt (nến 1 theo chiều SMA20, nến 2 thân ≥ 70%)`];
    }

    signal.width_pips = widthPips;
    signal.index = k;
    return [signal, `TREND MẠNH M1 (Dist=${widthPips.toFixed(0)} pip) | Nến 2 ${timeText(barTime)} Close=${signal.price.toFixed(2)} Thân=${(signal.body_ratio * 100).toFixed(0)}%`];
  }

  private detectSignal(k: number): Signal | null {
    if (k < BB_PERIOD) return null;
    const m1 = this.m1;
    const mid1 = this.mid1[k - 1];
    const close1 = m1.close[k - 1];
    const mid2 = this.mid1[k];
    const o = m1.open[k];
    const h = m1.high[k];
    const l = m1.low[k];
    const c = m1.close[k];
    if (!finite(mid1, mid2)) return null;

    const rng = h - l;
    const bodyRatio = rng > 0 ? Math.abs(c - o) / rng : 0;
    const strong = bodyRatio >= BODY_RATIO_MIN;

    let side: 'BUY' | 'SELL';
    if (close1 > mid1 && c > mid2 && c > o && strong) side = 'BUY';
    else if (close1 < mid1 && c < mid2 && c < o && strong) side = 'SELL';
    else return null;

    return { side, price: c, time: m1.time[k], body_ratio: bodyRatio };
  }

  private slTp(k: number, side: 'BUY' | 'SELL', entry: number): [number, number] | null {
    if (k < SL_LOOKBACK) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (let q = k - SL_LOOKBACK; q < k; q++) {
      if (this.m1.low[q] < lo) lo = this.m1.low[q];
      if (this.m1.high[q] > hi) hi = this.m1.high[q];
    }
    if (side === 'BUY') {
      const sl = Math.max(lo - SL_BUFFER, entry - SL_MAX_DISTANCE);
      const risk = entry - sl;
      return risk <= 0 ? null : [sl, entry + risk * this.rr];
    }
    const sl = Math.min(hi + SL_BUFFER, entry + SL_MAX_DISTANCE);
    const risk = sl - entry;
    return risk <= 0 ? null : [sl, entry - risk * this.rr];
  }

  decide(i: number, b: number, inTime: boolean) {
    if (this.invalid) return;

    const hasPosition = !!this.broker.position;
    this.updateM15(i, !hasPosition && inTime);
    if (hasPosition) return;

    if (!inTime) {
      this.log(i, 'INFO', 'TIME', '⏰ TRADING TIME BLOCK | Ngoài khung giờ – tạm chờ', false);
      return;
    }

    if (this.trend === null || this.armed === null) return;

    const [signal, text] = this.checkM1(i, b);
    if (!signal) {
      if (text) this.log(i, 'INFO', 'M1', `${trendVi(this.trend)} | ${this.armed.side}: ${text}`, false);
      return;
    }

    const side = signal.side;
    let entry = side === 'BUY' ? this.ask(i) : this.bid(i);
    const sltp = this.slTp(signal.index!, side, entry);
    if (!sltp) {
      this.log(i, 'WARN', 'BLOCK', `⛔ ${text} | Không tính được SL/TP (giá đã vượt vùng 10 nến)`);
      return;
    }

    entry = this.round(entry);
    const sl = this.round(sltp[0]);
    const tp = this.round(sltp[1]);

    if (!(side === 'BUY' ? sl < entry && entry < tp : tp < entry && entry < sl)) {
      this.log(i, 'WARN', 'BLOCK', `⛔ SL/TP không hợp lệ | Entry=${entry} | SL=${sl} | TP=${tp}`);
      return;
    }

    this.armed = null;
    const reason = `Vòng lặp ${trendVi(this.trend)} | ${text}`;
    this.log(i, 'TRADE', 'PASS', `💹 VÀO LỆNH ${side} | ${reason} | Entry=${entry} | SL=${sl} | TP=${tp} | RR=${g(this.rrRisk)}:${g(this.rrReward)}`);

    this.broker.openMarket(i, side, sl, tp, reason, {
      signal_time: signal.time,
      body_ratio: roundTo(signal.body_ratio, 3),
      width_pips: roundTo(signal.width_pips!, 1),
      trend: this.trend,
    });
  }

  series(): SeriesDef[] {
    if (this.invalid) return [];
    const t1 = this.m1.time;
    const t15 = this.m15.time;
    return [
      { id: 'bb_up_m1', name: 'BB Upper M1', tf: 'M1', pane: 0, color: '#64748b', data: seriesPoints(t1, this.up1) },
      { id: 'bb_mid_m1', name: 'SMA20 M1', tf: 'M1', pane: 0, color: '#f59e0b', data: seriesPoints(t1, this.mid1) },
      { id: 'bb_low_m1', name: 'BB Lower M1', tf: 'M1', pane: 0, color: '#64748b', data: seriesPoints(t1, this.low1) },
      { id: 'bb_up_m15', name: 'BB Upper M15', tf: 'M15', pane: 0, color: '#475569', data: seriesPoints(t15, this.up15) },
      { id: 'bb_mid_m15', name: 'SMA20 M15', tf: 'M15', pane: 0, color: '#22d3ee', data: seriesPoints(t15, this.mid15) },
      { id: 'bb_low_m15', name: 'BB Lower M15', tf: 'M15', pane: 0, color: '#475569', data: seriesPoints(t15, this.low15) },
    ];
  }
}
