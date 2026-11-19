import { roundTo } from '../market/bars';
import type { MarketData } from './data';

/**
 * Broker mô phỏng chạy trên TICK THẬT (bid / ask) — không gọi API / MT5 nào.
 *
 * Khớp lệnh giống MT5:
 *   BUY  mở theo ASK, đóng theo BID   -> SL khi Bid <= SL, TP khi Bid >= TP
 *   SELL mở theo BID, đóng theo ASK   -> SL khi Ask >= SL, TP khi Ask <= TP
 *   BUY STOP  khớp khi Ask >= giá đặt ; SELL STOP khớp khi Bid <= giá đặt
 *   Giá khớp = giá của tick chạm mức (có trượt giá khi giá nhảy qua mức).
 *
 * Bảo vệ lợi nhuận (protected_sl của bot live):
 *   Break Even : đạt X% quãng Entry->TP -> dời SL về Entry
 *   Trailing   : đạt Y% quãng Entry->TP -> SL khóa Z% lợi nhuận đang có
 *   SL chỉ dời theo hướng có lợi, có hiệu lực từ tick kế tiếp.
 *
 * Chuỗi lot: thắng (lãi >= 0) -> L1 ; thua -> L2, L3, L4, L5 ; xong lệnh L5 (thắng hay thua) -> quay lại L1.
 */

export type Side = 'BUY' | 'SELL';
export type LogFn = (ms: number, level: string, category: string, text: string) => void;

export type SlMove = { ms: number; sl: number; kind: 'BE' | 'TRAIL' };

export type Position = {
  id: number;
  side: Side;
  lot: number;
  level: number | null;
  entry: number;
  sl: number;
  sl0: number;
  tp: number;
  open_i: number;
  open_ms: number;
  reason: string;
  meta: Record<string, any>;
  best: number;
  worst: number;
  sl_moves: SlMove[];
};

export type Pending = {
  id: number;
  type: 'BUY_STOP' | 'SELL_STOP';
  side: Side;
  price: number;
  sl: number;
  tp: number;
  lot: number;
  level: number | null;
  placed_ms: number;
  expire_ms: number | null;
  reason: string;
  meta: Record<string, any>;
};

export type Trade = {
  id: number;
  side: Side;
  lot: number;
  level: number | null;
  entry_ms: number;
  entry: number;
  sl: number;
  sl_final: number;
  tp: number;
  exit_ms: number;
  exit: number;
  exit_reason: string;
  points: number;
  pips: number;
  r: number | null;
  profit: number;
  result: 'WIN' | 'LOSS';
  mfe: number;
  mae: number;
  balance: number;
  reason: string;
  meta: Record<string, any>;
  sl_moves: SlMove[];
};

export type OrderRecord = {
  id: number;
  type: string;
  side: Side;
  price: number;
  sl: number;
  tp: number;
  lot: number;
  placed_ms: number;
  end_ms: number;
  status: 'FILLED' | 'CANCELLED';
  note: string;
};

export type ProcessEvent = ['filled' | 'expired' | 'closed', number] | null;

const SL_MOVE_LOG_STEP = 0.1;

export function num(v: any): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function readProtect(cfg: Record<string, any>) {
  const params = {
    be: !!cfg.be,
    trailing: !!cfg.trailing,
    beTrigger: num(cfg.be_trigger_pct),
    trailingTrigger: num(cfg.trailing_trigger_pct),
    trailingLock: num(cfg.trailing_lock_pct),
  };
  const errors: string[] = [];

  if (params.be && (params.beTrigger === null || !(params.beTrigger > 0 && params.beTrigger <= 100))) {
    errors.push(`Break Even % TP=${cfg.be_trigger_pct} (0 < x ≤ 100)`);
  }
  if (params.trailing) {
    if (params.trailingTrigger === null || !(params.trailingTrigger > 0 && params.trailingTrigger <= 100)) {
      errors.push(`Trailing % TP=${cfg.trailing_trigger_pct} (0 < x ≤ 100)`);
    }
    if (params.trailingLock === null || !(params.trailingLock > 0 && params.trailingLock < 100)) {
      errors.push(`Trailing khóa % lời=${cfg.trailing_lock_pct} (0 < x < 100)`);
    }
  }
  return { params, errors };
}

