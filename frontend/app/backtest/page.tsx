'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import MarketChart from '../../components/MarketChart';
import { api } from '../../lib/api';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';

type Trade = {
  id: number;
  side: 'BUY' | 'SELL';
  entryTime: number;
  entryCandleTime: string;
  entryPrice: number;
  exitTime: number;
  exitCandleTime: string;
  exitPrice: number;
  lot: number;
  pnl: number;
  result: 'WIN' | 'LOSS' | 'BE';
  reason: string;
};

type FilterStat = {
  checks: number;
  blocked: number;
  correct: number;
  wrong: number;
  unknown: number;
  skippedCandlePower?: number;
};

type RunConfig = {
  strategyMode: 'ma' | 'bollinger';
  fast: number; slow: number; trend: number; maTrendEnabled: boolean;
  sideway1Filter: boolean;
  bbTrendM15: boolean; bbSidewayM15: boolean; bbTrendM1: boolean; bbSidewayM1: boolean;
  bbSlopeM15Pips: number; bbWidthM15: number; bbSlopeM1Pips: number; bbWidthM1: number;
  bbSidewaySlopeM15Pips: number; bbSidewayWidthM15: number; bbSidewaySlopeM1Pips: number; bbSidewayWidthM1: number;
  antiFomo: boolean; rrRisk: number; rrReward: number;
  breakEven: boolean; trailing: boolean; fridayLock: boolean; useLotChain: boolean;
  lotChain: number[]; baseLot: number; useTradingSession: boolean;
  sessionFrom: string; sessionTo: string;
};

type SignalAudit = {
  index: number; time: number; candle_time: string; side: 'BUY' | 'SELL'; price: number;
  status: 'SIGNAL' | 'BLOCKED' | 'ENTERED' | 'SKIPPED';
  reason: string;
};

type ConfigRecommendation = {
  id: string;
  title: string;
  reason: string;
  expected: string;
  config: RunConfig;
};

type BacktestStats = {
  sideway: FilterStat;
  maTrend: FilterStat;
  bollinger: { trendM15: FilterStat; sidewayM15: FilterStat; trendM1: FilterStat; sidewayM1: FilterStat };
  fomo: FilterStat;
  session: FilterStat;
  friday: FilterStat;
  totalSignals: number;
  acceptedSignals: number;
  marketEntries: number;
  skippedOpen: number;
  noTrade: number;
  advice: string[];
  sessionAdvisor: { bestWindow: string; bestHour: string; bestPnl: number; bestWinRate: number; trades: number; recommendation: string; };
};

const emptyFilterStat = (): FilterStat => ({ checks: 0, blocked: 0, correct: 0, wrong: 0, unknown: 0, skippedCandlePower: 0 });

const emptySessionAdvisor = () => ({ bestWindow: '—', bestHour: '—', bestPnl: 0, bestWinRate: 0, trades: 0, recommendation: 'Chưa đủ dữ liệu để đưa ra khuyến nghị.' });

// ============================================================
// HẰNG SỐ — KHỚP VỚI BOT LIVE (decision_engine.py / bollinger_engine.py)
// ============================================================
const SIDEWAY_RANGE = 3;        // ±3 giá
const FOMO_MULTIPLIER = 2;      // 200%
const FOMO_BODY_LOOKBACK = 3;   // 3 nến trước nến Cross
const SL_LOOKBACK = 10;         // 10 nến trước nến tín hiệu
const SL_BUFFER = 0.1;          // 0.1 giá
const SL_MAX_DISTANCE = 10;     // SL tối đa 10 giá so với Entry
const BB_RR_REWARD = 0.9;       // Bollinger: TP = 1 : 0.9

/**
 * SMA giống pandas close.rolling(period).mean() của bot live.
 * Các nến chưa đủ `period` vẫn có giá trị trung bình tích lũy để vẽ chart,
 * nhưng được đánh dấu *_ready = false và KHÔNG dùng để tạo/lọc tín hiệu
 * (live: rolling trả NaN ở vùng này).
 */
function calcIndicators(candles: any[], fast: number, slow: number, trend: number) {
  const out = candles.map((c) => ({ ...c }));
  const closes = out.map((c) => Number(c.close));
  const sma = (periodRaw: number) => {
    const period = Math.max(1, Math.floor(Number(periodRaw) || 0));
    const values: number[] = [];
    const ready: boolean[] = [];
    let sum = 0;
    for (let i = 0; i < closes.length; i++) {
      sum += closes[i];
      if (i >= period) sum -= closes[i - period];
      const count = Math.min(i + 1, period);
      values.push(sum / count);
      ready.push(i >= period - 1);
    }
    return { values, ready };
  };
  const f = sma(fast), s = sma(slow), t = sma(trend);
  return out.map((c, i) => ({
    ...c,
    // Tên cột giữ nguyên như live (ema_fast/ema_slow/ma_trend) nhưng giá trị là SMA.
    ema_fast: f.values[i], ema_slow: s.values[i], ma_trend: t.values[i],
    ma_fast: f.values[i], ma_slow: s.values[i], ema_trend: t.values[i],
    fast_ready: f.ready[i], slow_ready: s.ready[i], trend_ready: t.ready[i],
  }));
}


function aggregateM15(candles: any[]) {
  const buckets = new Map<number, any[]>();
  for (const c of candles) {
    const t = Number(c.time);
    if (!Number.isFinite(t)) continue;
    const bucket = Math.floor(t / 900) * 900;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket)!.push(c);
  }
  return [...buckets.entries()].sort((a,b)=>a[0]-b[0]).map(([time, rows]) => ({
    time, candle_time: String(rows[0].candle_time ?? ''),
    open: Number(rows[0].open), high: Math.max(...rows.map(x=>Number(x.high))),
    low: Math.min(...rows.map(x=>Number(x.low))), close: Number(rows[rows.length-1].close),
    volume: rows.reduce((sum,x)=>sum+Number(x.tick_volume ?? x.volume ?? 0),0),
    sourceCount: rows.length,
  }));
}

function addBollinger(candles: any[], period = 20, multiplier = 2) {
  const closes = candles.map(c => Number(c.close));
  return candles.map((c, i) => {
    if (i < period - 1) return { ...c, bbMiddle: null, bbUpper: null, bbLower: null, bbWidth: null };
    const window = closes.slice(i-period+1, i+1);
    const mean = window.reduce((a,b)=>a+b,0)/period;
    const variance = window.reduce((a,b)=>a+Math.pow(b-mean,2),0)/period;
    const sd = Math.sqrt(variance);
    return { ...c, bbMiddle: mean, bbUpper: mean+multiplier*sd, bbLower: mean-multiplier*sd, bbWidth: 4*sd };
  });
}

function candleBodyRatio(c: any) {
  const range = Number(c.high) - Number(c.low);
  if (!Number.isFinite(range) || range <= 0) return 0;
  return Math.abs(Number(c.close) - Number(c.open)) / range;
}

/**
 * Bollinger Band rules from the formula image.
 *
 * Important MT5 indexing:
 *   [1] = latest fully closed candle
 *   [2] = candle immediately before [1]
 *
 * The arrays here are chronological (oldest -> newest), so when `i` is
 * the latest closed candle, [1] maps to candles[i] and [2] maps to candles[i - 1].
 * BB middle = SMA20, upper/lower = SMA20 +/- 2 standard deviations.
 */
function isBollingerTrend(
  candles: any[],
  i: number,
  pipThreshold: number,
  widthThreshold: number,
  isM1 = false,
): boolean {
  // Công thức: [1] là nến đóng gần nhất, [2] là nến đóng liền trước; dùng SMA20 của chính timeframe này.
  // Mảng dữ liệu sắp theo thời gian tăng dần nên [1] = candles[i], [2] = candles[i - 1].
  if (!Array.isArray(candles) || i < 20 || i >= candles.length || i < 1) return false;

  const c1 = candles[i];
  const c2 = candles[i - 1];
  if (!c1 || !c2) return false;

  const values = [
    c1.bbMiddle, c1.bbUpper, c1.bbLower, c1.close,
    c2.bbMiddle, c2.bbUpper, c2.bbLower, c2.close,
    c2.open, c2.high, c2.low,
  ];
  if (!values.every(v => v !== null && v !== undefined && Number.isFinite(Number(v)))) return false;

  // Delta SMA20 luôn lấy trên đúng timeframe đang kiểm tra: M15 dùng SMA20_M15; M1 dùng SMA20_M1.
  const deltaSma20 = Number(c1.bbMiddle) - Number(c2.bbMiddle);
  const width = Number(c1.bbUpper) - Number(c1.bbLower);
  if (!(width > widthThreshold)) return false;

  // Trend mạnh tăng: độ dốc vượt ngưỡng, Close[1] nằm trên SMA20[1],
  // và Upper[1] > Upper[2].
  const bullish =
    deltaSma20 > pipThreshold &&
    Number(c1.close) > Number(c1.bbMiddle) &&
    Number(c1.bbUpper) > Number(c2.bbUpper);

  // Trend mạnh giảm: đối xứng với xu hướng tăng.
  const bearish =
    deltaSma20 < -pipThreshold &&
    Number(c1.close) < Number(c1.bbMiddle) &&
    Number(c1.bbLower) < Number(c2.bbLower);

  if (!isM1) return bullish || bearish;

  // Riêng M1: nến [2] cũng phải đóng cùng phía SMA20 và thân nến >= 70% range.
  const previousBodyStrong = candleBodyRatio(c2) >= 0.70;
  const m1BullishConfirm =
    Number(c2.close) > Number(c2.bbMiddle) && previousBodyStrong;
  const m1BearishConfirm =
    Number(c2.close) < Number(c2.bbMiddle) && previousBodyStrong;

  return (bullish && m1BullishConfirm) || (bearish && m1BearishConfirm);
}

function isBollingerSideway(
  candles: any[],
  i: number,
  pipThreshold: number,
  widthThreshold: number,
): boolean {
  // Sideway: |SMA20 của timeframe đang kiểm tra [1] - [2]| < ngưỡng và BB width < ngưỡng.
  // Giá đóng cửa [1] phải ngược hướng độ dốc SMA20.
  if (!Array.isArray(candles) || i < 20 || i >= candles.length || i < 1) return false;

  const c1 = candles[i];
  const c2 = candles[i - 1];
  if (!c1 || !c2) return false;

  const values = [
    c1.bbMiddle, c1.bbUpper, c1.bbLower, c1.close,
    c2.bbMiddle,
  ];
  if (!values.every(v => v !== null && v !== undefined && Number.isFinite(Number(v)))) return false;

  const deltaSma20 = Number(c1.bbMiddle) - Number(c2.bbMiddle);
  const width = Number(c1.bbUpper) - Number(c1.bbLower);

  const lowSlope = Math.abs(deltaSma20) < pipThreshold;
  const compressed = width < widthThreshold;
  const closeAgainstTrend =
    (deltaSma20 > 0 && Number(c1.close) < Number(c1.bbMiddle)) ||
    (deltaSma20 < 0 && Number(c1.close) > Number(c1.bbMiddle));

  return lowSlope && compressed && closeAgainstTrend;
}

