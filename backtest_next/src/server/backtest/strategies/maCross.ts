import { sma } from '../../indicators';
import { TIMEFRAMES, roundTo } from '../../market/bars';
import { Strategy, finite, g, getRr, intOrNull, num, seriesPoints, timeText, type SeriesDef } from './base';

/**
 * PHƯƠNG PHÁP MA CROSS — logic từ decision_engine.py + chart_module.py
 *   Chỉ dùng nến M1 ĐÃ ĐÓNG. Mỗi điểm Cross chỉ đánh giá 1 lần.
 *   1   Trend MA200: Close > MA -> chỉ BUY, Close < MA -> chỉ SELL
 *   2   MA Fast cắt MA Slow (SMA) -> CrossPrice = giá đóng nến Cross
 *   2.1 FOMO      : Cross - Low (BUY) / High - Cross (SELL) > 200% biên độ TB 3 nến trước -> bỏ
 *   2.2 SIDEWAY   : TH1 ±3 giá quanh Cross lệnh THUA ĐẦU TIÊN • TH2 ±3 giá quanh MA Trend
 *   2.3 ĐỘ DỐC J-K: J = SMA[1]-SMA[2], K = J/(SMA[2]-SMA[3]) - 1
 *   3   Vào MARKET (BUY = Ask, SELL = Bid)
 *   4   SL theo 10 nến trước nến Cross (BUY: Low thấp nhất + 0.1, SELL: High cao nhất - 0.1),
 *       khoảng SL phải 3.01–8.99 giá; TP = khoảng SL × min(R:R, 0.85)
 */

const FOMO_BODY_LOOKBACK = 3;
const FOMO_MULTIPLIER = 2.0;
const SIDEWAY_RANGE = 3.0;
const SL_LOOKBACK = 10;
const SL_BUFFER = 0.1;
const SL_MIN_DISTANCE = 3.01;
const SL_MAX_DISTANCE = 8.99;
const TP_MAX_RR = 0.85;
const JK_TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4'];

export class MaCrossStrategy extends Strategy {
  static key = 'ma_cross';

  private fast!: number;
  private slow!: number;
  private trendPeriod!: number | null;
  private rrRisk!: number;
  private rrReward!: number;
  private rr!: number;
  private useTrend!: boolean;
  private useSideway!: boolean;
  private useSidewayMa!: boolean;
  private useFomo!: boolean;
  private useJk!: boolean;
  private jkTf: number | null = null;
  private jkTfName = '';
  private jkPeriod: number | null = null;
  private jkMaxK: number | null = null;
  private jkMinJ: number | null = null;
  private jkMaxJ: number | null = null;
  private jkBlockNoData = true;

  private maFast!: Float64Array;
  private maSlow!: Float64Array;
  private maTrend!: Float64Array;

  private lastCrossTime: number | null = null;
  private lastCrossDir: string | null = null;
  loss_streak = 0;
  first_loss_cross_price: number | null = null;
  private lastSignalPrice: number | null = null;

