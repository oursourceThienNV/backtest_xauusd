import { rsiWilder, sma } from '../../indicators';
import { roundTo, type Bars } from '../../market/bars';
import { PIP_TO_PRICE, Strategy, g, getRr, intOrNull, num, seriesPoints, timeText, type SeriesDef } from './base';

/**
 * PHƯƠNG ÁN SMA20 + RSI — logic từ rsi_engine.py (RsiBot)
 *   1. H1 vừa đóng: Close > SMA20 -> chỉ BUY ; Close < SMA20 -> chỉ SELL (đổi hướng -> bỏ trạng thái chờ)
 *   2. M1 (RSI Wilder trên nến đã đóng)
 *      BUY : RSI vượt 70 rồi cắt xuống (điểm chờ mua) -> RSI xuống dưới 30 rồi cắt lên -> VÀO BUY (Ask)
 *      SELL: RSI xuống dưới 30 rồi cắt lên (điểm chờ bán) -> RSI vượt 70 rồi cắt xuống -> VÀO SELL (Bid)
 *   3. SL = đáy/đỉnh 10 nến (gồm nến xác nhận) ± 0.1, tối đa 80 pip; TP = khoảng SL × R:R
 *      Chốt lời sớm theo RSI (tùy chọn).
 */

const SL_BUFFER = 0.1;
const H1 = 3600;

type Side = 'BUY' | 'SELL';

export class SmaRsiStrategy extends Strategy {
  static key = 'sma_rsi';

  private smaPeriod!: number;
  private rsiPeriod!: number;
  private rsiHigh!: number;
  private rsiLow!: number;
  private slLookback!: number;
  private slMaxPips!: number;
  private rsiExit = false;
  private rrRisk!: number;
  private rrReward!: number;
  private rr!: number;
  private h1!: Bars;
  private h1Sma!: Float64Array;
  private rsi!: Float64Array;

  private side: Side | null = null;
  private stage: 'WAIT_ARM' | 'WAIT_ENTRY' = 'WAIT_ARM';
  private extreme = false;
  private exitSeen = false;
  private exitSide: Side | null = null;
  private nextBar: number | null = null;

  protected prepare() {
    const cfg = this.cfg;
    const smaPeriod = intOrNull(cfg.sma_period);
    const rsiPeriod = intOrNull(cfg.rsi_period);
    const rsiHigh = num(cfg.rsi_high);
    const rsiLow = num(cfg.rsi_low);
    const slLookback = intOrNull(cfg.sl_lookback);
    const slMaxPips = num(cfg.sl_max_pips);
    const [risk, reward, rr] = getRr(cfg);

    const errors: string[] = [];
    if (rr === null) errors.push(`R:R=${cfg.rr_risk}:${cfg.rr_reward}`);
    if (smaPeriod === null || smaPeriod < 2) errors.push(`SMA H1=${cfg.sma_period}`);
    if (rsiPeriod === null || rsiPeriod < 2) errors.push(`Chu kỳ RSI=${cfg.rsi_period}`);
    if (rsiHigh === null || !(rsiHigh > 50 && rsiHigh < 100)) errors.push(`RSI ngưỡng trên=${cfg.rsi_high} (50 < x < 100)`);
    if (rsiLow === null || !(rsiLow > 0 && rsiLow < 50)) errors.push(`RSI ngưỡng dưới=${cfg.rsi_low} (0 < x < 50)`);
    if (slLookback === null || slLookback < 2) errors.push(`Số nến tìm đáy/đỉnh SL=${cfg.sl_lookback}`);
    if (slMaxPips === null || slMaxPips <= 0) errors.push(`SL tối đa (pip)=${cfg.sl_max_pips}`);
    if (errors.length) {
      this.invalid = errors.join('; ');
      return;
    }

    this.smaPeriod = smaPeriod!;
    this.rsiPeriod = rsiPeriod!;
    this.rsiHigh = rsiHigh!;
    this.rsiLow = rsiLow!;
    this.slLookback = slLookback!;
    this.slMaxPips = slMaxPips!;
    this.rsiExit = Boolean(cfg.rsi_exit);
    this.rrRisk = risk!;
    this.rrReward = reward!;
    this.rr = rr!;

    this.h1 = this.data.bars(H1);
    this.h1Sma = sma(this.h1.close, this.smaPeriod);
    this.rsi = rsiWilder(this.m1.close, this.rsiPeriod);
  }