// Phương pháp 2: tạo tín hiệu riêng theo công thức Trend mạnh M1; độ dốc dùng SMA20_M1[1] - SMA20_M1[2].
// Không sử dụng MA Cross / SMA Trend của Phương pháp 1.
function detectBollingerSignals(candles: any[]) {
  const signals: any[] = [];

  // Bollinger signal rules are independent from the Trend/Sideway filters.
  // Arrays are chronological (oldest -> newest):
  // c1 = the prior closed candle, c2 = the newest closed candle (signal candle).
  // BUY: c1 and c2 close above their own SMA20; c2 is bullish and its body >= 70% of range.
  // SELL: c1 and c2 close below their own SMA20; c2 is bearish and its body >= 70% of range.
  // Do not use SMA slope, Bollinger width, Trend, or Sideway thresholds to create signals.
  for (let i = 20; i < candles.length; i++) {
    const c1 = candles[i - 1];
    const c2 = candles[i];
    if (!c1 || !c2) continue;

    const required = [
      c1.bbMiddle, c1.close,
      c2.bbMiddle, c2.open, c2.close, c2.high, c2.low,
    ];
    if (!required.every(v => v !== null && v !== undefined && Number.isFinite(Number(v)))) continue;

    const c2BodyStrong = candleBodyRatio(c2) >= 0.70;
    const bullish =
      Number(c1.close) > Number(c1.bbMiddle) &&
      Number(c2.close) > Number(c2.bbMiddle) &&
      Number(c2.close) > Number(c2.open) &&
      c2BodyStrong;

    const bearish =
      Number(c1.close) < Number(c1.bbMiddle) &&
      Number(c2.close) < Number(c2.bbMiddle) &&
      Number(c2.close) < Number(c2.open) &&
      c2BodyStrong;

    if (bullish) {
      signals.push({
        index: i, time: Number(c2.time),
        candle_time: String(c2.candle_time ?? ''),
        price: Number(c2.close), type: 'BUY_CROSS',
      });
    } else if (bearish) {
      signals.push({
        index: i, time: Number(c2.time),
        candle_time: String(c2.candle_time ?? ''),
        price: Number(c2.close), type: 'SELL_CROSS',
      });
    }
  }
  return signals;
}

// MA Cross: so 2 nến đã đóng liền nhau (giống detect_cross của live).
// Giá Cross = Close của nến Cross. Chỉ xét khi SMA Fast/Slow đã đủ dữ liệu.
function detectCrosses(candles: any[]) {
  const crosses: any[] = [];
  for (let i = 1; i < candles.length; i++) {
    const p = candles[i - 1], c = candles[i];
    if (!p.fast_ready || !p.slow_ready || !c.fast_ready || !c.slow_ready) continue;
    const pf = Number(p.ema_fast), ps = Number(p.ema_slow), cf = Number(c.ema_fast), cs = Number(c.ema_slow);
    if (![pf, ps, cf, cs].every(Number.isFinite)) continue;
    const base = { index: i, time: Number(c.time), candle_time: String(c.candle_time ?? ''), price: Number(c.close) };
    if (pf < ps && cf > cs) crosses.push({ ...base, type: 'BUY_CROSS' });
    else if (pf > ps && cf < cs) crosses.push({ ...base, type: 'SELL_CROSS' });
  }
  return crosses;
}

/**
 * BƯỚC 2.1 — FOMO (giống check_fomo của live)
 *   BUY : CrossPrice − Low nến Cross
 *   SELL: High nến Cross − CrossPrice
 *   > 200% × trung bình |Close − Open| của 3 nến trước nến Cross → BLOCK.
 */
function checkFomo(candles: any[], i: number, crossPrice: number, side: 'BUY' | 'SELL') {
  if (i < FOMO_BODY_LOOKBACK) return { pass: false, distance: 0, avgBody: 0, threshold: 0, reason: 'Không đủ nến' };
  const candle = candles[i];
  const previous = candles.slice(i - FOMO_BODY_LOOKBACK, i);
  const bodies = previous.map((c) => Math.abs(Number(c.close) - Number(c.open)));
  if (!bodies.every(Number.isFinite)) return { pass: false, distance: 0, avgBody: 0, threshold: 0, reason: 'Dữ liệu nến lỗi' };
  const avgBody = bodies.reduce((a, b) => a + b, 0) / FOMO_BODY_LOOKBACK;
  const distance = side === 'BUY' ? crossPrice - Number(candle.low) : Number(candle.high) - crossPrice;
  const threshold = avgBody * FOMO_MULTIPLIER;
  const pass = distance <= threshold;
  return {
    pass, distance, avgBody, threshold,
    reason: pass ? 'Khoảng cách trong giới hạn' : 'Khoảng cách > 200% thân nến TB 3 nến trước',
  };
}

/**
 * BƯỚC 2.2 — SIDEWAY (giống check_sideway của live). Vi phạm 1 trong 2 → BLOCK.
 *   TH1: |CrossPrice − CrossPrice của lệnh thua trước đó trong chuỗi| ≤ 3 (chỉ khi LossStreak ≥ 1)
 *   TH2: |Entry − MA Trend| ≤ 3
 */
function checkSideway(
  crossPrice: number,
  entry: number,
  ma: number | null,
  lossStreak: number,
  lastLossCrossPrice: number | null,
) {
  let th1Block = false;
  let th1Detail = 'Bỏ qua (chưa có lệnh thua trong chuỗi)';
  if (lossStreak >= 1 && lastLossCrossPrice !== null) {
    const gap = Math.abs(crossPrice - lastLossCrossPrice);
    th1Block = gap <= SIDEWAY_RANGE;
    th1Detail = `Cross ${crossPrice.toFixed(2)} vs Cross thua ${lastLossCrossPrice.toFixed(2)} (lệch ${gap.toFixed(2)})`;
  }
  let th2Block = false;
  let th2Detail = 'MA Trend chưa có';
  if (ma !== null) {
    const gap = Math.abs(entry - ma);
    th2Block = gap <= SIDEWAY_RANGE;
    th2Detail = `Entry ${entry.toFixed(2)} vs MA Trend ${ma.toFixed(2)} (lệch ${gap.toFixed(2)})`;
  }
  return { pass: !(th1Block || th2Block), th1Block, th1Detail, th2Block, th2Detail };
}
/**
 * SL/TP — dùng 10 nến đã đóng TRƯỚC nến tín hiệu (không gồm nến tín hiệu).
 *
 * MA Cross (decision_engine.calculate_sl_tp):
 *   BUY : khoảng SL = Entry − (Low thấp nhất + 0.1)
 *   SELL: khoảng SL = (High cao nhất − 0.1) − Entry
 *   Khoảng SL ≤ 0 → không vào lệnh. Khoảng SL tối đa 10 giá. TP = khoảng SL × (RR reward / RR risk).
 *
 * Bollinger (bollinger_engine.calculate_sl_tp):
 *   BUY : SL = max(Low thấp nhất − 0.1, Entry − 10)
 *   SELL: SL = min(High cao nhất + 0.1, Entry + 10)
 *   TP = khoảng SL × 0.9.
 */
function calculateSlTp(
  candles: any[],
  index: number,
  side: 'BUY' | 'SELL',
  entry: number,
  method: 'ma' | 'bollinger',
  rr: number,
) {
  if (index < SL_LOOKBACK || !Number.isFinite(entry) || entry <= 0) return null;

  const previous = candles.slice(index - SL_LOOKBACK, index);
  const lows = previous.map((c) => Number(c.low)).filter(Number.isFinite);
  const highs = previous.map((c) => Number(c.high)).filter(Number.isFinite);
  if (lows.length !== SL_LOOKBACK || highs.length !== SL_LOOKBACK) return null;

  const lowest = Math.min(...lows);
  const highest = Math.max(...highs);

  if (method === 'bollinger') {
    if (side === 'BUY') {
      const sl = Math.max(lowest - SL_BUFFER, entry - SL_MAX_DISTANCE);
      const risk = entry - sl;
      return risk > 0 ? { sl, tp: entry + risk * BB_RR_REWARD } : null;
    }
    const sl = Math.min(highest + SL_BUFFER, entry + SL_MAX_DISTANCE);
    const risk = sl - entry;
    return risk > 0 ? { sl, tp: entry - risk * BB_RR_REWARD } : null;
  }

  // MA Cross
  if (!(rr > 0)) return null;
  let distance = side === 'BUY'
    ? entry - (lowest + SL_BUFFER)
    : (highest - SL_BUFFER) - entry;
  if (!(distance > 0)) return null;
  distance = Math.min(distance, SL_MAX_DISTANCE);
  const tpDistance = distance * rr;
  if (!(tpDistance > 0)) return null;
  return side === 'BUY'
    ? { sl: entry - distance, tp: entry + tpDistance }
    : { sl: entry + distance, tp: entry - tpDistance };
}

function favorableMove(side: 'BUY'|'SELL', from: number, to: number) {
  return (to - from) * (side === 'BUY' ? 1 : -1);
}

/**
 * Đánh giá "nếu không chặn thì sao" cho tín hiệu bị filter chặn.
 * Dùng đúng SL/TP của phương pháp; bot live chỉ thoát lệnh bằng SL/TP
 * (không đóng khi có tín hiệu ngược) nên ở đây cũng chỉ xét SL/TP.
 */
function hypotheticalBlockedOutcome(
  candles: any[],
  start: number,
  side: 'BUY' | 'SELL',
  entry: number,
  method: 'ma' | 'bollinger',
  rr: number,
): 'WIN' | 'LOSS' | 'UNKNOWN' {
  const sltp = calculateSlTp(candles, start, side, entry, method, rr);
  if (!sltp) return 'UNKNOWN';

  const horizon = Math.min(candles.length, start + 1 + 24 * 60);
  for (let j = start + 1; j < horizon; j++) {
    const c = candles[j];
    const low = Number(c.low);
    const high = Number(c.high);
    const slHit = side === 'BUY' ? low <= sltp.sl : high >= sltp.sl;
    const tpHit = side === 'BUY' ? high >= sltp.tp : low <= sltp.tp;
    // Cùng 1 nến chạm cả SL và TP → giả định SL trước (bảo thủ).
    if (slHit) return 'LOSS';
    if (tpHit) return 'WIN';
  }
  return 'UNKNOWN';
}