  protected prepare() {
    const cfg = this.cfg;
    const fast = intOrNull(cfg.ma_fast);
    const slow = intOrNull(cfg.ma_slow);
    this.trendPeriod = intOrNull(cfg.ma_value);
    const [risk, reward, rr] = getRr(cfg);

    this.useTrend = !!cfg.ma_trend;
    this.useSideway = !!cfg.sideway_filter;
    this.useSidewayMa = !!cfg.sideway_ma_filter;
    this.useFomo = !!cfg.anti_fomo;
    this.useJk = !!cfg.jk_filter;

    const errors: string[] = [];
    if (!fast || fast <= 0) errors.push(`MA Fast=${cfg.ma_fast}`);
    if (!slow || slow <= 0) errors.push(`MA Slow=${cfg.ma_slow}`);
    if (fast && slow && fast >= slow) errors.push(`MA Fast (${fast}) phải nhỏ hơn MA Slow (${slow})`);
    if ((this.useTrend || this.useSidewayMa) && (!this.trendPeriod || this.trendPeriod <= 0)) errors.push(`MA Trend=${cfg.ma_value}`);
    if (rr === null) errors.push(`R:R=${cfg.rr_risk}:${cfg.rr_reward}`);

    if (this.useJk) {
      const tf = String(cfg.jk_timeframe || '').toUpperCase();
      this.jkTf = JK_TIMEFRAMES.includes(tf) ? TIMEFRAMES[tf] : null;
      this.jkTfName = tf;
      this.jkPeriod = intOrNull(cfg.jk_sma_period);
      this.jkMaxK = num(cfg.jk_max_abs_k);
      this.jkMinJ = num(cfg.jk_min_abs_j);
      this.jkMaxJ = num(cfg.jk_max_abs_j);
      this.jkBlockNoData = cfg.jk_block_no_data === undefined ? true : !!cfg.jk_block_no_data;
      if (this.jkTf === null) errors.push(`J-K khung=${cfg.jk_timeframe}`);
      if (!this.jkPeriod || this.jkPeriod < 2) errors.push(`J-K SMA=${cfg.jk_sma_period}`);
      for (const [v, label] of [[this.jkMaxK, '|K| tối đa'], [this.jkMinJ, '|J| tối thiểu'], [this.jkMaxJ, '|J| tối đa']] as const) {
        if (v === null || v < 0) errors.push(`J-K ${label}`);
      }
    }

    if (errors.length) {
      this.invalid = errors.join('; ');
      return;
    }

    this.fast = fast!;
    this.slow = slow!;
    this.rrRisk = risk!;
    this.rrReward = reward!;
    this.rr = Math.min(rr!, TP_MAX_RR);

    const close = this.m1.close;
    this.maFast = sma(close, this.fast);
    this.maSlow = sma(close, this.slow);
    this.maTrend = this.trendPeriod ? sma(close, this.trendPeriod) : new Float64Array(close.length).fill(NaN);
  }