export class Broker {
  readonly t: Float64Array;
  readonly bid: Float64Array;
  readonly ask: Float64Array;
  readonly contract: number;
  readonly digits: number;

  readonly initialBalance: number;
  balance: number;

  private lot: number | null;
  private multiLot: boolean;
  private lots: number[];
  lotIndex = 0;

  protect: ReturnType<typeof readProtect>['params'];
  configErrors: string[];

  position: Position | null = null;
  pending: Pending | null = null;
  trades: Trade[] = [];
  orders: OrderRecord[] = [];
  private nextId = 1;

  constructor(data: MarketData, cfg: Record<string, any>, private log: LogFn) {
    this.t = data.t;
    this.bid = data.bid;
    this.ask = data.ask;
    this.contract = data.contractSize;
    this.digits = data.digits;

    this.initialBalance = Number(cfg.initial_balance) || 10000;
    this.balance = this.initialBalance;

    this.lot = num(cfg.lot);
    this.multiLot = !!cfg.multi_lot;
    this.lots = (Array.isArray(cfg.lots) ? cfg.lots : [])
      .map(num)
      .filter((x: number | null): x is number => x !== null && x > 0)
      .slice(0, 5);

    const p = readProtect(cfg);
    this.protect = p.params;
    this.configErrors = p.errors;
    if (p.errors.length) {
      this.protect.be = false;
      this.protect.trailing = false;
    }
  }

  private f(x: number) {
    return x.toFixed(this.digits);
  }

  // ----------------------------------------------------------
  // LOT
  // ----------------------------------------------------------

  resolveLot(): [number, number | null] | [null, null] {
    if (this.multiLot) {
      if (!this.lots.length) return [null, null];
      const index = Math.min(this.lotIndex, this.lots.length - 1);
      return [this.lots[index], index + 1];
    }
    if (this.lot && this.lot > 0) return [this.lot, null];
    return [null, null];
  }

  afterCloseLot(profit: number) {
    if (!this.multiLot || !this.lots.length) return;
    const last = this.lots.length - 1;
    if (profit >= 0 || this.lotIndex >= last) this.lotIndex = 0; // thắng -> L1 ; lệnh ở L cuối (L5) thắng hay thua -> L1
    else this.lotIndex += 1; // thua -> L2, L3, L4, L5
  }

  // ----------------------------------------------------------
  // LỆNH
  // ----------------------------------------------------------

  private newPosition(i: number, side: Side, price: number, sl: number, tp: number, lot: number, level: number | null, reason: string, meta: Record<string, any>) {
    this.position = {
      id: this.nextId++,
      side,
      lot,
      level,
      entry: price,
      sl,
      sl0: sl,
      tp,
      open_i: i,
      open_ms: this.t[i],
      reason,
      meta: meta || {},
      best: 0,
      worst: 0,
      sl_moves: [],
    };
    return this.position;
  }

  openMarket(i: number, side: Side, sl: number, tp: number, reason = '', meta: Record<string, any> = {}) {
    const [lot, level] = this.resolveLot();
    if (lot === null) {
      this.log(this.t[i], 'ERROR', 'LOT', '❌ Lot không hợp lệ | Không vào lệnh');
      return null;
    }
    const price = side === 'BUY' ? this.ask[i] : this.bid[i];
    const pos = this.newPosition(i, side, price, sl, tp, lot, level, reason, meta);
    this.log(
      pos.open_ms,
      'TRADE',
      'OPEN',
      `✅ ${side} #${pos.id} | Lot=${lot}${level ? ` (L${level})` : ''} | Giá=${this.f(price)} | SL=${this.f(sl)} | TP=${this.f(tp)}`,
    );
    return pos;
  }

