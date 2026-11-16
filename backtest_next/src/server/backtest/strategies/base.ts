import { num } from '../broker';
import type { Broker } from '../broker';
import type { MarketData, M1Bars } from '../data';
import type { BacktestEngine } from '../engine';
import { npRound, roundTo } from '../../market/bars';

export const PIP_TO_PRICE = 0.1; // 10 pip = 1.0 giá (XAUUSD)

export { num };

export function intOrNull(v: any): number | null {
  const n = num(v);
  return n === null || n !== Math.trunc(n) ? null : n;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** epoch giây -> 'YYYY-MM-DD HH:MM' (giờ MT5) */
export function timeText(sec: number) {
  const d = new Date(sec * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Giống f"{x:g}" của Python cho số thường gặp. */
export const g = (x: number) => String(Number(x.toPrecision(6)));

export function getRr(cfg: Record<string, any>): [number | null, number | null, number | null] {
  const risk = num(cfg.rr_risk);
  const reward = num(cfg.rr_reward);
  if (risk === null || reward === null || risk <= 0 || reward <= 0) return [null, null, null];
  return [risk, reward, reward / risk];
}

export const finite = (...xs: number[]) => xs.every((x) => Number.isFinite(x));

export type SeriesPoint = { time: number; value: number };

export type SeriesDef = {
  id: string;
  name: string;
  tf: string;
  pane: number;
  color: string;
  step?: boolean;
  levels?: number[];
  data: SeriesPoint[];
};

export function seriesPoints(times: ArrayLike<number>, values: ArrayLike<number>, digits = 3, shift = 0): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) out.push({ time: times[i] + shift, value: npRound(v, digits) });
  }
  return out;
}

/**
 * Khung chung cho 1 phương pháp.
 * decide(i, b, inTime) gọi ở mỗi tick đầu nến M1 (và ngay sau khi lệnh đóng):
 *   i      : chỉ số tick hiện tại -> giá bid/ask, thời gian
 *   b      : chỉ số nến M1 đang chạy -> nến đã đóng là m1[0..b-1]
 *   inTime : đang trong khung giờ giao dịch hay không
 */
export abstract class Strategy {
  static key = '';
  invalid: string | null = null;
  readonly data: MarketData;
  readonly broker: Broker;
  readonly m1: M1Bars;
  readonly digits: number;

  constructor(readonly engine: BacktestEngine, readonly cfg: Record<string, any>) {
    this.data = engine.data;
    this.broker = engine.broker;
    this.m1 = this.data.m1;
    this.digits = this.data.digits;
  }

  /**
   * Engine gọi ngay sau khi tạo đối tượng. KHÔNG gọi prepare() trong constructor:
   * thuộc tính khai báo ở lớp con (vd `private x = null`) được gán SAU constructor lớp cha
   * và sẽ ghi đè giá trị prepare() vừa đặt.
   */
  init() {
    this.prepare();
    if (this.invalid) this.engine.log(this.engine.startMs, 'ERROR', 'CONFIG', `❌ Cấu hình sai: ${this.invalid} | Không vào lệnh`);
    return this;
  }

  protected abstract prepare(): void;
  abstract decide(i: number, b: number, inTime: boolean): void;
  onClosed(_trade: any) {}
  onFilled() {}
  onExpired() {}
  series(): SeriesDef[] {
    return [];
  }

  nowMs(i: number) {
    return this.data.t[i];
  }
  nowSec(i: number) {
    return Math.floor(this.data.t[i] / 1000);
  }
  bid(i: number) {
    return this.data.bid[i];
  }
  ask(i: number) {
    return this.data.ask[i];
  }
  log(i: number, level: string, category: string, text: string, force = true) {
    this.engine.log(this.nowMs(i), level, category, text, force);
  }
  fmt(price: number) {
    return price.toFixed(this.digits);
  }
  round(x: number) {
    return roundTo(x, this.digits);
  }
}

export type StrategyClass = new (engine: BacktestEngine, cfg: Record<string, any>) => Strategy;