  decide(i: number, b: number, inTime: boolean) {
    if (this.invalid || this.broker.position) return;

    if (!inTime) {
      this.log(i, 'INFO', 'TIME', '⏰ TRADING TIME BLOCK | Ngoài khung giờ – không xét tín hiệu', false);
      return;
    }

    const m1 = this.m1;
    const c = b - 1; // nến đã đóng gần nhất
    const p = b - 2;
    if (p < 0) return;

    const f0 = this.maFast[p];
    const s0 = this.maSlow[p];
    const f1 = this.maFast[c];
    const s1 = this.maSlow[c];
    if (!finite(f0, s0, f1, s1)) return;

    let cross: 'BUY' | 'SELL';
    if (f0 < s0 && f1 > s1) cross = 'BUY';
    else if (f0 > s0 && f1 < s1) cross = 'SELL';
    else return;

    const crossTime = m1.time[c];
    const crossPrice = m1.close[c];

    if (this.lastCrossTime === crossTime && this.lastCrossDir === cross) return;
    this.lastCrossTime = crossTime;
    this.lastCrossDir = cross;

    const tag = `Cross=${cross} | Nến=${timeText(crossTime)} | CrossPrice=${crossPrice.toFixed(2)}`;
    const meta = { cross, cross_time: crossTime, cross_price: crossPrice };
    this.log(i, 'INFO', 'SIGNAL', `📍 MA CROSS | ${tag} | MA${this.fast} x MA${this.slow} | LossStreak=${this.loss_streak}`);

    const block = (text: string) => this.log(i, 'WARN', 'BLOCK', `⛔ BLOCK ${text} | ${tag} | Chờ Cross tiếp theo`);

    const maRaw = this.maTrend[c];
    const maValue = Number.isFinite(maRaw) ? maRaw : null;

    // ---------------- 1 — TREND ----------------
    if (this.useTrend) {
      if (maValue === null) return block(`TREND MA${this.trendPeriod} | MA Trend chưa đủ dữ liệu`);
      const trend = crossPrice > maValue ? 'UP' : crossPrice < maValue ? 'DOWN' : null;
      if (!((cross === 'BUY' && trend === 'UP') || (cross === 'SELL' && trend === 'DOWN'))) {
        return block(`TREND MA${this.trendPeriod} | Cross ngược hướng trend | Close=${crossPrice.toFixed(2)} | MA=${maValue.toFixed(2)}`);
      }
    }

    // ---------------- 2.1 — FOMO ----------------
    if (this.useFomo) {
      if (c < FOMO_BODY_LOOKBACK) return block('FOMO | Không đủ nến');
      let sum = 0;
      for (let k = c - FOMO_BODY_LOOKBACK; k < c; k++) sum += Math.abs(m1.high[k] - m1.low[k]);
      const avg = sum / FOMO_BODY_LOOKBACK;
      const distance = cross === 'BUY' ? crossPrice - m1.low[c] : m1.high[c] - crossPrice;
      const threshold = avg * FOMO_MULTIPLIER;
      if (distance > threshold) {
        return block(`FOMO | Khoảng cách ${distance.toFixed(2)} > 200% biên độ TB 3 nến (${threshold.toFixed(2)})`);
      }
    }

    let entry = cross === 'BUY' ? this.ask(i) : this.bid(i);

    // ---------------- 2.2 — SIDEWAY ----------------
    if (this.useSideway || this.useSidewayMa) {
      const parts: string[] = [];
      if (this.useSideway && this.loss_streak >= 1 && this.first_loss_cross_price !== null) {
        const gap = Math.abs(crossPrice - this.first_loss_cross_price);
        if (gap <= SIDEWAY_RANGE) {
          parts.push(`TH1 ±3 điểm thua đầu tiên: Cross=${crossPrice.toFixed(2)} vs FirstLossCross=${this.first_loss_cross_price.toFixed(2)} (lệch ${gap.toFixed(2)})`);
        }
      }
      if (this.useSidewayMa && maValue !== null) {
        const gap = Math.abs(crossPrice - maValue);
        if (gap <= SIDEWAY_RANGE) {
          parts.push(`TH2 ±3 MA${this.trendPeriod}: Cross=${crossPrice.toFixed(2)} vs MA=${maValue.toFixed(2)} (lệch ${gap.toFixed(2)})`);
        }
      }
      if (parts.length) return block('SIDEWAY | ' + parts.join(' ; '));
    }

    // ---------------- 2.3 — J-K ----------------
    if (this.useJk) {
      const [okJk, text] = this.checkJk(i);
      if (!okJk) return block(text);
      this.log(i, 'INFO', 'JK', `PASS ${text}`);
    }

    // ---------------- SL / TP ----------------
    if (c < SL_LOOKBACK) return block('SL/TP | Không đủ 10 nến trước nến Cross');

    let lo = Infinity;
    let hi = -Infinity;
    for (let k = c - SL_LOOKBACK; k < c; k++) {
      if (m1.low[k] < lo) lo = m1.low[k];
      if (m1.high[k] > hi) hi = m1.high[k];
    }

    const slDistance = cross === 'BUY' ? entry - (lo + SL_BUFFER) : hi - SL_BUFFER - entry;

    if (slDistance <= 0) return block(`SL/TP | Giá đã vượt vùng đáy/đỉnh 10 nến | Entry=${entry.toFixed(2)}`);

    const check = roundTo(slDistance, 2);
    if (check < SL_MIN_DISTANCE) {
      return block(`SL/TP | SL ${slDistance.toFixed(2)} giá < ${g(SL_MIN_DISTANCE)} giá (quá gần) | Entry=${entry.toFixed(2)}`);
    }
    if (check > SL_MAX_DISTANCE) {
      return block(`SL/TP | SL ${slDistance.toFixed(2)} giá > ${g(SL_MAX_DISTANCE)} giá (quá xa) | Entry=${entry.toFixed(2)}`);
    }

    const tpDistance = slDistance * this.rr;
    let sl = cross === 'BUY' ? entry - slDistance : entry + slDistance;
    let tp = cross === 'BUY' ? entry + tpDistance : entry - tpDistance;

    entry = this.round(entry);
    sl = this.round(sl);
    tp = this.round(tp);

    if (!(cross === 'BUY' ? sl < entry && entry < tp : tp < entry && entry < sl)) {
      return block(`SL/TP không hợp lệ | Entry=${entry} | SL=${sl} | TP=${tp}`);
    }

    this.log(i, 'TRADE', 'PASS',
      `💹 PASS ENTRY | ${tag} | ${cross} | Entry=${entry} | SL=${sl} | TP=${tp} | ` +
        `SL=${slDistance.toFixed(2)} TP=${tpDistance.toFixed(2)} | RR=${g(this.rrRisk)}:${g(this.rrReward)}`);

    if (this.broker.openMarket(i, cross, sl, tp, tag, meta)) this.lastSignalPrice = crossPrice;
  }