  placeStop(i: number, side: Side, price: number, sl: number, tp: number, expireMs: number | null, reason = '', meta: Record<string, any> = {}) {
    const [lot, level] = this.resolveLot();
    if (lot === null) {
      this.log(this.t[i], 'ERROR', 'LOT', '❌ Lot không hợp lệ | Không đặt lệnh chờ');
      return null;
    }
    this.pending = {
      id: this.nextId++,
      type: side === 'BUY' ? 'BUY_STOP' : 'SELL_STOP',
      side,
      price,
      sl,
      tp,
      lot,
      level,
      placed_ms: this.t[i],
      expire_ms: expireMs || null,
      reason,
      meta,
    };
    this.log(
      this.t[i],
      'TRADE',
      'PENDING',
      `📌 ${this.pending.type} #${this.pending.id} | Lot=${lot} | Giá đặt=${this.f(price)} | SL=${this.f(sl)} | TP=${this.f(tp)}`,
    );
    return this.pending;
  }

  cancelPending(i: number, reason: string) {
    const p = this.pending;
    if (!p) return;
    this.orders.push({
      id: p.id, type: p.type, side: p.side, price: p.price, sl: p.sl, tp: p.tp, lot: p.lot,
      placed_ms: p.placed_ms, end_ms: this.t[i], status: 'CANCELLED', note: reason,
    });
    this.log(this.t[i], 'WARN', 'CANCEL', `🗑 HỦY LỆNH CHỜ #${p.id} | ${reason}`);
    this.pending = null;
  }

  close(i: number, reason: string): Trade | null {
    const pos = this.position;
    if (!pos) return null;
    const price = pos.side === 'BUY' ? this.bid[i] : this.ask[i];
    return this.finish(i, price, reason);
  }

  private finish(i: number, price: number, exitReason: string): Trade {
    const pos = this.position!;
    const buy = pos.side === 'BUY';
    const diff = buy ? price - pos.entry : pos.entry - price;
    const profit = roundTo(diff * this.contract * pos.lot, 2);
    const risk = Math.abs(pos.entry - pos.sl0);
    const d = this.digits;

    this.balance = roundTo(this.balance + profit, 2);

    const trade: Trade = {
      id: pos.id,
      side: pos.side,
      lot: pos.lot,
      level: pos.level,
      entry_ms: pos.open_ms,
      entry: roundTo(pos.entry, d),
      sl: roundTo(pos.sl0, d),
      sl_final: roundTo(pos.sl, d),
      tp: roundTo(pos.tp, d),
      exit_ms: this.t[i],
      exit: roundTo(price, d),
      exit_reason: exitReason,
      points: roundTo(diff, d),
      pips: roundTo(diff * 10, 1),
      r: risk > 0 ? roundTo(diff / risk, 2) : null,
      profit,
      result: profit >= 0 ? 'WIN' : 'LOSS',
      mfe: roundTo(pos.best, d),
      mae: roundTo(pos.worst, d),
      balance: this.balance,
      reason: pos.reason,
      meta: pos.meta,
      sl_moves: pos.sl_moves,
    };

    this.trades.push(trade);
    this.position = null;
    this.afterCloseLot(profit);

    this.log(
      trade.exit_ms,
      'TRADE',
      'CLOSE',
      `${profit >= 0 ? '🟢' : '🔴'} ĐÓNG ${trade.side} #${trade.id} | ${exitReason} | Giá=${this.f(price)} | ` +
        `${trade.pips >= 0 ? '+' : ''}${trade.pips.toFixed(1)} pip | P/L=${profit >= 0 ? '+' : ''}${profit.toFixed(2)} | Số dư=${this.balance.toFixed(2)}`,
    );
    return trade;
  }

  // ----------------------------------------------------------
  // XỬ LÝ TICK [a, e)
  // ----------------------------------------------------------

  process(a: number, e: number): ProcessEvent {
    if (a >= e) return null;
    if (this.pending) return this.processPending(a, e);
    if (this.position) return this.processPosition(a, e);
    return null;
  }