  private resetSetup() {
    this.stage = 'WAIT_ARM';
    this.extreme = false;
  }

  private checkH1(i: number) {
    const nh = this.data.closedCount(H1, this.nowSec(i));
    if (nh < this.smaPeriod + 1) return null;
    const j = nh - 1;
    const close = this.h1.close[j];
    const value = this.h1Sma[j];
    if (!Number.isFinite(value)) return null;
    const side: Side | null = close > value ? 'BUY' : close < value ? 'SELL' : null;
    return { side, close, sma: value, time: this.h1.time[j] };
  }

  private stepEntry(i: number, rsiValue: number, barTime: number) {
    const high = this.rsiHigh;
    const low = this.rsiLow;

    if (this.side === 'BUY') {
      if (this.stage === 'WAIT_ARM') {
        if (rsiValue > high) this.extreme = true;
        else if (this.extreme && rsiValue < high) {
          this.stage = 'WAIT_ENTRY';
          this.extreme = false;
          this.log(i, 'INFO', 'ARM',
            `📍 ĐIỂM CHỜ MUA | RSI vượt ${g(high)} rồi cắt xuống ${rsiValue.toFixed(1)} | Chờ RSI xuống dưới ${g(low)} rồi cắt lên | M1 ${timeText(barTime)}`);
        }
      } else {
        if (rsiValue < low) this.extreme = true;
        else if (this.extreme && rsiValue > low) return true;
      }
    } else if (this.side === 'SELL') {
      if (this.stage === 'WAIT_ARM') {
        if (rsiValue < low) this.extreme = true;
        else if (this.extreme && rsiValue > low) {
          this.stage = 'WAIT_ENTRY';
          this.extreme = false;
          this.log(i, 'INFO', 'ARM',
            `📍 ĐIỂM CHỜ BÁN | RSI xuống dưới ${g(low)} rồi cắt lên ${rsiValue.toFixed(1)} | Chờ RSI vượt ${g(high)} rồi cắt xuống | M1 ${timeText(barTime)}`);
        }
      } else {
        if (rsiValue > high) this.extreme = true;
        else if (this.extreme && rsiValue < high) return true;
      }
    }
    return false;
  }

  private stepExit(rsiValue: number) {
    if (this.exitSide === 'BUY') {
      if (rsiValue > this.rsiHigh) this.exitSeen = true;
      else if (this.exitSeen && rsiValue < this.rsiHigh) return true;
    } else if (this.exitSide === 'SELL') {
      if (rsiValue < this.rsiLow) this.exitSeen = true;
      else if (this.exitSeen && rsiValue > this.rsiLow) return true;
    }
    return false;
  }

  private calcSl(side: Side, k: number, entry: number): [number | null, string] {
    const lookback = this.slLookback;
    const maxDistance = this.slMaxPips * PIP_TO_PRICE;
    const a = Math.max(0, k - lookback + 1);
    if (k + 1 - a < lookback) return [null, 'Không đủ nến để tìm đáy/đỉnh SL'];

    if (side === 'BUY') {
      let lo = Infinity;
      for (let q = a; q <= k; q++) lo = Math.min(lo, this.m1.low[q]);
      const sl = Math.max(lo - SL_BUFFER, entry - maxDistance);
      if (sl >= entry) return [null, 'Giá đã nằm dưới đáy 10 nến'];
      return [sl, ''];
    }
    let hi = -Infinity;
    for (let q = a; q <= k; q++) hi = Math.max(hi, this.m1.high[q]);
    const sl = Math.min(hi + SL_BUFFER, entry + maxDistance);
    if (sl <= entry) return [null, 'Giá đã nằm trên đỉnh 10 nến'];
    return [sl, ''];
  }