  private checkJk(i: number): [boolean, string] {
    const tf = this.jkTf!;
    const period = this.jkPeriod!;
    const bars = this.data.bars(tf);
    const count = this.data.closedCount(tf, this.nowSec(i));
    const closes = bars.close.subarray(Math.max(0, count - (period + 5)), count);
    const name = `J-K ${this.jkTfName} SMA${period}`;
    const n = closes.length;

    if (n < period + 2) return [!this.jkBlockNoData, `${name} | Thiếu dữ liệu (${n} nến)`];

    const mean = (a: number, b: number) => {
      let s = 0;
      for (let k = a; k < b; k++) s += closes[k];
      return s / (b - a);
    };
    const s1 = mean(n - period, n);
    const s2 = mean(n - period - 1, n - 1);
    const s3 = mean(n - period - 2, n - 2);
    const j = s1 - s2;
    const jPrev = s2 - s3;

    if (Math.abs(jPrev) < 1e-12) return [!this.jkBlockNoData, `${name} | Thiếu dữ liệu`];

    const k = j / jPrev - 1;
    const text = `${name} | J=${j.toFixed(4)} K=${k.toFixed(4)}`;
    if (Math.abs(k) > this.jkMaxK!) return [false, text + ' | |K| vượt ngưỡng'];
    if (Math.abs(j) < this.jkMinJ!) return [false, text + ' | |J| quá nhỏ'];
    if (Math.abs(j) > this.jkMaxJ!) return [false, text + ' | |J| quá dốc'];
    return [true, text];
  }

  onClosed(trade: any) {
    if (!trade || this.invalid) return;
    if (trade.profit < 0) {
      this.loss_streak += 1;
      if (this.loss_streak === 1 || this.first_loss_cross_price === null) this.first_loss_cross_price = this.lastSignalPrice;
    } else {
      this.loss_streak = 0;
      this.lastSignalPrice = null;
      this.first_loss_cross_price = null;
    }
  }

  series(): SeriesDef[] {
    if (this.invalid) return [];
    const t = this.m1.time;
    const out: SeriesDef[] = [
      { id: 'ma_fast', name: `MA${this.fast}`, tf: 'M1', pane: 0, color: '#f59e0b', data: seriesPoints(t, this.maFast) },
      { id: 'ma_slow', name: `MA${this.slow}`, tf: 'M1', pane: 0, color: '#a78bfa', data: seriesPoints(t, this.maSlow) },
    ];
    if (this.trendPeriod) {
      out.push({ id: 'ma_trend', name: `MA${this.trendPeriod}`, tf: 'M1', pane: 0, color: '#38bdf8', data: seriesPoints(t, this.maTrend) });
    }
    return out;
  }
}