  private processPending(a: number, e: number): ProcessEvent {
    const p = this.pending!;

    for (let i = a; i < e; i++) {
      const hit = p.side === 'BUY' ? this.ask[i] >= p.price : this.bid[i] <= p.price;

      // Cùng tick: lệnh trên server khớp trước khi bot kịp hủy.
      if (hit) {
        const price = p.side === 'BUY' ? this.ask[i] : this.bid[i];
        this.orders.push({
          id: p.id, type: p.type, side: p.side, price: p.price, sl: p.sl, tp: p.tp, lot: p.lot,
          placed_ms: p.placed_ms, end_ms: this.t[i], status: 'FILLED', note: `Khớp ${this.f(price)}`,
        });
        this.pending = null;
        const pos = this.newPosition(i, p.side, price, p.sl, p.tp, p.lot, p.level, p.reason, {
          ...p.meta,
          order_id: p.id,
          order_price: p.price,
        });
        this.log(
          pos.open_ms,
          'TRADE',
          'OPEN',
          `✅ KHỚP ${p.type} #${pos.id} | Lot=${p.lot} | Giá đặt=${this.f(p.price)} | Giá khớp=${this.f(price)} | ` +
            `SL=${this.f(p.sl)} | TP=${this.f(p.tp)}`,
        );
        return ['filled', i];
      }

      if (p.expire_ms && this.t[i] >= p.expire_ms) {
        this.cancelPending(i, 'Hết hạn lệnh chờ');
        return ['expired', i];
      }
    }
    return null;
  }

  private processPosition(a: number, e: number): ProcessEvent {
    const pos = this.position!;
    const buy = pos.side === 'BUY';
    const prices = buy ? this.bid : this.ask;
    const { entry, tp } = pos;
    const sl = pos.sl;
    const prot = this.protect;
    const tpDist = Math.abs(tp - entry);
    const dynamic = (prot.be || prot.trailing) && tpDist > 0;

    const worst = buy ? -Infinity : Infinity;
    let acc = worst; // SL ứng viên tốt nhất đã đạt (tới tick trước)
    let prevEff = sl;
    let last = pos.sl;

    for (let i = a; i < e; i++) {
      const price = prices[i];

      // SL hiệu lực ở tick này = mức đã đạt ở các tick TRƯỚC
      const slEff = dynamic ? (buy ? Math.max(sl, acc) : Math.min(sl, acc)) : sl;

      // MFE / MAE
      const fav = buy ? price - entry : entry - price;
      if (fav > pos.best) pos.best = fav;
      if (-fav > pos.worst) pos.worst = -fav;

      // Ghi nhận SL đã dời
      if (dynamic && slEff !== prevEff) {
        if (Math.abs(slEff - last) >= SL_MOVE_LOG_STEP) {
          const kind = Math.abs(slEff - entry) < 1e-9 ? 'BE' : 'TRAIL';
          pos.sl_moves.push({ ms: this.t[i], sl: roundTo(slEff, this.digits), kind });
          if (pos.sl_moves.length === 1 || kind === 'BE') {
            this.log(this.t[i], 'INFO', 'SLMOVE',
              `🛡 DỜI SL #${pos.id} | ${kind === 'BE' ? 'Hòa vốn' : 'Trailing'} | SL ${this.f(last)} -> ${this.f(slEff)}`);
          }
          last = slEff;
        }
      }
      prevEff = slEff;

      // Mức SL ứng viên tại tick này (có hiệu lực từ tick sau)
      if (dynamic) {
        const profit = fav;
        const progress = (profit / tpDist) * 100;
        let cand = worst;
        if (prot.be && progress >= prot.beTrigger!) cand = entry;
        if (prot.trailing && progress >= prot.trailingTrigger!) {
          const locked = (profit * prot.trailingLock!) / 100;
          const trail = buy ? entry + locked : entry - locked;
          cand = buy ? Math.max(cand, trail) : Math.min(cand, trail);
        }
        acc = buy ? Math.max(acc, cand) : Math.min(acc, cand);
      }

      const hitSl = buy ? price <= slEff : price >= slEff;
      const hitTp = buy ? price >= tp : price <= tp;

      if (hitSl || hitTp) {
        if (dynamic) pos.sl = buy ? Math.max(sl, acc) : Math.min(sl, acc);

        let reason: string;
        if (hitTp && !hitSl) reason = 'TP';
        else {
          const moved = buy ? slEff > pos.sl0 + 1e-9 : slEff < pos.sl0 - 1e-9;
          reason = !moved ? 'SL' : Math.abs(slEff - entry) < 1e-9 ? 'BE' : 'TRAIL';
        }
        this.finish(i, price, reason);
        return ['closed', i];
      }
    }

    if (dynamic) pos.sl = buy ? Math.max(sl, acc) : Math.min(sl, acc);
    return null;
  }
}