  decide(i: number, b: number, inTime: boolean) {
    if (this.invalid) return;

    const broker = this.broker;
    const pos = broker.position;
    const h1 = this.checkH1(i);
    if (!h1) return;

    const h1Text = `H1 ${timeText(h1.time)}: Close=${h1.close.toFixed(2)} ${h1.side === 'BUY' ? '>' : h1.side === 'SELL' ? '<' : '='} SMA${this.smaPeriod}=${h1.sma.toFixed(2)}`;

    if (h1.side !== this.side) {
      if (this.side !== null) {
        this.log(i, 'INFO', 'H1', `🔄 H1 ĐỔI HƯỚNG | ${this.side} -> ${h1.side || 'KHÔNG RÕ'} | ${h1Text} | Bỏ trạng thái chờ`);
      } else {
        this.log(i, 'INFO', 'H1', `🧭 H1 | Chỉ ${h1.side || '—'} | ${h1Text}`);
      }
      this.side = h1.side;
      this.resetSetup();
    }

    // Nến M1 đã đóng chưa xét (lần đầu chỉ lấy nến vừa đóng)
    const lastClosed = b - 1;
    if (lastClosed < 0) return;
    const start = this.nextBar === null ? lastClosed : this.nextBar;

    for (let k = start; k <= lastClosed; k++) {
      const rsiValue = this.rsi[k];
      this.nextBar = k + 1;
      if (!Number.isFinite(rsiValue)) continue;
      const barTime = this.m1.time[k];

      // ---------- Đang có lệnh: TP theo RSI ----------
      if (pos) {
        if (!this.rsiExit) continue;
        if (this.exitSide !== pos.side) {
          this.exitSide = pos.side;
          this.exitSeen = false;
        }
        if (this.stepExit(rsiValue)) {
          this.exitSeen = false;
          this.resetSetup();
          this.log(i, 'TRADE', 'EXIT',
            `🎯 TP THEO RSI | ${pos.side}: RSI${this.rsiPeriod} ` +
              (pos.side === 'BUY'
                ? `vượt ${g(this.rsiHigh)} rồi xuống ${rsiValue.toFixed(1)}`
                : `xuống dưới ${g(this.rsiLow)} rồi lên ${rsiValue.toFixed(1)}`) +
              ` | M1 ${timeText(barTime)} | Đóng lệnh`);
          broker.close(i, 'RSI_EXIT');
          return;
        }
        continue;
      }

      this.exitSide = null;
      this.exitSeen = false;

      if (this.side === null || !inTime) continue;
      if (!this.stepEntry(i, rsiValue, barTime)) continue;

      const side = this.side;
      const entry = side === 'BUY' ? this.ask(i) : this.bid(i);
      const [slRaw, why] = this.calcSl(side, k, entry);
      this.resetSetup();

      if (slRaw === null) {
        this.log(i, 'WARN', 'BLOCK', `⛔ BỎ TÍN HIỆU ${side} | ${why}`);
        continue;
      }

      const sl = this.round(slRaw);
      const price = entry;
      if ((side === 'BUY' && sl >= price) || (side === 'SELL' && sl <= price)) {
        this.log(i, 'WARN', 'BLOCK', `⛔ ${side} bỏ qua | Price=${price} | SL=${sl}`);
        return;
      }

      const tpDist = Math.abs(price - sl) * this.rr;
      const tp = this.round(side === 'BUY' ? price + tpDist : price - tpDist);

      const reason = `${h1Text} | RSI${this.rsiPeriod} ` +
        (side === 'BUY'
          ? `xuống dưới ${g(this.rsiLow)} rồi cắt lên, nến xác nhận RSI=${rsiValue.toFixed(1)}`
          : `vượt ${g(this.rsiHigh)} rồi cắt xuống, nến xác nhận RSI=${rsiValue.toFixed(1)}`) +
        ` | M1 ${timeText(barTime)}`;

      this.log(i, 'TRADE', 'PASS',
        `💹 VÀO ${side} | ${reason} | Entry≈${price.toFixed(2)} | SL=${sl} (${Math.abs(price - sl).toFixed(2)} giá) | ` +
          `TP=${tp} (SL × R:R ${g(this.rrRisk)}:${g(this.rrReward)})` + (this.rsiExit ? ' + chốt sớm theo RSI' : ''));

      broker.openMarket(i, side, sl, tp, reason, {
        rsi: roundTo(rsiValue, 2), h1_sma: roundTo(h1.sma, 3), confirm_time: barTime,
      });
      return;
    }
  }

  series(): SeriesDef[] {
    if (this.invalid) return [];
    return [
      { id: 'h1_sma', name: `SMA${this.smaPeriod} H1`, tf: 'ANY', pane: 0, color: '#22d3ee', step: true, data: seriesPoints(this.h1.time, this.h1Sma, 3, H1) },
      { id: 'rsi', name: `RSI${this.rsiPeriod} M1`, tf: 'M1', pane: 1, color: '#a78bfa', levels: [this.rsiLow, this.rsiHigh], data: seriesPoints(this.m1.time, this.rsi, 2) },
    ];
  }
}