// Hiển thị trực tiếp candle_time từ DB; tuyệt đối không chuyển qua Date/múi giờ.
const fmt = (candleTime?: string | null) => {
  if (!candleTime) return '—';
  const match = String(candleTime).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return String(candleTime);
  const [, yyyy, mm, dd, hh, mi, ss = '00'] = match;
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}:${ss}`;
};

const parseCandleTime = (candleTime: string) => {
  const match = String(candleTime ?? '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  return {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] ?? 0),
  };
};

const candleWeekday = (candleTime: string) => {
  const parts = parseCandleTime(candleTime);
  if (!parts) return -1;
  // UTC chỉ dùng để tính thứ trên các thành phần lịch đã đọc trực tiếp từ candle_time.
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
};

const parseLotChain = (value: string) =>
  value
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0);

export default function Backtest() {
  const router = useRouter();

  const [from, setFrom] = useState('2026-09-01');
  const [to, setTo] = useState('2026-09-30');

  const [strategyMode, setStrategyMode] = useState<'ma' | 'bollinger'>('ma');
  const [fast, setFast] = useState(9);
  const [slow, setSlow] = useState(21);
  const [trend, setTrend] = useState(200);
  const [maTrendEnabled, setMaTrendEnabled] = useState(false);
  const [speed, setSpeed] = useState(1);

  // Filters - match Trend UI config names.
  // Sideway MA Cross: TH1 ±3 so với Cross của lệnh thua trước + TH2 ±3 so với MA Trend.
  const [sideway1Filter, setSideway1Filter] = useState(false);
  // R:R của MA Cross (giống ô Risk : Reward trên bot live). Bollinger cố định 1 : 0.9.
  const [rrRisk, setRrRisk] = useState(1);
  const [rrReward, setRrReward] = useState(0.9);
  const [bbTrendM15, setBbTrendM15] = useState(false);
  const [bbSidewayM15, setBbSidewayM15] = useState(false);
  const [bbTrendM1, setBbTrendM1] = useState(false);
  const [bbSidewayM1, setBbSidewayM1] = useState(false);
  // Slope thresholds are entered in pips. For this XAUUSD rule, 10 pips = 1.0 price, so 50 pips = 5.0 price.
  const [bbSlopeM15Pips, setBbSlopeM15Pips] = useState(50);
  const [bbWidthM15, setBbWidthM15] = useState(10);
  const [bbSlopeM1Pips, setBbSlopeM1Pips] = useState(20);
  const [bbWidthM1, setBbWidthM1] = useState(4);
  // Sideway thresholds are independently editable from Trend-strong thresholds.
  const [bbSidewaySlopeM15Pips, setBbSidewaySlopeM15Pips] = useState(50);
  const [bbSidewayWidthM15, setBbSidewayWidthM15] = useState(10);
  const [bbSidewaySlopeM1Pips, setBbSidewaySlopeM1Pips] = useState(20);
  const [bbSidewayWidthM1, setBbSidewayWidthM1] = useState(4);
  const [chartTimeframe, setChartTimeframe] = useState<'M1'|'M15'>('M1');
  const [antiFomo, setAntiFomo] = useState(false);

  // Position management. BE/Trailing: bot live KHÔNG có → mặc định OFF để backtest giống live.
  const [breakEven, setBreakEven] = useState(false);
  const [trailing, setTrailing] = useState(false);
  const [fridayLock, setFridayLock] = useState(false);

  // Lot chain.
  const [useLotChain, setUseLotChain] = useState(false);
  const [lotChainMode, setLotChainMode] = useState<'default' | 'custom'>('default');
  const [customLotChain, setCustomLotChain] = useState('0.01, 0.02, 0.04, 0.08, 0.16, 0.32');
  const [baseLot, setBaseLot] = useState(0.01);

  // Trading session.
  const [useTradingSession, setUseTradingSession] = useState(false);
  const [sessionFrom, setSessionFrom] = useState('08:00');
  const [sessionTo, setSessionTo] = useState('22:00');

  // Account / bot.
  const [initialBalance] = useState(100000);
  const [botRunning, setBotRunning] = useState(false);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [signalAudit, setSignalAudit] = useState<SignalAudit[]>([]);
  const [botBalance, setBotBalance] = useState(100000);
  const [backtestStats, setBacktestStats] = useState<BacktestStats>({ sideway: emptyFilterStat(), maTrend: emptyFilterStat(), bollinger: { trendM15: emptyFilterStat(), sidewayM15: emptyFilterStat(), trendM1: emptyFilterStat(), sidewayM1: emptyFilterStat() }, fomo: emptyFilterStat(), session: emptyFilterStat(), friday: emptyFilterStat(), totalSignals: 0, acceptedSignals: 0, marketEntries: 0, skippedOpen: 0, noTrade: 0, advice: [], sessionAdvisor: emptySessionAdvisor() });
  const [recommendations, setRecommendations] = useState<ConfigRecommendation[]>([]);
  const [runHistory, setRunHistory] = useState<Array<{ run: number; config: RunConfig; pnl: number; winRate: number; profitFactor: number; drawdown: number; trades: number }>>([]);

  const [data, setData] = useState<any>(null);
  const [visible, setVisible] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!localStorage.getItem('access_token')) router.replace('/login');
  }, [router]);

  useEffect(() => {
    if (!playing || !data) return;

    const id = setInterval(() => {
      setVisible((v) => {
        if (v >= data.candles.length) {
          setPlaying(false);
          return v;
        }
        return v + Math.max(1, Math.round(speed));
      });
    }, 120);

    return () => clearInterval(id);
  }, [playing, data, speed]);

  const candle = data?.candles?.[Math.max(0, visible - 1)];
  const chartCandles = useMemo(() => {
    if (!data?.candles) return [];
    const base = chartTimeframe === 'M15' ? aggregateM15(data.candles) : data.candles;
    return addBollinger(calcIndicators(base, fast, slow, trend));
  }, [data, chartTimeframe, fast, slow, trend]);
  const chartVisible = chartTimeframe === 'M15' ? Math.ceil(visible / 15) : visible;
  const chartCrosses = useMemo(
    () => strategyMode === 'ma'
      ? detectCrosses(chartCandles)
      : detectBollingerSignals(chartCandles),
    [chartCandles, strategyMode, bbSlopeM1Pips, bbWidthM1]
  );

  const lotChain = useMemo(
    () =>
      lotChainMode === 'default'
        ? [0.01, 0.02, 0.04, 0.08, 0.16, 0.32]
        : parseLotChain(customLotChain),
    [lotChainMode, customLotChain]
  );

  const wins = trades.filter((x) => x.result === 'WIN').length;
  const losses = trades.filter((x) => x.result === 'LOSS').length;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const totalPnl = trades.reduce((sum, x) => sum + x.pnl, 0);

  function isWithinTradingSession(candleTime: string) {
    if (!useTradingSession) return true;

    const parts = parseCandleTime(candleTime);
    if (!parts) return false;
    const minutes = parts.hour * 60 + parts.minute;
    const [fh, fm] = sessionFrom.split(':').map(Number);
    const [th, tm] = sessionTo.split(':').map(Number);
    const fromMinutes = fh * 60 + fm;
    const toMinutes = th * 60 + tm;

    if (fromMinutes <= toMinutes) {
      return minutes >= fromMinutes && minutes <= toMinutes;
    }

    return minutes >= fromMinutes || minutes <= toMinutes;
  }

  function isFridayLocked(candleTime: string) {
    if (!fridayLock) return false;
    const parts = parseCandleTime(candleTime);
    return !!parts && candleWeekday(candleTime) === 5 && parts.hour >= 20;
  }

  function resolveLot(lossStreak: number) {
    if (!useLotChain) return baseLot;
    const chain = lotChain.length ? lotChain : [baseLot];
    return chain[Math.min(lossStreak, chain.length - 1)];
  }

  /**
   * Run exactly ONE configuration from the UI.
   * There is deliberately NO optimizer and NO automatic config mutation here.
   */
  function getCurrentConfig(): RunConfig {
    return {
      strategyMode,
      fast,
      slow,
      trend,
      maTrendEnabled,
      sideway1Filter,
      bbTrendM15, bbSidewayM15, bbTrendM1, bbSidewayM1,
      bbSlopeM15Pips, bbWidthM15, bbSlopeM1Pips, bbWidthM1,
      bbSidewaySlopeM15Pips, bbSidewayWidthM15, bbSidewaySlopeM1Pips, bbSidewayWidthM1,
      antiFomo,
      rrRisk,
      rrReward,
      breakEven,
      trailing,
      fridayLock,
      useLotChain,
      lotChain: [...lotChain],
      baseLot,
      useTradingSession,
      sessionFrom,
      sessionTo,
    };
  }

  function configLabel(c: RunConfig) {
    const parts = c.strategyMode === 'ma'
      ? [
          `MA Cross · SMA ${c.fast}/${c.slow} · MA Trend ${c.trend}`,
          c.maTrendEnabled ? 'Trend ON' : 'Trend OFF',
          c.antiFomo ? 'FOMO ON' : 'FOMO OFF',
          c.sideway1Filter ? 'Sideway ON' : 'Sideway OFF',
          `R:R ${c.rrRisk}:${c.rrReward}`,
        ]
      : [
          'Bollinger',
          `Trend M15 ${c.bbTrendM15 ? 'ON' : 'OFF'}`,
          `Sideway M15 ${c.bbSidewayM15 ? 'ON' : 'OFF'}`,
          `Trend M1 ${c.bbTrendM1 ? 'ON' : 'OFF'}`,
          `Sideway M1 ${c.bbSidewayM1 ? 'ON' : 'OFF'}`,
          'R:R 1:0.9',
        ];
    if (c.breakEven) parts.push('BE ON (không có trên live)');
    if (c.trailing) parts.push('Trailing ON (không có trên live)');
    parts.push(c.fridayLock ? 'Friday ON' : 'Friday OFF');
    parts.push(c.useTradingSession ? `Session ${c.sessionFrom}-${c.sessionTo}` : 'Session OFF');
    parts.push(c.useLotChain ? `Lot chain ${c.lotChain.join('/')}` : `Lot ${c.baseLot}`);
    return parts.join(' · ');
  }

  function makeRecommendations(cfg: RunConfig, stats: BacktestStats, result: Trade[]): ConfigRecommendation[] {
    const out: ConfigRecommendation[] = [];
    const clone = (patch: Partial<RunConfig>): RunConfig => ({ ...cfg, lotChain: [...cfg.lotChain], ...patch });
    const add = (id: string, title: string, reason: string, expected: string, patch: Partial<RunConfig>) => {
      if (out.some((x) => x.id === id)) return;
      const next = clone(patch);
      if (configLabel(next) !== configLabel(cfg)) out.push({ id, title, reason, expected, config: next });
    };
    const precision = (st: FilterStat) => (st.blocked > 0 ? (st.correct / st.blocked) * 100 : null);

    // BE / Trailing không có trên bot live → luôn ưu tiên đề xuất tắt để kết quả sát live.
    if (cfg.breakEven || cfg.trailing) {
      add('live-match', 'Tắt BE/Trailing để giống bot live', 'Bot live chỉ thoát lệnh bằng SL/TP; BE/Trailing làm kết quả backtest khác live.', 'Có kết quả sát với bot thật nhất.', { breakEven: false, trailing: false });
    }

    if (cfg.strategyMode === 'ma') {
      const fomoP = precision(stats.fomo);
      const sidewayP = precision(stats.sideway);
      if (result.length === 0) {
        if (cfg.antiFomo) add('fomo-off', 'Thử tắt FOMO', 'Không có lệnh hoàn tất; FOMO có thể đang loại quá nhiều tín hiệu.', 'Kiểm tra số lệnh có tăng mà chất lượng vẫn giữ được.', { antiFomo: false });
        if (cfg.sideway1Filter) add('sideway-off', 'Thử tắt Sideway', 'Không có lệnh hoàn tất; Sideway có thể đang chặn phần lớn tín hiệu.', 'Kiểm chứng riêng tác động của Sideway.', { sideway1Filter: false });
        if (cfg.maTrendEnabled) add('trend-off', 'Thử tắt MA Trend', 'Không có lệnh hoàn tất; MA Trend có thể đang chặn phần lớn Cross.', 'Kiểm chứng riêng tác động của MA Trend.', { maTrendEnabled: false });
      } else {
        if (cfg.antiFomo && stats.fomo.blocked >= 5 && fomoP !== null && fomoP < 55) {
          add('fomo-off', 'Thử FOMO = OFF', `FOMO chặn ${stats.fomo.blocked}/${stats.fomo.checks}, chỉ ${fomoP.toFixed(1)}% số lệnh bị chặn là lệnh thua.`, 'Kiểm tra FOMO có đang loại nhiều tín hiệu tốt hay không.', { antiFomo: false });
        }
        if (!cfg.antiFomo) add('fomo-on', 'Thử FOMO = ON', 'FOMO đang tắt; nên A/B test bộ lọc này.', 'So sánh Win Rate và Profit Factor khi bật FOMO.', { antiFomo: true });
        if (cfg.sideway1Filter && stats.sideway.blocked >= 5 && sidewayP !== null && sidewayP < 55) {
          add('sideway-off', 'Thử Sideway = OFF', `Sideway chặn ${stats.sideway.blocked}/${stats.sideway.checks}, chỉ ${sidewayP.toFixed(1)}% số lệnh bị chặn là lệnh thua.`, 'Kiểm tra Sideway có bỏ lỡ nhiều lệnh tốt hay không.', { sideway1Filter: false });
        }
        if (!cfg.sideway1Filter) add('sideway-on', 'Thử Sideway = ON', 'Sideway đang tắt; nên A/B test TH1 (±3 Cross thua) và TH2 (±3 MA Trend).', 'So sánh drawdown khi bật Sideway.', { sideway1Filter: true });
        if (!cfg.maTrendEnabled) add('trend-on', 'Thử MA Trend = ON', 'MA Trend đang tắt; chỉ vào lệnh cùng hướng trend thường giảm lệnh ngược xu hướng.', 'So sánh Win Rate khi bật MA Trend.', { maTrendEnabled: true });
      }
    } else {
      const items: Array<[string, keyof RunConfig, FilterStat, boolean]> = [
        ['Trend M15', 'bbTrendM15', stats.bollinger.trendM15, cfg.bbTrendM15],
        ['Sideway M15', 'bbSidewayM15', stats.bollinger.sidewayM15, cfg.bbSidewayM15],
        ['Trend M1', 'bbTrendM1', stats.bollinger.trendM1, cfg.bbTrendM1],
        ['Sideway M1', 'bbSidewayM1', stats.bollinger.sidewayM1, cfg.bbSidewayM1],
      ];
      for (const [label, key, st, on] of items) {
        const p = precision(st);
        if (on && (result.length === 0 || (st.blocked >= 5 && p !== null && p < 55))) {
          add(`bb-${key}-off`, `Thử ${label} = OFF`, result.length === 0 ? `Không có lệnh hoàn tất; ${label} có thể đang chặn quá nhiều.` : `${label} chặn ${st.blocked}/${st.checks}, chỉ ${p!.toFixed(1)}% lệnh bị chặn là lệnh thua.`, `Kiểm chứng riêng tác động của ${label}.`, { [key]: false } as Partial<RunConfig>);
        }
        if (!on && result.length > 0) {
          add(`bb-${key}-on`, `Thử ${label} = ON`, `${label} đang tắt; nên A/B test bộ lọc này.`, 'So sánh Win Rate và drawdown khi bật.', { [key]: true } as Partial<RunConfig>);
        }
      }
    }

    const m = stats.sessionAdvisor.bestWindow.match(/(\d{2}):00 - (\d{2}):00/);
    if (m && stats.sessionAdvisor.bestPnl > 0) {
      add('session-best', 'Thử Session theo cửa sổ tốt nhất', `Cửa sổ ${stats.sessionAdvisor.bestWindow} có P/L tốt nhất trong lần backtest này.`, 'Kiểm chứng trên khoảng dữ liệu khác trước khi dùng live.', { useTradingSession: true, sessionFrom: `${m[1]}:00`, sessionTo: `${m[2]}:00` });
    }
    return out.slice(0, 3);
  }
  /**
   * Client-side replay runner. Backend chỉ cung cấp nến; toàn bộ logic
   * tín hiệu / filter / SL-TP mô phỏng lại đúng như bot live:
   *   - MA Cross  : decision_engine.py
   *   - Bollinger : bollinger_engine.py
   * Tín hiệu xét trên nến ĐÃ ĐÓNG, vào lệnh MARKET tại giá Close của nến tín hiệu.
   * Đang có lệnh mở → tín hiệu mới bị bỏ qua (live không mở thêm, không đóng khi có tín hiệu ngược).
   * Lệnh chỉ thoát bằng SL/TP (BE/Trailing là tùy chọn thử nghiệm, live không có).
   */
  async function runBot(overrides?: RunConfig) {
    const runCfg = overrides || getCurrentConfig();
    const strategyMode = runCfg.strategyMode || 'ma';
    const fast = Number(runCfg.fast); const slow = Number(runCfg.slow); const trend = Number(runCfg.trend);
    const maTrendEnabled = runCfg.maTrendEnabled;
    const sideway1Filter = runCfg.sideway1Filter;
    const bbTrendM15 = runCfg.bbTrendM15; const bbSidewayM15 = runCfg.bbSidewayM15;
    const bbTrendM1 = runCfg.bbTrendM1; const bbSidewayM1 = runCfg.bbSidewayM1;
    // Ngưỡng độ dốc nhập theo pip: 10 pip = 1.0 giá (XAUUSD).
    const bbSlopeM15Price = Math.max(0, Number(runCfg.bbSlopeM15Pips) || 0) / 10;
    const bbWidthM15 = Math.max(0, Number(runCfg.bbWidthM15) || 0);
    const bbSlopeM1Price = Math.max(0, Number(runCfg.bbSlopeM1Pips) || 0) / 10;
    const bbWidthM1 = Math.max(0, Number(runCfg.bbWidthM1) || 0);
    const bbSidewaySlopeM15Price = Math.max(0, Number(runCfg.bbSidewaySlopeM15Pips) || 0) / 10;
    const bbSidewayWidthM15 = Math.max(0, Number(runCfg.bbSidewayWidthM15) || 0);
    const bbSidewaySlopeM1Price = Math.max(0, Number(runCfg.bbSidewaySlopeM1Pips) || 0) / 10;
    const bbSidewayWidthM1 = Math.max(0, Number(runCfg.bbSidewayWidthM1) || 0);
    const antiFomo = runCfg.antiFomo;
    const breakEven = runCfg.breakEven; const trailing = runCfg.trailing;
    const fridayLock = runCfg.fridayLock; const useLotChain = runCfg.useLotChain; const lotChain = runCfg.lotChain;
    const baseLot = runCfg.baseLot; const useTradingSession = runCfg.useTradingSession;
    const sessionFrom = runCfg.sessionFrom; const sessionTo = runCfg.sessionTo;
    const rrRisk = Number(runCfg.rrRisk); const rrReward = Number(runCfg.rrReward);
    const maRr = rrRisk > 0 && rrReward > 0 ? rrReward / rrRisk : 0;
    const rrForMethod = strategyMode === 'ma' ? maRr : BB_RR_REWARD;

    if (!data?.candles?.length) {
      setError('Hãy START REPLAY trước khi chạy bot.');
      return;
    }

    // Giống live: cấu hình không hợp lệ → không chạy (không dùng giá trị mặc định ngầm).
    if (strategyMode === 'ma') {
      const isPosInt = (v: number) => Number.isInteger(v) && v > 0;
      if (!isPosInt(fast) || !isPosInt(slow)) { setError('MA Fast / MA Slow phải là số nguyên > 0.'); return; }
      if (fast >= slow) { setError('MA Fast phải nhỏ hơn MA Slow.'); return; }
      if ((maTrendEnabled || sideway1Filter) && !isPosInt(trend)) { setError('MA Trend period phải là số nguyên > 0 khi bật MA Trend hoặc Sideway.'); return; }
      if (!(rrRisk > 0) || !(rrReward > 0)) { setError('R:R phải là số > 0.'); return; }
    }
    if (useLotChain && lotChain.length === 0) { setError('Chuỗi lot không hợp lệ.'); return; }
    if (!useLotChain && !(baseLot > 0)) { setError('Lot phải > 0.'); return; }

    const isWithinTradingSession = (candleTime: string) => {
      if (!useTradingSession) return true;
      const parts = parseCandleTime(candleTime);
      if (!parts) return false;
      const minutes = parts.hour * 60 + parts.minute;
      const [fh, fm] = sessionFrom.split(':').map(Number);
      const [th, tm] = sessionTo.split(':').map(Number);
      const fromMinutes = fh * 60 + fm;
      const toMinutes = th * 60 + tm;
      return fromMinutes <= toMinutes
        ? minutes >= fromMinutes && minutes <= toMinutes
        : minutes >= fromMinutes || minutes <= toMinutes;
    };
    const isFridayLocked = (candleTime: string) => {
      if (!fridayLock) return false;
      const parts = parseCandleTime(candleTime);
      return !!parts && candleWeekday(candleTime) === 5 && parts.hour >= 20;
    };
    const resolveLot = (streak: number) => {
      if (!useLotChain) return baseLot;
      const chain = lotChain.length ? lotChain : [baseLot];
      return chain[Math.min(streak, chain.length - 1)];
    };

    setError('');
    setPlaying(false);
    setBotRunning(true);

    const candles = addBollinger(calcIndicators(data.candles, fast, slow, trend));
    const m15Candles = addBollinger(aggregateM15(data.candles));
    const m15ByBucket = new Map(m15Candles.map((c, idx) => [Number(c.time), { candle: c, index: idx }]));
    const crosses = strategyMode === 'ma' ? detectCrosses(candles) : detectBollingerSignals(candles);
    const crossByIndex = new Map(crosses.map(x => [x.index, x]));
    const audit: SignalAudit[] = [];
    const result: Trade[] = [];
    const sideway = emptyFilterStat();
    const maTrend = emptyFilterStat();
    const bollinger = { trendM15: emptyFilterStat(), sidewayM15: emptyFilterStat(), trendM1: emptyFilterStat(), sidewayM1: emptyFilterStat() };
    const fomo = emptyFilterStat();
    const session = emptyFilterStat();
    const friday = emptyFilterStat();

    let balance = initialBalance;
    let peakBalance = balance;
    let maxDrawdown = 0;
    let lossStreak = 0;
    let lastLossCrossPrice: number | null = null;
    let open: any = null;
    let tradeId = 1;
    let acceptedSignals = 0;
    let marketEntries = 0;
    let noTrade = 0;
    let skippedOpen = 0;
    let grossWin = 0;
    let grossLoss = 0;

    const hourStats: Record<number, { trades: number; pnl: number; wins: number }> = {};
    for (let h = 0; h < 24; h++) hourStats[h] = { trades: 0, pnl: 0, wins: 0 };

    const updateDrawdown = () => {
      peakBalance = Math.max(peakBalance, balance);
      maxDrawdown = Math.max(maxDrawdown, peakBalance - balance);
    };

    const recordBlockedSignal = (stat: FilterStat, index: number, side: 'BUY' | 'SELL', entry: number) => {
      stat.blocked++;
      const outcome = hypotheticalBlockedOutcome(candles, index, side, entry, strategyMode, rrForMethod);
      if (outcome === 'LOSS') stat.correct++;
      else if (outcome === 'WIN') stat.wrong++;
      else stat.unknown++;
    };

    const closeTrade = (exitTime: number, exitCandleTime: string, exitPrice: number, reason: string) => {
      if (!open) return;
      const direction = open.side === 'BUY' ? 1 : -1;
      const pnl = Number(((exitPrice - open.entryPrice) * direction * open.lot * 100).toFixed(2));
      const r: Trade['result'] = pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'BE';
      balance += pnl;
      updateDrawdown();
      if (pnl > 0) grossWin += pnl;
      if (pnl < 0) grossLoss += Math.abs(pnl);
      const hour = parseCandleTime(open.entryCandleTime)?.hour ?? 0;
      hourStats[hour].trades++;
      hourStats[hour].pnl += pnl;
      if (pnl > 0) hourStats[hour].wins++;
      result.push({
        id: open.id, side: open.side,
        entryTime: open.entryTime, entryCandleTime: open.entryCandleTime, entryPrice: open.entryPrice,
        exitTime, exitCandleTime, exitPrice,
        lot: open.lot, pnl, result: r, reason,
      });
      // Chuỗi thua: lệnh thua → +1 và ghi nhớ giá Cross của lệnh thua (Sideway TH1); lệnh thắng/BE → reset.
      if (r === 'LOSS') {
        lossStreak++;
        lastLossCrossPrice = open.crossPrice;
      } else {
        lossStreak = 0;
        lastLossCrossPrice = null;
      }
      open = null;
    };

    const managePosition = (c: any) => {
      if (!open) return;
      const low = Number(c.low), high = Number(c.high);
      const slHit = open.side === 'BUY' ? low <= open.sl : high >= open.sl;
      const tpHit = open.side === 'BUY' ? high >= open.tp : low <= open.tp;
      const slReason = open.trailingApplied ? 'Trailing Stop' : open.beApplied ? 'Break Even' : 'Stop Loss';
      if (slHit && tpHit) { closeTrade(Number(c.time), String(c.candle_time), open.sl, `${slReason} · SL/TP cùng nến (giả định SL trước)`); return; }
      if (slHit) { closeTrade(Number(c.time), String(c.candle_time), open.sl, slReason); return; }
      if (tpHit) { closeTrade(Number(c.time), String(c.candle_time), open.tp, 'Take Profit'); return; }

      // Tùy chọn thử nghiệm (bot live KHÔNG có): dời SL sau khi đạt 50% quãng TP, áp dụng từ nến sau.
      if (!breakEven && !trailing) return;
      const currentPrice = Number(c.close);
      const tpDistance = Math.abs(open.tp - open.entryPrice);
      const profit = favorableMove(open.side, open.entryPrice, currentPrice);
      const progress = tpDistance > 0 ? profit / tpDistance : 0;
      if (progress < 0.5) return;
      if (breakEven && !open.beApplied) {
        open.sl = open.side === 'BUY' ? Math.max(open.sl, open.entryPrice) : Math.min(open.sl, open.entryPrice);
        open.beApplied = true;
      }
      if (trailing) {
        const lockedSl = open.side === 'BUY' ? open.entryPrice + profit * 0.6 : open.entryPrice - profit * 0.6;
        open.sl = open.side === 'BUY' ? Math.max(open.sl, lockedSl) : Math.min(open.sl, lockedSl);
        open.trailingApplied = true;
      }
    };

    for (let i = 0; i < candles.length; i++) {
      if (i > 0 && i % 1000 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
      const c = candles[i];

      // 1) Quản lý lệnh đang mở trên nến hiện tại.
      if (open) managePosition(c);

      const signal = crossByIndex.get(i);
      if (!signal) continue;
      const side: 'BUY' | 'SELL' = signal.type === 'BUY_CROSS' ? 'BUY' : 'SELL';
      const crossPrice = Number(signal.price);
      // Backtest không có tick: giá MARKET = Close nến tín hiệu (live dùng Ask/Bid ngay sau khi nến đóng).
      const entry = Number(c.close);
      const auditRow: SignalAudit = {
        index: i, time: Number(c.time), candle_time: String(c.candle_time ?? ''),
        side, price: crossPrice, status: 'SIGNAL',
        reason: strategyMode === 'ma' ? `MA Cross SMA${fast} x SMA${slow}` : 'Bollinger: 2 nến cùng phía SMA20, thân nến tín hiệu ≥ 70%',
      };
      audit.push(auditRow);
      const block = (stat: FilterStat | null, reason: string) => {
        if (stat) recordBlockedSignal(stat, i, side, entry);
        auditRow.status = 'BLOCKED';
        auditRow.reason = reason;
        noTrade++;
      };

      // 2) Giờ giao dịch / Friday Lock — live không xét tín hiệu ngoài giờ.
      if (useTradingSession) {
        session.checks++;
        if (!isWithinTradingSession(String(c.candle_time))) { block(session, 'Ngoài giờ giao dịch'); continue; }
      }
      if (fridayLock) {
        friday.checks++;
        if (isFridayLocked(String(c.candle_time))) { block(friday, 'Friday Lock'); continue; }
      }

      // 3) Đang có lệnh mở → bỏ qua (live không mở thêm, không đóng lệnh khi có tín hiệu ngược).
      if (open) {
        auditRow.status = 'SKIPPED';
        auditRow.reason = `Đang có lệnh ${open.side} mở; bot không mở thêm.`;
        skippedOpen++;
        continue;
      }

      if (strategyMode === 'ma') {
        const maValue = c.trend_ready && Number.isFinite(Number(c.ma_trend)) ? Number(c.ma_trend) : null;

        // BƯỚC 1 — TREND: Close nến Cross trên MA Trend = Trend UP, dưới = Trend DOWN.
        if (maTrendEnabled) {
          maTrend.checks++;
          if (maValue === null) { block(maTrend, `MA Trend ${trend}: chưa đủ dữ liệu`); continue; }
          const close = Number(c.close);
          const trendDir = close > maValue ? 'UP' : close < maValue ? 'DOWN' : null;
          const passTrend = (side === 'BUY' && trendDir === 'UP') || (side === 'SELL' && trendDir === 'DOWN');
          if (!passTrend) { block(maTrend, `MA Trend ${trend}: Cross ngược trend (Close ${close.toFixed(2)} / MA ${maValue.toFixed(2)})`); continue; }
        }

        // BƯỚC 2.1 — FOMO.
        if (antiFomo) {
          fomo.checks++;
          const f = checkFomo(candles, i, crossPrice, side);
          if (!f.pass) { block(fomo, `FOMO: ${f.reason} (${f.distance.toFixed(2)} > ${f.threshold.toFixed(2)})`); continue; }
        }

        // BƯỚC 2.2 — SIDEWAY (TH1 + TH2).
        if (sideway1Filter) {
          sideway.checks++;
          const s = checkSideway(crossPrice, entry, maValue, lossStreak, lastLossCrossPrice);
          if (!s.pass) {
            const parts: string[] = [];
            if (s.th1Block) parts.push(`TH1 ±3 Cross thua: ${s.th1Detail}`);
            if (s.th2Block) parts.push(`TH2 ±3 MA Trend: ${s.th2Detail}`);
            block(sideway, `Sideway | ${parts.join(' ; ')}`);
            continue;
          }
        }
      } else {
        // Bollinger filters (AND): Trend bật → phải PASS; Sideway bật → BLOCK khi phát hiện sideway.
        // M15 dùng nến M15 ĐÃ ĐÓNG gần nhất tại thời điểm nến M1 tín hiệu vừa đóng.
        const decisionTime = Number(c.time) + 60;
        const m15Current = m15ByBucket.get(Math.floor(decisionTime / 900) * 900);
        const m15ClosedIndex = m15Current ? m15Current.index - 1 : m15Candles.length - 1;
        const blocks: string[] = [];
        const blockStats: FilterStat[] = [];

        if (bbTrendM15) {
          bollinger.trendM15.checks++;
          if (!isBollingerTrend(m15Candles, m15ClosedIndex, bbSlopeM15Price, bbWidthM15, false)) { blocks.push('Trend M15 yếu / không rõ'); blockStats.push(bollinger.trendM15); }
        }
        if (bbSidewayM15) {
          bollinger.sidewayM15.checks++;
          if (isBollingerSideway(m15Candles, m15ClosedIndex, bbSidewaySlopeM15Price, bbSidewayWidthM15)) { blocks.push('Sideway M15'); blockStats.push(bollinger.sidewayM15); }
        }
        if (bbTrendM1) {
          bollinger.trendM1.checks++;
          if (!isBollingerTrend(candles, i, bbSlopeM1Price, bbWidthM1, true)) { blocks.push('Trend M1 yếu / không rõ'); blockStats.push(bollinger.trendM1); }
        }
        if (bbSidewayM1) {
          bollinger.sidewayM1.checks++;
          if (isBollingerSideway(candles, i, bbSidewaySlopeM1Price, bbSidewayWidthM1)) { blocks.push('Sideway M1'); blockStats.push(bollinger.sidewayM1); }
        }
        if (blocks.length) {
          blockStats.forEach((st) => recordBlockedSignal(st, i, side, entry));
          block(null, `Bollinger BLOCK: ${blocks.join(', ')}`);
          continue;
        }
      }

      // 4) SL / TP theo đúng phương pháp.
      const sltp = calculateSlTp(candles, i, side, entry, strategyMode, rrForMethod);
      if (!sltp) {
        auditRow.status = 'BLOCKED';
        auditRow.reason = 'SL/TP: giá đã vượt vùng đáy/đỉnh 10 nến trước → không vào lệnh.';
        noTrade++;
        continue;
      }

      open = {
        id: tradeId++,
        side,
        entryTime: Number(c.time),
        entryCandleTime: String(c.candle_time),
        entryPrice: entry,
        lot: resolveLot(lossStreak),
        crossPrice,
        sl: sltp.sl,
        tp: sltp.tp,
        beApplied: false,
        trailingApplied: false,
      };
      acceptedSignals++;
      marketEntries++;
      auditRow.status = 'ENTERED';
      auditRow.reason = `MARKET ${side} @ ${entry.toFixed(2)} · SL ${sltp.sl.toFixed(2)} · TP ${sltp.tp.toFixed(2)} · Lot ${open.lot}${useLotChain ? ` (L${Math.min(lossStreak, lotChain.length - 1) + 1})` : ''}`;
    }

    if (open) {
      const last = candles[candles.length - 1];
      closeTrade(Number(last.time), String(last.candle_time), Number(last.close), 'End of Backtest');
    }

    const wins = result.filter(x => x.result === 'WIN').length;
    const total = result.length;
    const wr = total ? wins / total * 100 : 0;
    const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;

    // Session Advisor: phân tích lệnh đã hoàn tất theo giờ vào lệnh.
    let bestHour = 0;
    let bestHourScore = -Infinity;
    for (let h = 0; h < 24; h++) {
      const st = hourStats[h];
      if (!st.trades) continue;
      const score = st.pnl + st.wins * 0.01;
      if (score > bestHourScore) { bestHourScore = score; bestHour = h; }
    }
    const windows = [1, 2, 3, 4].map(size => {
      let best = { start: 0, pnl: -Infinity, trades: 0, wins: 0 };
      for (let start = 0; start < 24; start++) {
        let pnl = 0, tradesN = 0, winsN = 0;
        for (let k = 0; k < size; k++) {
          const h = (start + k) % 24;
          pnl += hourStats[h].pnl;
          tradesN += hourStats[h].trades;
          winsN += hourStats[h].wins;
        }
        if (tradesN && pnl > best.pnl) best = { start, pnl, trades: tradesN, wins: winsN };
      }
      return { size, ...best };
    });
    const bestWindow = windows.sort((a,b) => b.pnl - a.pnl)[0];
    const windowText = bestWindow ? `${String(bestWindow.start).padStart(2,'0')}:00 - ${String((bestWindow.start + bestWindow.size) % 24).padStart(2,'0')}:00` : '—';
    const sessionAdvisor = bestWindow?.trades
      ? {
          bestWindow: windowText,
          bestHour: `${String(bestHour).padStart(2,'0')}:00`,
          bestPnl: bestWindow.pnl,
          bestWinRate: bestWindow.trades ? bestWindow.wins / bestWindow.trades * 100 : 0,
          trades: bestWindow.trades,
          recommendation: bestWindow.pnl > 0
            ? `Nếu muốn thử tối ưu session thủ công, nên kiểm tra ${windowText} vì đây là cửa sổ có P/L tốt nhất trong lần backtest này.`
            : 'Chưa có cửa sổ giờ dương rõ ràng; không nên thay đổi session chỉ dựa trên mẫu dữ liệu này.'
        }
      : emptySessionAdvisor();

    const describe = (label: string, st: FilterStat) =>
      `${label}: chặn ${st.blocked}/${st.checks} (${(st.blocked / st.checks * 100).toFixed(1)}%). Nếu không chặn: ${st.correct} lệnh sẽ thua, ${st.wrong} lệnh sẽ thắng, ${st.unknown} chưa rõ.`;

    const advice: string[] = [];
    if (total === 0) {
      advice.push(strategyMode === 'ma'
        ? 'Không có lệnh hoàn tất. Hãy kiểm tra MA Trend, FOMO, Sideway và Session trong cấu hình hiện tại.'
        : 'Không có lệnh hoàn tất. Hãy kiểm tra các filter Bollinger Trend/Sideway và Session.');
    } else {
      if (wr < 45) advice.push(`Win Rate ${wr.toFixed(1)}%. Nên thay đổi từng thông số một, bắt đầu từ filter có tác động lớn nhất.`);
      if (pf > 0 && pf < 1) advice.push(`Profit Factor ${pf.toFixed(2)} dưới 1 — cấu hình chưa có lợi thế trên mẫu dữ liệu này.`);
      if (pf >= 1.3 && wr >= 50) advice.push(`Kết quả tích cực: Win Rate ${wr.toFixed(1)}%, Profit Factor ${pf.toFixed(2)}. Giữ làm baseline và chỉ thử thay đổi từng tham số.`);
      if (useLotChain && maxDrawdown > 0) advice.push(`Đang dùng chuỗi lot ${lotChain.join(' → ')}; Max Drawdown $${maxDrawdown.toFixed(2)}.`);
    }
    if (maTrend.checks) advice.push(describe(`MA Trend ${trend}`, maTrend));
    if (fomo.checks) advice.push(describe('FOMO', fomo));
    if (sideway.checks) advice.push(describe('Sideway', sideway));
    for (const [label, st] of [
      ['Bollinger Trend M15', bollinger.trendM15], ['Bollinger Sideway M15', bollinger.sidewayM15],
      ['Bollinger Trend M1', bollinger.trendM1], ['Bollinger Sideway M1', bollinger.sidewayM1],
    ] as const) {
      if (st.checks) advice.push(describe(label, st));
    }
    if (skippedOpen) advice.push(`${skippedOpen} tín hiệu bị bỏ qua vì đang có lệnh mở (giống bot live).`);
    if (breakEven || trailing) advice.push('⚠ BE/Trailing đang bật nhưng bot live KHÔNG có tính năng này — kết quả sẽ khác live.');
    if (total > 0) advice.push(sessionAdvisor.recommendation);

    const currentConfigText = configLabel(runCfg);

    const finalStats: BacktestStats = {
      sideway, maTrend, bollinger, fomo, session, friday, totalSignals: crosses.length, acceptedSignals,
      marketEntries, skippedOpen, noTrade, advice, sessionAdvisor,
    };
    const nextRecommendations = makeRecommendations(runCfg, finalStats, result);
    setBacktestStats(finalStats);
    setRecommendations(nextRecommendations);
    setRunHistory(prev => [...prev, { run: prev.length + 1, config: runCfg, pnl: balance - initialBalance, winRate: wr, profitFactor: pf, drawdown: maxDrawdown, trades: result.length }].slice(-20));
    setTrades(result);
    setSignalAudit(audit);
    setBotBalance(Number(balance.toFixed(2)));
    setBotRunning(false);
    setVisible(candles.length);
    setData((d:any) => ({ ...d, candles, crosses, signalAudit: audit, lastBacktestConfig: currentConfigText }));
  }

  
async function start() {
  setError('');

  // Kiểm tra trước khi bật trạng thái đang chạy
  if (useLotChain && lotChain.length === 0) {
    setError('Chuỗi lot không hợp lệ.');
    return;
  }

  setPlaying(false);
  setBotRunning(true);
  setTrades([]);
  setSignalAudit([]);
  setBotBalance(initialBalance);

  try {
    console.log('[REPLAY] Starting...', { from, to });

    const d = await api('/api/replay/prepare', {
      method: 'POST',
      body: JSON.stringify({
        strategy_mode: strategyMode,
        symbol: 'XAUUSD',
        timeframe: 'M1',
        from_time: `${from} 00:00:00`,
        to_time: `${to} 23:59:00`,
        ma_fast: fast,
        ma_slow: slow,
        ema_trend: trend,
        ma_trend: maTrendEnabled,
        sideway_filter: sideway1Filter,
        anti_fomo: antiFomo,
        rr_risk: rrRisk,
        rr_reward: rrReward,
        be: breakEven,
        trailing,
        friday_lock: fridayLock,
        multi_lot: useLotChain,
        lot_chain: lotChain,
        lot: baseLot,
        auto_session: useTradingSession,
        sessions: useTradingSession
          ? [{ from: sessionFrom, to: sessionTo }]
          : [],
      }),
    });

    console.log('[REPLAY] Response:', d);

    if (!d?.candles?.length) {
      throw new Error('API không trả về dữ liệu nến.');
    }

    setData(d);
    setVisible(
      Math.min(
        Math.max(fast, slow, trend) + 5,
        d.candles.length
      )
    );

    console.log('[REPLAY] Loaded candles:', d.candles.length);
  } catch (e: any) {
    console.error('[REPLAY] Error:', e);
    setError(e?.message || 'Không thể khởi động replay');
  } finally {
    // Luôn trả trạng thái về bình thường, kể cả khi API lỗi
    setBotRunning(false);
  }
}


  function logout() {
    localStorage.removeItem('access_token');
    router.replace('/login');
  }

  return (
    <main className="terminal">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mini">V</div>
          <div>
            <strong>VPS BACKTEST</strong>
            <span>DECISION REPLAY TERMINAL</span>
          </div>
        </div>

        <div className="top-actions">
          <span className="live-dot">● LOCAL</span>
          <button onClick={logout} className="ghost">Logout</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="section-title">REPLAY SETUP</div>
          <label>Phương pháp giao dịch
            <select value={strategyMode} onChange={(e) => setStrategyMode(e.target.value as 'ma' | 'bollinger')}>
              <option value="ma">Phương pháp 1 — MA Cross (SMA)</option>
              <option value="bollinger">Phương pháp 2 — Bollinger</option>
            </select>
          </label>

          <label>
            Market
            <select defaultValue="XAUUSD">
              <option>XAUUSD</option>
            </select>
          </label>

          <label>
            Timeframe
            <select value={chartTimeframe} onChange={(e) => setChartTimeframe(e.target.value as 'M1'|'M15')}>
              <option value="M1">M1</option>
              <option value="M15">M15</option>
            </select>
          </label>

          {strategyMode === 'ma' && <>
            <div className="two">
              <label>MA Fast<input type="number" value={fast} onChange={(e) => setFast(+e.target.value)} /></label>
              <label>MA Slow<input type="number" value={slow} onChange={(e) => setSlow(+e.target.value)} /></label>
            </div>
            <label>MA Trend period<input type="number" value={trend} onChange={(e) => setTrend(+e.target.value)} /></label>
            <div className="two">
              <label>R:R Risk<input type="number" min="0" step="0.1" value={rrRisk} onChange={(e) => setRrRisk(+e.target.value)} /></label>
              <label>R:R Reward<input type="number" min="0" step="0.1" value={rrReward} onChange={(e) => setRrReward(+e.target.value)} /></label>
            </div>
            <label className="switch-row">
              <input type="checkbox" checked={maTrendEnabled} onChange={(e) => setMaTrendEnabled(e.target.checked)} />
              <span className="switch" /><span className="switch-content"><strong>Bước 1 — MA Trend</strong><small>Close nến Cross trên SMA Trend = Trend UP (chỉ BUY), dưới = Trend DOWN (chỉ SELL).</small></span>
            </label>
          </>}

          <div className="section-title space">FILTERS</div>

          <div className="strategy-option">
            {strategyMode === 'ma' && <label className="switch-row">
  <input
    type="checkbox"
    checked={sideway1Filter}
    onChange={(e) => setSideway1Filter(e.target.checked)}
  />
  <span className="switch" />
  <span className="switch-content">
    <strong>Bước 2.2 — Sideway</strong>
    <small>BLOCK khi: TH1 giá Cross cách Cross của lệnh thua trước ≤ ±3 (khi đang thua chuỗi), hoặc TH2 Entry cách SMA Trend ≤ ±3.</small>
  </span>
</label>}

            {strategyMode === 'bollinger' && <>
            <label className="switch-row">
              <input type="checkbox" checked={bbTrendM15} onChange={(e) => setBbTrendM15(e.target.checked)} />
              <span className="switch" /><span className="switch-content"><strong>Trend mạnh — Bollinger M15</strong><small>PASS khi đồng thời: độ dốc SMA20 M15 vượt ngưỡng, giá đóng đúng phía SMA20, BB mở rộng và độ rộng BB vượt ngưỡng. Không đạt đủ = trend yếu, BLOCK.</small></span>
            </label>
            <div className="bollinger-thresholds" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, margin: '0 0 12px 42px' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11 }}>Độ dốc SMA20 M15 (pip)
                <input style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }} type="number" min="0" step="1" value={bbSlopeM15Pips} onChange={(e) => setBbSlopeM15Pips(Math.max(0, Number(e.target.value) || 0))} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11 }}>Độ rộng BB M15 (giá)
                <input style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }} type="number" min="0" step="0.1" value={bbWidthM15} onChange={(e) => setBbWidthM15(Math.max(0, Number(e.target.value) || 0))} />
              </label>
            </div>
            <label className="switch-row">
              <input type="checkbox" checked={bbSidewayM15} onChange={(e) => setBbSidewayM15(e.target.checked)} />
              <span className="switch" /><span className="switch-content"><strong>Sideway — Bollinger M15</strong><small>BLOCK chỉ khi đồng thời: độ dốc SMA20 M15 dưới ngưỡng, BB co hẹp và giá đóng ngược hướng SMA20. Thiếu bất kỳ điều kiện nào = không xác định Sideway, PASS.</small></span>
            </label>
            <div className="bollinger-thresholds" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, margin: '0 0 12px 42px' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11 }}>Sideway: độ dốc SMA20 M15 (pip)
                <input style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }} type="number" min="0" step="1" value={bbSidewaySlopeM15Pips} onChange={(e) => setBbSidewaySlopeM15Pips(Math.max(0, Number(e.target.value) || 0))} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11 }}>Sideway: độ rộng BB M15 (giá)
                <input style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }} type="number" min="0" step="0.1" value={bbSidewayWidthM15} onChange={(e) => setBbSidewayWidthM15(Math.max(0, Number(e.target.value) || 0))} />
              </label>
            </div>
            <label className="switch-row">
              <input type="checkbox" checked={bbTrendM1} onChange={(e) => setBbTrendM1(e.target.checked)} />
              <span className="switch" /><span className="switch-content"><strong>Trend mạnh — Bollinger M1</strong><small>PASS khi đồng thời: độ dốc SMA20 M1 vượt ngưỡng M1, giá đóng đúng phía SMA20, BB mở rộng, nến [2] xác nhận và thân nến [2] ≥ 70%. Không đạt đủ = trend yếu, BLOCK.</small></span>
            </label>
            <div className="bollinger-thresholds" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, margin: '0 0 12px 42px' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11 }}>Độ dốc SMA20 M1 (pip)
                <input style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }} type="number" min="0" step="1" value={bbSlopeM1Pips} onChange={(e) => setBbSlopeM1Pips(Math.max(0, Number(e.target.value) || 0))} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11 }}>Độ rộng BB M1 (giá)
                <input style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }} type="number" min="0" step="0.1" value={bbWidthM1} onChange={(e) => setBbWidthM1(Math.max(0, Number(e.target.value) || 0))} />
              </label>
            </div>
            <label className="switch-row">
              <input type="checkbox" checked={bbSidewayM1} onChange={(e) => setBbSidewayM1(e.target.checked)} />
              <span className="switch" /><span className="switch-content"><strong>Sideway — Bollinger M1</strong><small>BLOCK chỉ khi đồng thời: độ dốc SMA20 M1 dưới ngưỡng M1, BB co hẹp và giá đóng ngược hướng SMA20. Thiếu bất kỳ điều kiện nào = không xác định Sideway, PASS.</small></span>
            </label>
            <div className="bollinger-thresholds" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, margin: '0 0 12px 42px' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11 }}>Sideway: độ dốc SMA20 M1 (pip)
                <input style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }} type="number" min="0" step="1" value={bbSidewaySlopeM1Pips} onChange={(e) => setBbSidewaySlopeM1Pips(Math.max(0, Number(e.target.value) || 0))} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11 }}>Sideway: độ rộng BB M1 (giá)
                <input style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }} type="number" min="0" step="0.1" value={bbSidewayWidthM1} onChange={(e) => setBbSidewayWidthM1(Math.max(0, Number(e.target.value) || 0))} />
              </label>
            </div>

            </>}

            {strategyMode === 'ma' && <label className="switch-row">
              <input type="checkbox" checked={antiFomo} onChange={(e) => setAntiFomo(e.target.checked)} />
              <span className="switch" />
              <span className="switch-content">
                <strong>Bước 2.1 — FOMO</strong>
                <small>BUY: Cross − Low nến Cross; SELL: High − Cross. Lớn hơn 200% thân nến TB 3 nến trước → BLOCK.</small>
              </span>
            </label>}
          </div>

          <div className="section-title space">POSITION MANAGEMENT</div>

          <div className="strategy-option">
            <label className="switch-row">
              <input type="checkbox" checked={breakEven} onChange={(e) => setBreakEven(e.target.checked)} />
              <span className="switch" />
              <span className="switch-content">
                <strong>Break Even (thử nghiệm)</strong>
                <small>Bot live KHÔNG có. Dời SL về Entry khi đạt 50% TP.</small>
              </span>
            </label>

            <label className="switch-row">
              <input type="checkbox" checked={trailing} onChange={(e) => setTrailing(e.target.checked)} />
              <span className="switch" />
              <span className="switch-content">
                <strong>Trailing Stop (thử nghiệm)</strong>
                <small>Bot live KHÔNG có. Khóa 60% lợi nhuận khi đạt 50% TP.</small>
              </span>
            </label>

            <label className="switch-row">
              <input type="checkbox" checked={fridayLock} onChange={(e) => setFridayLock(e.target.checked)} />
              <span className="switch" />
              <span className="switch-content">
                <strong>Friday Lock</strong>
                <small>Khóa lệnh cuối tuần</small>
              </span>
            </label>

            <label className="switch-row">
              <input type="checkbox" checked={useLotChain} onChange={(e) => setUseLotChain(e.target.checked)} />
              <span className="switch" />
              <span className="switch-content">
                <strong>Sử dụng Chuỗi Lot</strong>
                <small>Tăng lot theo chuỗi sau mỗi lệnh thua</small>
              </span>
            </label>

            {useLotChain && (
              <div className="lot-chain-config">
                <div className="lot-chain-title">CHUỖI LOT</div>

                <div className="lot-chain-presets">
                  <button type="button" className={lotChainMode === 'default' ? 'lot-preset active' : 'lot-preset'} onClick={() => setLotChainMode('default')}>
                    Mặc định
                  </button>
                  <button type="button" className={lotChainMode === 'custom' ? 'lot-preset active' : 'lot-preset'} onClick={() => setLotChainMode('custom')}>
                    Tự nhập
                  </button>
                </div>

                {lotChainMode === 'default' ? (
                  <div className="lot-chain-display">
                    {lotChain.map((lot, index) => (
                      <span key={`${lot}-${index}`}>
                        {lot.toFixed(2)}{index < lotChain.length - 1 ? ' →' : ''}
                      </span>
                    ))}
                  </div>
                ) : (
                  <input className="lot-chain-input" type="text" value={customLotChain} onChange={(e) => setCustomLotChain(e.target.value)} placeholder="0.01, 0.02, 0.04, 0.08" />
                )}

                <small className="lot-chain-help">Nhập các lot cách nhau bằng dấu phẩy</small>
              </div>
            )}
          </div>

          <div className="section-title space">TRADING SESSION</div>

          <div className="strategy-option">
            <label className="switch-row">
              <input type="checkbox" checked={useTradingSession} onChange={(e) => setUseTradingSession(e.target.checked)} />
              <span className="switch" />
              <span className="switch-content">
                <strong>Cho phép giao dịch trong khoảng thời gian</strong>
                <small>Chỉ vào lệnh trong khung giờ được chọn</small>
              </span>
            </label>

            {useTradingSession && (
              <div className="session-config">
                <label>
                  Từ
                  <input type="time" value={sessionFrom} onChange={(e) => setSessionFrom(e.target.value)} />
                </label>
                <span className="session-arrow">→</span>
                <label>
                  Đến
                  <input type="time" value={sessionTo} onChange={(e) => setSessionTo(e.target.value)} />
                </label>
              </div>
            )}
          </div>

          <div className="section-title space">ACCOUNT</div>

          <div className="account-box">
            <div><span>Số dư ban đầu</span><b>$100,000.00</b></div>
            <div><span>Số dư hiện tại</span><b className={botBalance >= initialBalance ? 'up' : 'down'}>${botBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}</b></div>
          </div>

          <div className="section-title space">PERIOD</div>

          <label>
  From
  <DatePicker
    selected={from ? new Date(`${from}T00:00:00`) : null}
    onChange={(date: Date | null) => {
      if (date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        setFrom(`${y}-${m}-${d}`);
      }
    }}
    dateFormat="dd/MM/yyyy"
    placeholderText="dd/mm/yyyy"
  />
</label>

<label>
  To
  <DatePicker
    selected={to ? new Date(`${to}T00:00:00`) : null}
    onChange={(date: Date | null) => {
      if (date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        setTo(`${y}-${m}-${d}`);
      }
    }}
    dateFormat="dd/MM/yyyy"
    minDate={from ? new Date(`${from}T00:00:00`) : undefined}
    placeholderText="dd/mm/yyyy"
  />
</label>

          <button className="primary wide" onClick={start}>START REPLAY</button>

          <button className="bot-button wide" onClick={() => { void runBot(); }} disabled={!data}>
            {botRunning ? 'RUN BOT AGAIN' : '▶ RUN BOT'}
          </button>

          {error && <div className="error">{error}</div>}

          <div className="legend">
            {strategyMode === 'ma' ? <>
              <span><i className="dot orange" />MA Fast</span><span><i className="dot purple" />MA Slow</span><span><i className="dot cyan" />SMA Trend</span>
            </> : <><span><i className="dot orange" />BB Upper</span><span><i className="dot purple" />SMA20</span><span><i className="dot cyan" />BB Lower</span></>}
          </div>
        </aside>

        <section className="main">
          <div className="stats">
            <div><span>SYMBOL</span><b>XAUUSD</b></div>
            <div><span>TIMEFRAME</span><b>M1</b></div>
            <div><span>INITIAL BALANCE</span><b>$100,000</b></div>
            <div><span>BOT BALANCE</span><b className={botBalance >= initialBalance ? 'up' : 'down'}>${botBalance.toLocaleString('en-US', { maximumFractionDigits: 2 })}</b></div>
            <div><span>WIN RATE</span><b className={winRate >= 50 ? 'up' : 'down'}>{winRate.toFixed(1)}%</b></div>
          </div>

          <div className="chart-card">
            <div className="chart-head">
              <div>
                <strong>{`XAUUSD · ${chartTimeframe} · ${strategyMode === 'ma' ? 'MA Cross' : 'Bollinger'}`}</strong>
                <span>{candle ? fmt(candle.candle_time) : 'Ready for replay'}</span>
              </div>

              <div className="controls">
                <button onClick={() => setVisible((v) => Math.max(0, v - 1))}>‹</button>
                <button onClick={() => setPlaying((v) => !v)}>{playing ? 'Ⅱ' : '▶'}</button>
                <button onClick={() => setVisible((v) => Math.min(data?.candles?.length || v, v + 1))}>›</button>
                <select value={speed} onChange={(e) => setSpeed(+e.target.value)}>
                  <option value="0.5">0.5x</option>
                  <option value="1">1x</option>
                  <option value="2">2x</option>
                  <option value="5">5x</option>
                  <option value="10">10x</option>
                </select>
              </div>
            </div>

            {data ? (
              <MarketChart candles={chartCandles} visibleCount={chartVisible} crosses={chartTimeframe === 'M1' && signalAudit.length ? signalAudit.map(a => ({ index: a.index, time: a.time, price: a.price, type: a.side === 'BUY' ? 'BUY_CROSS' : 'SELL_CROSS', status: a.status === 'BLOCKED' ? 'BLOCKED' : a.status === 'ENTERED' ? 'ENTERED' : 'SKIPPED', reason: a.reason })) : chartCrosses} strategyMode={strategyMode} />
            ) : (
              <div className="empty">
                <div className="empty-icon">⌁</div>
                <h2>Configure your replay</h2>
                <p>Chọn chiến lược, bộ lọc và khoảng thời gian rồi START REPLAY.</p>
              </div>
            )}
          </div>

          <div className="bottom-grid">
            <div className="panel">
              <div className="panel-title">CURRENT MARKET</div>
              <div className="market-row"><span>Price</span><b>{candle?.close?.toFixed(2) || '—'}</b></div>
              <div className="market-row"><span>MA Fast</span><b>{candle?.ma_fast?.toFixed(2) || '—'}</b></div>
              <div className="market-row"><span>MA Slow</span><b>{candle?.ma_slow?.toFixed(2) || '—'}</b></div>
              <div className="market-row"><span>SMA {trend}</span><b>{candle?.ema_trend?.toFixed(2) || '—'}</b></div>
              <div className="market-row"><span>MA Trend</span><b className={maTrendEnabled ? 'up' : ''}>{maTrendEnabled ? 'ON' : 'OFF'}</b></div>
              <div className="market-row"><span>FOMO</span><b className={antiFomo ? 'up' : ''}>{antiFomo ? 'ON' : 'OFF'}</b></div>
              <div className="market-row"><span>Sideway TH1 + TH2</span><b className={sideway1Filter ? 'up' : ''}>{sideway1Filter ? 'ON' : 'OFF'}</b></div>
            </div>

            <div className="panel">
              <div className="panel-title">CROSS EVENTS</div>
              {data?.crosses?.slice(-6).reverse().map((x: any) => (
                <div className="event" key={x.index}>
                  <span className={x.type === 'BUY_CROSS' ? 'buy' : 'sell'}>{x.type === 'BUY_CROSS' ? 'BUY' : 'SELL'}</span>
                  <span>{fmt(x.candle_time || data?.candles?.find((item: any) => Number(item.time) === Number(x.time))?.candle_time)}</span>
                  <b>{Number(x.price).toFixed(2)}</b>
                  <small>{x.trend}</small>
                </div>
              )) || <div className="muted">No replay loaded.</div>}
            </div>
          </div>

          <div className="panel signal-audit-panel">
            <div className="panel-title">SIGNAL / FILTER AUDIT — TOÀN BỘ KHOẢNG THỜI GIAN</div>
            <div className="advisor-row">
              <div><span>TÍN HIỆU</span><b>{signalAudit.length}</b></div>
              <div><span>VÀO LỆNH</span><b>{signalAudit.filter(x => x.status === 'ENTERED').length}</b></div>
              <div><span>BỊ FILTER CHẶN</span><b>{signalAudit.filter(x => x.status === 'BLOCKED').length}</b></div>
              <div><span>BỎ QUA</span><b>{signalAudit.filter(x => x.status === 'SKIPPED').length}</b></div>
            </div>
            <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead><tr>
                  <th style={{textAlign:'left',padding:8}}>Thời gian</th>
                  <th style={{textAlign:'left',padding:8}}>Phương pháp</th>
                  <th style={{textAlign:'left',padding:8}}>Side</th>
                  <th style={{textAlign:'right',padding:8}}>Giá tín hiệu</th>
                  <th style={{textAlign:'left',padding:8}}>Trạng thái</th>
                  <th style={{textAlign:'left',padding:8}}>Lý do</th>
                </tr></thead>
                <tbody>
                  {[...signalAudit].reverse().map((x) => (
                    <tr key={`${x.index}-${x.time}`} style={{borderTop:'1px solid #242a35'}}>
                      <td style={{padding:8,whiteSpace:'nowrap'}}>{fmt(x.candle_time)}</td>
                      <td style={{padding:8}}>{strategyMode === 'ma' ? 'MA Cross' : 'Bollinger'}</td>
                      <td style={{padding:8,color:x.side === 'BUY' ? '#22c55e' : '#ef4444'}}>{x.side}</td>
                      <td style={{padding:8,textAlign:'right'}}>{x.price.toFixed(2)}</td>
                      <td style={{padding:8,color:x.status === 'ENTERED' ? '#22c55e' : x.status === 'BLOCKED' ? '#f59e0b' : '#94a3b8'}}>{x.status}</td>
                      <td style={{padding:8}}>{x.reason}</td>
                    </tr>
                  ))}
                  {!signalAudit.length && <tr><td colSpan={6} style={{padding:12,color:'#94a3b8'}}>Chưa có dữ liệu. Hãy START REPLAY rồi RUN BOT để tạo lịch sử kiểm tra.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel effectiveness-panel">
            <div className="panel-title">FILTER EFFECTIVENESS & CONFIG ADVISOR</div>
            <div className="effect-grid">
              {[['MA TREND',backtestStats.maTrend],['FOMO',backtestStats.fomo],['SIDEWAY',backtestStats.sideway],['BOLLINGER TREND M15',backtestStats.bollinger.trendM15],['BOLLINGER SIDEWAY M15',backtestStats.bollinger.sidewayM15],['BOLLINGER TREND M1',backtestStats.bollinger.trendM1],['BOLLINGER SIDEWAY M1',backtestStats.bollinger.sidewayM1],['SESSION',backtestStats.session],['FRIDAY LOCK',backtestStats.friday]].map(([name,st]:any)=>{
                const blockRate = st.checks > 0 ? (st.blocked / st.checks) * 100 : null;
                const precision = st.blocked > 0 ? (st.correct / st.blocked) * 100 : null;
                return (
                  <div className="effect-card" key={name}>
                    <strong>{name}</strong>
                    <span>{st.checks > 0 ? `Chặn ${st.blocked}/${st.checks}` : 'Không có dữ liệu'}</span>
                    <b>{blockRate === null ? '—' : `${blockRate.toFixed(1)}%`}</b>
                    <small>Đúng {st.correct} · Sai {st.wrong} · Chưa rõ {st.unknown}</small>
                    {precision !== null && <small>Hiệu quả chặn: {precision.toFixed(1)}%</small>}
                  </div>
                );
              })}
            </div>
            <div className="advisor-row"><div><span>TÍN HIỆU</span><b>{backtestStats.totalSignals}</b></div><div><span>ĐƯỢC VÀO</span><b>{backtestStats.acceptedSignals}</b></div><div><span>BỎ QUA (ĐANG CÓ LỆNH)</span><b>{backtestStats.skippedOpen}</b></div><div><span>NO TRADE</span><b>{backtestStats.noTrade}</b></div></div>
            <div className="best-config">
              <span>CẤU HÌNH ĐÃ CHẠY</span>
              <b>{data?.lastBacktestConfig || 'Chưa chạy backtest'}</b>
            </div>

            <div className="recommendations-panel">
              <div className="recommended-head">
                <div>
                  <span>NEXT EXPERIMENTS</span>
                  <strong>Đề xuất cho lần chạy tiếp theo</strong>
                </div>
                {recommendations.length > 0 && <small>Không tự chạy. Chọn đề xuất nào thì cấu hình đó mới được áp dụng và RUN.</small>}
              </div>
              <div className="recommendation-list">
                {recommendations.length ? recommendations.map((r, idx) => (
                  <div className="recommendation-card" key={r.id}>
                    <div className="recommendation-top">
                      <div><span>ĐỀ XUẤT #{idx + 1}</span><strong>{r.title}</strong></div>
                      <button className="recommendation-run" disabled={botRunning} onClick={() => {
                        setFast(r.config.fast); setSlow(r.config.slow); setTrend(r.config.trend); setMaTrendEnabled(r.config.maTrendEnabled);
                        setRrRisk(r.config.rrRisk); setRrReward(r.config.rrReward);
                        setSideway1Filter(r.config.sideway1Filter);
                        setStrategyMode(r.config.strategyMode || 'ma');
                        setBbTrendM15(r.config.bbTrendM15); setBbSidewayM15(r.config.bbSidewayM15);
                        setBbTrendM1(r.config.bbTrendM1); setBbSidewayM1(r.config.bbSidewayM1);
                        setBbSlopeM15Pips(r.config.bbSlopeM15Pips); setBbWidthM15(r.config.bbWidthM15);
                        setBbSlopeM1Pips(r.config.bbSlopeM1Pips); setBbWidthM1(r.config.bbWidthM1);
                        setBbSidewaySlopeM15Pips(r.config.bbSidewaySlopeM15Pips); setBbSidewayWidthM15(r.config.bbSidewayWidthM15);
                        setBbSidewaySlopeM1Pips(r.config.bbSidewaySlopeM1Pips); setBbSidewayWidthM1(r.config.bbSidewayWidthM1);
                        setAntiFomo(r.config.antiFomo); setBreakEven(r.config.breakEven); setTrailing(r.config.trailing);
                        setFridayLock(r.config.fridayLock); setUseLotChain(r.config.useLotChain);
                        setBaseLot(r.config.baseLot); setUseTradingSession(r.config.useTradingSession); setSessionFrom(r.config.sessionFrom); setSessionTo(r.config.sessionTo);
                        setCustomLotChain(r.config.lotChain.join(', ')); setLotChainMode('custom');
                        void runBot(r.config);
                      }}>DÙNG CẤU HÌNH NÀY & RUN</button>
                    </div>
                    <div className="recommendation-config">{configLabel(r.config)}</div>
                    <div className="recommendation-reason"><b>Vì sao:</b> {r.reason}</div>
                    <div className="recommendation-reason"><b>Mục tiêu kiểm chứng:</b> {r.expected}</div>
                  </div>
                )) : <div className="muted">Sau mỗi RUN BOT, hệ thống đưa ra tối đa 3 cấu hình đáng thử tiếp theo.</div>}
              </div>
            </div>

            <div className="session-advisor">
              <div className="recommended-head">
                <div>
                  <span>SESSION ADVISOR</span>
                  <strong>Phân tích dữ liệu của chính lần backtest này</strong>
                </div>
              </div>
              <div className="recommend-grid">
                <div><span>BEST HOUR</span><b>{backtestStats.sessionAdvisor.bestHour}</b></div>
                <div><span>BEST WINDOW</span><b>{backtestStats.sessionAdvisor.bestWindow}</b></div>
                <div><span>WINDOW P/L</span><b className={backtestStats.sessionAdvisor.bestPnl >= 0 ? 'up' : 'down'}>${backtestStats.sessionAdvisor.bestPnl.toFixed(2)}</b></div>
                <div><span>WIN RATE</span><b>{backtestStats.sessionAdvisor.bestWinRate.toFixed(1)}%</b></div>
                <div><span>TRADES</span><b>{backtestStats.sessionAdvisor.trades}</b></div>
              </div>
              <small>{backtestStats.sessionAdvisor.recommendation}</small>
            </div>

            <div className="advisor-note">
              <div className="recommended-head">
                <div>
                  <span>CONFIG ADVISOR</span>
                  <strong>Khuyến nghị thay đổi — không tự động đổi cấu hình</strong>
                </div>
              </div>
              <div className="advice-list">
                {backtestStats.advice.length > 0
                  ? backtestStats.advice.map((x,i)=><div key={i}>• {x}</div>)
                  : <div>Chạy RUN BOT để hệ thống phân tích kết quả và đưa ra khuyến nghị.</div>}
              </div>
            </div>
          </div>

          <div className="panel run-history-panel">
            <div className="panel-title">BACKTEST EXPERIMENT HISTORY</div>
            <div className="history-table-wrap">
              <table className="trade-table">
                <thead><tr><th>RUN</th><th>CONFIG</th><th>P/L</th><th>PF</th><th>WR</th><th>DD</th><th>TRADES</th></tr></thead>
                <tbody>
                  {runHistory.length ? runHistory.map(h => (
                    <tr key={h.run}><td>#{h.run}</td><td>{configLabel(h.config)}</td><td className={h.pnl >= 0 ? 'up' : 'down'}>${h.pnl.toFixed(2)}</td><td>{h.profitFactor.toFixed(2)}</td><td>{h.winRate.toFixed(1)}%</td><td className="down">${h.drawdown.toFixed(2)}</td><td>{h.trades}</td></tr>
                  )) : <tr><td colSpan={7} className="muted">Chưa có lần chạy nào.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel trades-panel">
            <div className="trades-header">
              <div>
                <div className="panel-title">BOT TRADE HISTORY</div>
                <div className="trade-summary">
                  <span>Orders <b>{trades.length}</b></span>
                  <span>Win <b className="up">{wins}</b></span>
                  <span>Loss <b className="down">{losses}</b></span>
                  <span>P/L <b className={totalPnl >= 0 ? 'up' : 'down'}>${totalPnl.toFixed(2)}</b></span>
                </div>
              </div>
              <div className="bot-status">
                {botRunning ? 'BOT FINISHED' : 'BOT READY'}
              </div>
            </div>

            <div className="trade-table-wrap">
              <table className="trade-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Side</th>
                    <th>Entry Time</th>
                    <th>Entry</th>
                    <th>Exit Time</th>
                    <th>Exit</th>
                    <th>Lot</th>
                    <th>P/L</th>
                    <th>Result</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.length ? trades.map((trade) => (
                    <tr key={trade.id}>
                      <td>{trade.id}</td>
                      <td className={trade.side === 'BUY' ? 'buy' : 'sell'}>{trade.side}</td>
                      <td>{fmt(trade.entryCandleTime)}</td>
                      <td>{trade.entryPrice.toFixed(2)}</td>
                      <td>{fmt(trade.exitCandleTime)}</td>
                      <td>{trade.exitPrice.toFixed(2)}</td>
                      <td>{trade.lot.toFixed(2)}</td>
                      <td className={trade.pnl >= 0 ? 'up' : 'down'}>{trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}</td>
                      <td><span className={`result ${trade.result.toLowerCase()}`}>{trade.result}</span></td>
                      <td>{trade.reason}</td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={10} className="empty-table">Chưa có lệnh. Hãy START REPLAY rồi bấm RUN BOT.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel trades-panel">
            <div className="panel-title">SIGNAL & FILTER HISTORY</div>
            <div className="trade-table-wrap">
              <table className="trade-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Time</th>
                    <th>Signal</th>
                    <th>Price</th>
                    <th>Status</th>
                    <th>Filter / explanation</th>
                  </tr>
                </thead>
                <tbody>
                  {signalAudit.length ? signalAudit.map((item, idx) => (
                    <tr key={`${item.index}-${item.side}-${idx}`}>
                      <td>{idx + 1}</td>
                      <td>{fmt(item.candle_time)}</td>
                      <td className={item.side === 'BUY' ? 'buy' : 'sell'}>{item.side}</td>
                      <td>{Number(item.price).toFixed(2)}</td>
                      <td>
                        <span className={`result ${item.status.toLowerCase()}`}>
                          {item.status === 'ENTERED' ? 'ĐÃ VÀO LỆNH'
                            : item.status === 'BLOCKED' ? 'BỊ FILTER CHẶN'
                            : item.status === 'SKIPPED' ? 'BỎ QUA'
                            : 'TÍN HIỆU'}
                        </span>
                      </td>
                      <td>{item.reason || (item.status === 'ENTERED' ? 'Không có filter nào chặn tín hiệu.' : 'Không có lý do chi tiết.')}</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={6} className="empty-table">Chưa có lịch sử tín hiệu. Hãy START REPLAY rồi RUN BOT.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
