'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import MarketChart from '../../components/MarketChart';
import { api } from '../../lib/api';

type Trade = {
  id: number;
  side: 'BUY' | 'SELL';
  entryTime: number;
  entryPrice: number;
  exitTime: number;
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
  waited?: number;
};

type RunConfig = {
  fast: number; slow: number; trend: number; maTrendEnabled: boolean;
  sidewayFilter: boolean; antiFomo: boolean; breakEven: boolean; trailing: boolean;
  aiProfitExit: boolean; fridayLock: boolean; useLotChain: boolean;
  lotChain: number[]; baseLot: number; useTradingSession: boolean;
  sessionFrom: string; sessionTo: string;
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
  fomo: FilterStat;
  session: FilterStat;
  friday: FilterStat;
  totalSignals: number;
  acceptedSignals: number;
  marketEntries: number;
  limitEntries: number;
  noTrade: number;
  advice: string[];
  sessionAdvisor: { bestWindow: string; bestHour: string; bestPnl: number; bestWinRate: number; trades: number; recommendation: string; };
  aiExit: {
    enabled: boolean;
    closes: number;
    holds: number;
    protects: number;
    averageScore: number;
    averageProfit: number;
  };
};

const emptyFilterStat = (): FilterStat => ({ checks: 0, blocked: 0, correct: 0, wrong: 0, unknown: 0, waited: 0 });

const emptyAiExitStat = () => ({ enabled: false, closes: 0, holds: 0, protects: 0, averageScore: 0, averageProfit: 0 });
const emptySessionAdvisor = () => ({ bestWindow: '—', bestHour: '—', bestPnl: 0, bestWinRate: 0, trades: 0, recommendation: 'Chưa đủ dữ liệu để đưa ra khuyến nghị.' });

const bodyPower = (candles: any[], index: number) => {
  if (index < 20) return 0;
  const current = Math.abs(Number(candles[index].close) - Number(candles[index].open));
  const avg = candles.slice(index - 20, index).reduce((sum, c) => sum + Math.abs(Number(c.close) - Number(c.open)), 0) / 20;
  return avg > 0 ? current / avg : 0;
};

const candleColor = (c: any) => Number(c.close) > Number(c.open) ? 'GREEN' : Number(c.close) < Number(c.open) ? 'RED' : 'DOJI';

function calcIndicators(candles: any[], fast: number, slow: number, trend: number) {
  const out = candles.map((c) => ({ ...c }));
  // Match pandas Series.ewm(span=period).mean() from the VPS engine (adjust=True).
  const ema = (period: number) => {
    const alpha = 2 / (period + 1);
    const decay = 1 - alpha;
    let weighted = 0;
    let weightSum = 0;
    return out.map((c) => {
      const close = Number(c.close);
      weighted = close + decay * weighted;
      weightSum = 1 + decay * weightSum;
      return weightSum > 0 ? weighted / weightSum : close;
    });
  };
  const ef = ema(fast), es = ema(slow);
  let sum = 0;
  const mt = out.map((c, i) => {
    sum += Number(c.close);
    if (i >= trend) sum -= Number(out[i - trend].close);
    return i + 1 >= trend ? sum / trend : null;
  });
  return out.map((c, i) => ({ ...c, ema_fast: ef[i], ema_slow: es[i], ma_trend: mt[i], ma_fast: ef[i], ma_slow: es[i], ema_trend: mt[i] }));
}

function detectCrosses(candles: any[]) {
  const crosses: any[] = [];
  for (let i = 1; i < candles.length; i++) {
    const p = candles[i - 1], c = candles[i];
    if (Number(p.ema_fast) < Number(p.ema_slow) && Number(c.ema_fast) > Number(c.ema_slow)) crosses.push({ index: i, time: Number(c.time), price: Number(c.close), type: 'BUY_CROSS' });
    if (Number(p.ema_fast) > Number(p.ema_slow) && Number(c.ema_fast) < Number(c.ema_slow)) crosses.push({ index: i, time: Number(c.time), price: Number(c.close), type: 'SELL_CROSS' });
  }
  return crosses;
}

function fomoTh1(candles: any[], i: number) {
  if (i < 20) return false;
  const c = candles[i];
  const body = Math.abs(Number(c.close) - Number(c.open));
  const avg = candles.slice(i - 20, i).reduce((s, x) => s + Math.abs(Number(x.close) - Number(x.open)), 0) / 20;
  const range = Number(c.high) - Number(c.low);
  return avg > 0 && body > avg * 1.8 && range > 0 && body / range > 0.65;
}

function fomoTh2(candles: any[], i: number, crossPrice: number, side: 'BUY'|'SELL') {
  if (i < 3) return false;
  const cs = candles.slice(i - 3, i);
  const avgHigh = cs.reduce((s,c)=>s+Number(c.high),0)/3;
  const avgLow = cs.reduce((s,c)=>s+Number(c.low),0)/3;
  const avgRange = Math.abs(avgHigh-avgLow);
  const distance = side === 'BUY' ? Math.abs(crossPrice-Math.min(...cs.map(c=>Number(c.low)))) : Math.abs(crossPrice-Math.max(...cs.map(c=>Number(c.high))));
  return distance > 0 && avgRange < distance * 4;
}

function fomoTh3(candles: any[], i: number, side: 'BUY'|'SELL') {
  if (i < 2) return { pass:false, decision:null, limitPrice:null };
  const cs = [candles[i-2], candles[i-1], candles[i]];
  const colors = cs.map(candleColor);
  if (colors.includes('DOJI')) return { pass:false, decision:null, limitPrice:null };
  const needed = side === 'BUY' ? 'GREEN' : 'RED';
  const pass = colors.every(c => c === needed);
  return { pass, decision: pass ? `${side}_LIMIT` : null, limitPrice: pass ? (Number(candles[i-1].high)+Number(candles[i-1].low))/2 : null };
}

function atrValue(candles: any[], index: number, period = 14) {
  if (index < 1) return 0;
  const start = Math.max(1, index - period + 1);
  let total = 0;
  let count = 0;
  for (let i = start; i <= index; i++) {
    const high = Number(candles[i].high);
    const low = Number(candles[i].low);
    const prevClose = Number(candles[i - 1].close);
    total += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    count++;
  }
  return count ? total / count : 0;
}

function rsiValue(candles: any[], index: number, period = 14) {
  if (index < period) return 50;
  let gains = 0, losses = 0;
  const start = index - period + 1;
  for (let i = start; i <= index; i++) {
    const diff = Number(candles[i].close) - Number(candles[i - 1].close);
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return gains > 0 ? 100 : 50;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

type AiProfitExitResult = {
  action: 'HOLD' | 'PROTECT' | 'CLOSE';
  score: number;
  reasons: string[];
};

/**
 * Adaptive profit-exit engine.
 * The user only enables/disables it. Internal weights/thresholds are deliberately
 * hidden from the UI and can be optimized during backtest.
 */
function aiProfitExitDecision(
  candles: any[],
  index: number,
  side: 'BUY' | 'SELL',
  entryPrice: number,
  currentPrice: number,
  tpPrice?: number,
  threshold = 7,
): AiProfitExitResult {
  if (index < 25) return { action: 'HOLD', score: 0, reasons: [] };

  const direction = side === 'BUY' ? 1 : -1;
  const profit = (currentPrice - entryPrice) * direction;
  if (profit <= 0) return { action: 'HOLD', score: 0, reasons: [] };

  const current = candles[index];
  const prev = candles[index - 1];
  const prev2 = candles[index - 2];
  const reasons: string[] = [];
  let score = 0;

  // Trend reversal / EMA deterioration.
  const e9Now = Number(current.ema_fast ?? current.ma_fast ?? current.close);
  const e21Now = Number(current.ema_slow ?? current.ma_slow ?? current.close);
  const e9Past = Number(candles[index - 3].ema_fast ?? candles[index - 3].ma_fast ?? candles[index - 3].close);
  const e21Past = Number(candles[index - 1].ema_slow ?? candles[index - 1].ma_slow ?? candles[index - 1].close);
  const e9Prev = Number(candles[index - 1].ema_fast ?? candles[index - 1].ma_fast ?? candles[index - 1].close);
  const emaSlope = (e9Now - e9Past) * direction;
  const emaGap = (e9Now - e21Now) * direction;
  const prevGap = (e9Prev - e21Past) * direction;
  if (emaSlope < 0) { score += 2; reasons.push('EMA momentum suy yếu'); }
  if (emaGap < 0) { score += 2; reasons.push('EMA trend không còn ủng hộ'); }
  else if (prevGap > 0 && emaGap < prevGap * 0.55) { score += 1.5; reasons.push('Khoảng cách EMA co lại'); }

  // Candle weakness / reversal.
  const cp = bodyPower(candles, index);
  const currentBody = Math.abs(Number(current.close) - Number(current.open));
  const prevBody = Math.abs(Number(prev.close) - Number(prev.open));
  const favorableCurrent = (Number(current.close) - Number(current.open)) * direction > 0;
  const favorablePrev = (Number(prev.close) - Number(prev.open)) * direction > 0;
  if (cp > 0 && cp < 0.65) { score += 1.5; reasons.push('Candle yếu'); }
  if (favorablePrev && !favorableCurrent) { score += 2; reasons.push('Candle mất hướng'); }
  if (currentBody < prevBody * 0.55 && prevBody > 0) { score += 1; reasons.push('Biên độ candle giảm'); }

  // Short-term momentum.
  const m3 = (Number(current.close) - Number(candles[index - 3].close)) * direction;
  const m6 = (Number(current.close) - Number(candles[index - 6].close)) * direction;
  const atr = atrValue(candles, index);
  if (atr > 0 && m3 < atr * 0.15) { score += 1.5; reasons.push('Momentum ngắn hạn yếu'); }
  if (atr > 0 && m6 < 0) { score += 2; reasons.push('Momentum đang đảo chiều'); }

  // RSI exhaustion, used as a supporting factor only.
  const rsi = rsiValue(candles, index);
  if ((side === 'BUY' && rsi >= 72) || (side === 'SELL' && rsi <= 28)) {
    score += 1.5;
    reasons.push(`RSI cực trị ${rsi.toFixed(0)}`);
  }

  // Profit maturity: do not close merely because profit is positive.
  if (tpPrice) {
    const total = Math.abs(tpPrice - entryPrice);
    const reached = total > 0 ? Math.abs(currentPrice - entryPrice) / total : 0;
    if (reached >= 0.75) { score += 1; reasons.push('Đã đạt phần lớn TP'); }
    if (reached >= 0.95) { score += 1; reasons.push('Rất gần TP'); }
  } else if (atr > 0 && profit >= atr * 1.5) {
    score += 1;
    reasons.push('Profit đã lớn so với ATR');
  }

  // Reversal candle structure.
  const prevMove = (Number(prev.close) - Number(prev2.close)) * direction;
  const currentMove = (Number(current.close) - Number(prev.close)) * direction;
  if (prevMove > 0 && currentMove < 0) {
    score += 1.5;
    reasons.push('Xuất hiện nến đảo chiều');
  }

  const action: AiProfitExitResult['action'] = score >= threshold ? 'CLOSE' : score >= threshold - 2.5 ? 'PROTECT' : 'HOLD';
  return { action, score, reasons };
}

function calculateSlTp(candles: any[], index: number, side: 'BUY'|'SELL', entry: number, rr = 1.5) {
  const start = Math.max(0, index - 9);
  const tail = candles.slice(start, index + 1);
  const lows = tail.map(c => Number(c.low)).filter(Number.isFinite);
  const highs = tail.map(c => Number(c.high)).filter(Number.isFinite);
  const atr = atrValue(candles, index) || Math.abs(entry) * 0.001;
  const buffer = atr * 0.10;
  const baseSl = side === 'BUY' ? Math.min(...lows) - buffer : Math.max(...highs) + buffer;
  const baseRisk = Math.max(Math.abs(entry - baseSl), atr * 0.25);
  // Deterministic 10%-15% extension. The live engine uses random.uniform(0.10, 0.15);
  // a deterministic value is required so the same backtest always gives the same result.
  const extraPct = 0.125;
  const slDistance = baseRisk * (1 + extraPct);
  const tpDistance = baseRisk * rr * (1 - 0.01);
  return side === 'BUY'
    ? { sl: entry - slDistance, tp: entry + tpDistance }
    : { sl: entry + slDistance, tp: entry - tpDistance };
}

function favorableMove(side: 'BUY'|'SELL', from: number, to: number) {
  return (to - from) * (side === 'BUY' ? 1 : -1);
}

function hypotheticalBlockedOutcome(
  candles: any[],
  crossByIndex: Map<number, any>,
  start: number,
  side: 'BUY' | 'SELL',
  entry: number,
): 'WIN' | 'LOSS' | 'UNKNOWN' {
  // A blocked signal is evaluated counterfactually using the same deterministic
  // SL/TP model as the real backtest. This answers whether the blocked
  // signal would have produced a good or bad outcome.
  const sltp = calculateSlTp(candles, start, side, entry);

  for (let j = start + 1; j < Math.min(candles.length, start + 31); j++) {
    const c = candles[j];
    const low = Number(c.low);
    const high = Number(c.high);
    const slHit = side === 'BUY' ? low <= sltp.sl : high >= sltp.sl;
    const tpHit = side === 'BUY' ? high >= sltp.tp : low <= sltp.tp;

    // Same conservative rule as the real engine: if both are touched on the
    // same M1 candle, assume SL happened first.
    if (slHit && tpHit) return 'LOSS';
    if (slHit) return 'LOSS';
    if (tpHit) return 'WIN';

    // The live/backtest engine also closes an open trade on an opposite MA
    // cross when no SL/TP/AI exit happened first.
    const cross = crossByIndex.get(j);
    if (cross) {
      const crossSide: 'BUY' | 'SELL' = cross.type === 'BUY_CROSS' ? 'BUY' : 'SELL';
      if (crossSide !== side) {
        const exit = Number(cross.price);
        const pnlMove = (exit - entry) * (side === 'BUY' ? 1 : -1);
        if (pnlMove > 0) return 'WIN';
        if (pnlMove < 0) return 'LOSS';
        return 'UNKNOWN';
      }
    }
  }

  return 'UNKNOWN';
}


const fmt = (ts: number) =>
  new Date(ts * 1000).toLocaleString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  });

const parseLotChain = (value: string) =>
  value
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0);

export default function Backtest() {
  const router = useRouter();

  const [from, setFrom] = useState('2026-09-01T00:00');
  const [to, setTo] = useState('2026-09-30T23:59');

  const [fast, setFast] = useState(9);
  const [slow, setSlow] = useState(21);
  const [trend, setTrend] = useState(200);
  const [maTrendEnabled, setMaTrendEnabled] = useState(true);
  const [speed, setSpeed] = useState(1);

  // Filters - match Trend UI config names.
  const [sidewayFilter, setSidewayFilter] = useState(true);
  const [antiFomo, setAntiFomo] = useState(true);

  // Position management.
  const [breakEven, setBreakEven] = useState(true);
  const [trailing, setTrailing] = useState(true);
  const [aiProfitExit, setAiProfitExit] = useState(true);
  const [fridayLock, setFridayLock] = useState(true);

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
  const [botBalance, setBotBalance] = useState(100000);
  const [backtestStats, setBacktestStats] = useState<BacktestStats>({ sideway: emptyFilterStat(), fomo: emptyFilterStat(), session: emptyFilterStat(), friday: emptyFilterStat(), totalSignals: 0, acceptedSignals: 0, marketEntries: 0, limitEntries: 0, noTrade: 0, advice: [], sessionAdvisor: emptySessionAdvisor(), aiExit: emptyAiExitStat() });
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

  function isWithinTradingSession(ts: number) {
    if (!useTradingSession) return true;

    const d = new Date(ts * 1000);
    const minutes = d.getHours() * 60 + d.getMinutes();
    const [fh, fm] = sessionFrom.split(':').map(Number);
    const [th, tm] = sessionTo.split(':').map(Number);
    const fromMinutes = fh * 60 + fm;
    const toMinutes = th * 60 + tm;

    if (fromMinutes <= toMinutes) {
      return minutes >= fromMinutes && minutes <= toMinutes;
    }

    return minutes >= fromMinutes || minutes <= toMinutes;
  }

  function isFridayLocked(ts: number) {
    if (!fridayLock) return false;
    const d = new Date(ts * 1000);
    return d.getDay() === 5 && d.getHours() >= 20;
  }

  function resolveLot(lossStreak: number) {
    if (!useLotChain) return baseLot;
    const chain = lotChain.length ? lotChain : [baseLot];
    return chain[Math.min(lossStreak, chain.length - 1)];
  }

  /**
   * Client-side replay runner. The backend only supplies market/candle data;
   * all strategy, filters and AI-style profit-exit decisions are simulated here.
   */
  /**
   * Run exactly ONE configuration from the UI.
   * There is deliberately NO optimizer and NO automatic config mutation here.
   */
  function getCurrentConfig(): RunConfig {
    return {
      fast, slow, trend, maTrendEnabled, sidewayFilter, antiFomo, breakEven, trailing,
      aiProfitExit, fridayLock, useLotChain, lotChain: [...lotChain], baseLot,
      useTradingSession, sessionFrom, sessionTo,
    };
  }

  function configLabel(c: RunConfig) {
    return [
      `MA ${c.fast}/${c.slow}`, `Trend ${c.trend} ${c.maTrendEnabled ? 'ON' : 'OFF'}`,
      c.sidewayFilter ? 'Sideway ON' : 'Sideway OFF', c.antiFomo ? 'FOMO ON' : 'FOMO OFF',
      c.breakEven ? 'BE ON' : 'BE OFF', c.trailing ? 'Trailing ON' : 'Trailing OFF',
      c.aiProfitExit ? 'AI Exit ON' : 'AI Exit OFF', c.fridayLock ? 'Friday ON' : 'Friday OFF',
      c.useTradingSession ? `Session ${c.sessionFrom}-${c.sessionTo}` : 'Session OFF',
    ].join(' · ');
  }

  function makeRecommendations(cfg: RunConfig, stats: BacktestStats, result: Trade[], pnl: number, drawdown: number): ConfigRecommendation[] {
    const out: ConfigRecommendation[] = [];
    const clone = (patch: Partial<RunConfig>): RunConfig => ({ ...cfg, lotChain: [...cfg.lotChain], ...patch });
    const add = (id: string, title: string, reason: string, expected: string, patch: Partial<RunConfig>) => {
      const next = clone(patch);
      if (configLabel(next) !== configLabel(cfg)) out.push({ id, title, reason, expected, config: next });
    };

    if (result.length === 0) {
      if (cfg.antiFomo) add('fomo-off', 'Thử tắt Anti FOMO', 'Lần chạy hiện tại không có lệnh hoàn tất và Anti FOMO có thể đang loại quá nhiều tín hiệu.', 'Kiểm tra xem số lệnh có tăng mà chất lượng vẫn giữ được hay không.', { antiFomo: false });
      if (cfg.sidewayFilter) add('sideway-off', 'Thử tắt Sideway Filter', 'Không có lệnh hoàn tất; Sideway có thể đang chặn phần lớn cross sau chuỗi thua.', 'Kiểm chứng riêng tác động của Sideway.', { sidewayFilter: false });
    } else {
      const fomoPrecision = stats.fomo.blocked > 0 ? stats.fomo.correct / stats.fomo.blocked * 100 : null;
      const sidewayPrecision = stats.sideway.blocked > 0 ? stats.sideway.correct / stats.sideway.blocked * 100 : null;

      if (stats.fomo.blocked >= Math.max(5, Math.ceil(stats.totalSignals * 0.15)) && fomoPrecision !== null && fomoPrecision < 55) {
        add('fomo-off', 'Thử Anti FOMO = OFF', `Anti FOMO đã BLOCK ${stats.fomo.blocked}/${stats.fomo.checks}. Hiệu quả chặn chỉ ${fomoPrecision.toFixed(1)}% (đúng ${stats.fomo.correct}, sai ${stats.fomo.wrong}).`, 'Kiểm tra xem FOMO có đang loại quá nhiều tín hiệu tốt hay không.', { antiFomo: false });
      } else if (stats.fomo.blocked >= 5 && fomoPrecision !== null && fomoPrecision >= 70) {
        add('fomo-keep', 'Giữ Anti FOMO để kiểm chứng thêm', `Anti FOMO BLOCK ${stats.fomo.blocked} case và ${fomoPrecision.toFixed(1)}% số case bị chặn có outcome xấu theo counterfactual.`, 'Chạy lại trên khoảng dữ liệu khác để xác nhận filter không bị overfit.', { antiFomo: true });
      }

      if (stats.sideway.blocked >= 5 && sidewayPrecision !== null && sidewayPrecision < 55) {
        add('sideway-off', 'Thử Sideway = OFF', `Sideway BLOCK ${stats.sideway.blocked}/${stats.sideway.checks}, nhưng hiệu quả chặn chỉ ${sidewayPrecision.toFixed(1)}% (đúng ${stats.sideway.correct}, sai ${stats.sideway.wrong}).`, 'Kiểm tra xem Sideway có đang bỏ lỡ quá nhiều lệnh tốt sau loss streak hay không.', { sidewayFilter: false });
      } else if (stats.sideway.blocked >= 5 && sidewayPrecision !== null && sidewayPrecision >= 70) {
        add('sideway-keep', 'Giữ Sideway để kiểm chứng thêm', `Sideway BLOCK ${stats.sideway.blocked} case và hiệu quả chặn ${sidewayPrecision.toFixed(1)}%.`, 'Chạy trên giai đoạn khác để xác nhận filter thực sự có lợi thế.', { sidewayFilter: true });
      }
      if (cfg.breakEven) {
        const beTrades = result.filter(t => /Break Even/i.test(t.reason));
        if (beTrades.length >= 3) add('be-off', 'Thử Break Even = OFF', `${beTrades.length} lệnh bị đóng bởi Break Even trong lần chạy này.`, 'Kiểm tra xem các lệnh BE có thường tiếp tục chạy đúng hướng hay không.', { breakEven: false });
      }
      if (cfg.trailing) {
        const trailingTrades = result.filter(t => /Trailing Stop/i.test(t.reason));
        if (trailingTrades.length >= 3) add('trailing-off', 'Thử Trailing Stop = OFF', `${trailingTrades.length} lệnh bị đóng bởi Trailing Stop.`, 'Kiểm tra khả năng giữ lệnh lâu hơn thay vì khóa lợi nhuận quá sớm.', { trailing: false });
      }
      if (cfg.aiProfitExit && stats.aiExit.closes >= 3) {
        add('ai-off', 'Thử AI Profit Exit = OFF', `AI Profit Exit đã chủ động đóng ${stats.aiExit.closes} lệnh.`, 'So sánh trực tiếp với SL/TP + BE/Trailing mà không có AI Exit.', { aiProfitExit: false });
      }
      if (!cfg.aiProfitExit && pnl > 0 && stats.totalSignals > 20) {
        add('ai-on', 'Thử AI Profit Exit = ON', 'Lần chạy có đủ số tín hiệu để kiểm tra thêm lớp quản lý profit.', 'Kiểm tra AI Exit có giảm drawdown mà không làm mất quá nhiều profit hay không.', { aiProfitExit: true });
      }
      if (cfg.fast === 9 && cfg.slow === 21) {
        add('ma-10-21', 'Thử MA 10 / 21', 'MA 9/21 là baseline hiện tại; thay đổi Fast MA một bước giúp kiểm chứng độ nhạy của cross.', 'So sánh số false cross và Profit Factor với baseline.', { fast: 10, slow: 21 });
      } else {
        add('ma-9-21', 'Thử quay về MA 9 / 21', 'Baseline 9/21 là mốc tham chiếu dễ so sánh với cấu hình hiện tại.', 'Kiểm tra xem thay đổi MA hiện tại có thực sự cải thiện hay chỉ do mẫu dữ liệu.', { fast: 9, slow: 21 });
      }
      if (cfg.useTradingSession) {
        const best = stats.sessionAdvisor.bestWindow;
        if (best && best !== '—' && best.includes('-')) {
          const m = best.match(/(\d{2}):00 - (\d{2}):00/);
          if (m) add('session-best', 'Thử Session theo cửa sổ tốt nhất', `Cửa sổ ${best} có P/L tốt nhất trong chính lần backtest này.`, 'Kiểm chứng session tốt nhất trên cùng tập dữ liệu trước khi dùng live.', { useTradingSession: true, sessionFrom: `${m[1]}:00`, sessionTo: `${m[2]}:00` });
        }
      } else if (stats.sessionAdvisor.bestWindow !== '—') {
        const m = stats.sessionAdvisor.bestWindow.match(/(\d{2}):00 - (\d{2}):00/);
        if (m) add('session-on', 'Thử bật Trading Session', `Dữ liệu cho thấy có cửa sổ ${stats.sessionAdvisor.bestWindow} đáng kiểm tra.`, 'Kiểm tra việc giới hạn giờ giao dịch có giảm drawdown không.', { useTradingSession: true, sessionFrom: `${m[1]}:00`, sessionTo: `${m[2]}:00` });
      }
    }

    // Always give the user actionable next experiments, but never more than 3.
    if (out.length < 3 && cfg.breakEven && !out.some(x => x.id === 'be-off')) add('be-off-fallback', 'Thử Break Even = OFF', 'BE là biến quản lý vị thế độc lập, phù hợp để kiểm chứng riêng.', 'So sánh profit giữ lại và drawdown.', { breakEven: false });
    if (out.length < 3 && cfg.trailing && !out.some(x => x.id === 'trailing-off')) add('trailing-off-fallback', 'Thử Trailing Stop = OFF', 'Trailing có thể làm thay đổi điểm thoát mà không ảnh hưởng Entry.', 'Kiểm chứng lợi nhuận giữ lại khi để SL/TP tự nhiên.', { trailing: false });
    if (out.length < 3 && cfg.aiProfitExit && !out.some(x => x.id === 'ai-off')) add('ai-off-fallback', 'Thử AI Profit Exit = OFF', 'AI Exit là lớp độc lập và nên được A/B test riêng.', 'So sánh tác động của AI Exit với cấu hình hiện tại.', { aiProfitExit: false });
    return out.slice(0, 3);
  }

  async function runBot(overrides?: RunConfig) {
    const runCfg = overrides || getCurrentConfig();
    const fast = runCfg.fast; const slow = runCfg.slow; const trend = runCfg.trend;
    const maTrendEnabled = runCfg.maTrendEnabled; const sidewayFilter = runCfg.sidewayFilter; const antiFomo = runCfg.antiFomo;
    const breakEven = runCfg.breakEven; const trailing = runCfg.trailing; const aiProfitExit = runCfg.aiProfitExit;
    const fridayLock = runCfg.fridayLock; const useLotChain = runCfg.useLotChain; const lotChain = runCfg.lotChain;
    const baseLot = runCfg.baseLot; const useTradingSession = runCfg.useTradingSession;
    const sessionFrom = runCfg.sessionFrom; const sessionTo = runCfg.sessionTo;
    const isWithinTradingSession = (ts: number) => {
      if (!useTradingSession) return true;
      const d = new Date(ts * 1000);
      const minutes = d.getHours() * 60 + d.getMinutes();
      const [fh, fm] = sessionFrom.split(':').map(Number);
      const [th, tm] = sessionTo.split(':').map(Number);
      const fromMinutes = fh * 60 + fm;
      const toMinutes = th * 60 + tm;
      return fromMinutes <= toMinutes
        ? minutes >= fromMinutes && minutes <= toMinutes
        : minutes >= fromMinutes || minutes <= toMinutes;
    };
    const isFridayLocked = (ts: number) => {
      if (!fridayLock) return false;
      const d = new Date(ts * 1000);
      return d.getDay() === 5 && d.getHours() >= 20;
    };
    const resolveLot = (lossStreak: number) => {
      if (!useLotChain) return baseLot;
      const chain = lotChain.length ? lotChain : [baseLot];
      return chain[Math.min(lossStreak, chain.length - 1)];
    };
    if (!data?.candles?.length) {
      setError('Hãy START REPLAY trước khi chạy bot.');
      return;
    }

    setError('');
    setPlaying(false);
    setBotRunning(true);

    const candles = calcIndicators(data.candles, fast, slow, trend);
    const crosses = detectCrosses(candles);
    const crossByIndex = new Map(crosses.map(x => [x.index, x]));
    const result: Trade[] = [];
    const sideway = emptyFilterStat();
    const fomo = emptyFilterStat();
    const session = emptyFilterStat();
    const friday = emptyFilterStat();
    const aiExitStat = emptyAiExitStat();
    aiExitStat.enabled = aiProfitExit;

    let balance = initialBalance;
    let peakBalance = balance;
    let maxDrawdown = 0;
    let lossStreak = 0;
    let lastLossCrossPrice: number | null = null;
    let open: any = null;
    let pendingLimit: any = null;
    let tradeId = 1;
    let acceptedSignals = 0;
    let marketEntries = 0;
    let limitEntries = 0;
    let noTrade = 0;
    let grossWin = 0;
    let grossLoss = 0;
    let aiScoreTotal = 0;
    let aiScoreSamples = 0;
    let aiProfitTotal = 0;

    const hourStats: Record<number, { trades: number; pnl: number; wins: number }> = {};
    for (let h = 0; h < 24; h++) hourStats[h] = { trades: 0, pnl: 0, wins: 0 };

    const updateDrawdown = () => {
      peakBalance = Math.max(peakBalance, balance);
      maxDrawdown = Math.max(maxDrawdown, peakBalance - balance);
    };

    const recordBlockedSignal = (stat: FilterStat, index: number, side: 'BUY' | 'SELL', entry: number) => {
      stat.blocked++;
      const outcome = hypotheticalBlockedOutcome(candles, crossByIndex, index, side, entry);
      if (outcome === 'LOSS') stat.correct++;
      else if (outcome === 'WIN') stat.wrong++;
      else stat.unknown++;
    };

    const closeTrade = (exitTime: number, exitPrice: number, reason: string) => {
      if (!open) return;
      const direction = open.side === 'BUY' ? 1 : -1;
      const pnl = Number(((exitPrice - open.entryPrice) * direction * open.lot * 100).toFixed(2));
      const r: Trade['result'] = pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'BE';
      balance += pnl;
      updateDrawdown();
      if (pnl > 0) grossWin += pnl;
      if (pnl < 0) grossLoss += Math.abs(pnl);
      const hour = new Date(open.entryTime * 1000).getHours();
      hourStats[hour].trades++;
      hourStats[hour].pnl += pnl;
      if (pnl > 0) hourStats[hour].wins++;
      result.push({
        id: open.id,
        side: open.side,
        entryTime: open.entryTime,
        entryPrice: open.entryPrice,
        exitTime,
        exitPrice,
        lot: open.lot,
        pnl,
        result: r,
        reason,
      });
      lossStreak = r === 'LOSS' ? lossStreak + 1 : 0;
      if (r === 'LOSS') lastLossCrossPrice = open.crossPrice;
      open = null;
    };

    const managePosition = (i: number, c: any) => {
      if (!open) return false;

      // 1. SL/TP are evaluated from candle OHLC. If both are touched by the same
      // candle and tick data is unavailable, use the conservative SL-first rule.
      const low = Number(c.low), high = Number(c.high);
      const slHit = open.side === 'BUY' ? low <= open.sl : high >= open.sl;
      const tpHit = open.side === 'BUY' ? high >= open.tp : low <= open.tp;
      if (slHit && tpHit) {
        closeTrade(Number(c.time), open.sl, 'SL/TP same candle · conservative SL');
        return true;
      }
      if (slHit) {
        closeTrade(Number(c.time), open.sl, 'Stop Loss');
        return true;
      }
      if (tpHit) {
        closeTrade(Number(c.time), open.tp, 'Take Profit');
        return true;
      }

      const currentPrice = Number(c.close);
      const totalTpDistance = Math.abs(open.initialTp - open.entryPrice);
      const currentProfitDistance = favorableMove(open.side, open.entryPrice, currentPrice);
      const progress = totalTpDistance > 0 ? currentProfitDistance / totalTpDistance : 0;

      // 2. Break Even is independent from Trailing and AI Exit.
      if (breakEven && progress >= 0.5 && !open.beApplied) {
        open.sl = open.entryPrice;
        open.beApplied = true;
      }

      // 3. Trailing is also independent. Match the live engine's 60% lock after 50% TP.
      if (trailing && progress >= 0.5) {
        const lockedProfit = currentProfitDistance * 0.6;
        const newSl = open.side === 'BUY'
          ? open.entryPrice + lockedProfit
          : open.entryPrice - lockedProfit;
        if (open.side === 'BUY') open.sl = Math.max(open.sl, newSl);
        else open.sl = Math.min(open.sl, newSl);
        open.trailingApplied = true;
      }

      // Re-check the updated SL on the current candle close. This models a stop
      // that was moved before the close, without pretending we have tick data.
      const movedSlHit = open.side === 'BUY' ? low <= open.sl : high >= open.sl;
      if (movedSlHit) {
        closeTrade(Number(c.time), open.sl, open.trailingApplied ? 'Trailing Stop' : 'Break Even');
        return true;
      }

      // 4. AI Profit Exit is fully independent of BE/Trailing.
      if (aiProfitExit) {
        const ai = aiProfitExitDecision(candles, i, open.side, open.entryPrice, currentPrice, open.initialTp, 7);
        if (ai.score > 0) {
          aiScoreTotal += ai.score;
          aiScoreSamples++;
        }
        if (ai.action === 'PROTECT') aiExitStat.protects++;
        else if (ai.action === 'HOLD') aiExitStat.holds++;
        if (ai.action === 'CLOSE') {
          aiExitStat.closes++;
          aiProfitTotal += Math.max(0, favorableMove(open.side, open.entryPrice, currentPrice) * open.lot * 100);
          closeTrade(Number(c.time), currentPrice, `AI Profit Exit · Score ${ai.score.toFixed(1)} · ${ai.reasons.slice(0, 2).join(', ') || 'adaptive reversal'}`);
          return true;
        }
      }
      return false;
    };

    for (let i = 0; i < candles.length; i++) {
      if (i > 0 && i % 1000 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
      const c = candles[i];

      // 1) Manage an already open position.
      if (open) managePosition(i, c);

      // 2) A pending BUY_LIMIT / SELL_LIMIT can be filled by later candles.
      // The pending order stays alive until a NEW strategy signal appears.
      if (!open && pendingLimit) {
        const filled = pendingLimit.side === 'BUY'
          ? Number(c.low) <= pendingLimit.price
          : Number(c.high) >= pendingLimit.price;

        if (filled) {
          const sltp = calculateSlTp(candles, i, pendingLimit.side, pendingLimit.price);
          if (sltp.sl != null && sltp.tp != null) {
            open = {
              id: tradeId++,
              side: pendingLimit.side,
              entryTime: Number(c.time),
              entryPrice: pendingLimit.price,
              lot: resolveLot(lossStreak),
              crossPrice: pendingLimit.crossPrice,
              sl: sltp.sl,
              tp: sltp.tp,
              initialTp: sltp.tp,
              beApplied: false,
              trailingApplied: false,
              entryType: pendingLimit.decision,
            };
            acceptedSignals++;
            limitEntries++;
            pendingLimit = null;
          }
        }
      }

      const cross = crossByIndex.get(i);
      if (!cross) continue;
      const side: 'BUY'|'SELL' = cross.type === 'BUY_CROSS' ? 'BUY' : 'SELL';
      const entry = Number(cross.price);

      // Evaluate the NEW strategy signal first. A pending LIMIT is NOT cancelled
      // merely because a cross appeared; it is cancelled/replaced only when the
      // new cross survives MA/Sideway/FOMO and becomes BUY, SELL, BUY_LIMIT or
      // SELL_LIMIT.

      // MA Cross + MA200 distance + MA Trend direction confirmation.
      if (maTrendEnabled && trend > 0) {
        const ma = Number(c.ma_trend);
        if (!Number.isFinite(ma)) {
          noTrade++;
          continue;
        }
        const distance = Math.abs(entry - ma);
        if (distance < 3) {
          noTrade++;
          continue;
        }
        const trendSignal: 'BUY'|'SELL' = Number(c.close) > ma ? 'BUY' : 'SELL';
        if (side !== trendSignal) {
          noTrade++;
          continue;
        }
      }

      if (useTradingSession) session.checks++;
      if (fridayLock) friday.checks++;

      if (!isWithinTradingSession(Number(c.time))) {
        recordBlockedSignal(session, i, side, entry);
        noTrade++;
        continue;
      }
      if (isFridayLocked(Number(c.time))) {
        recordBlockedSignal(friday, i, side, entry);
        noTrade++;
        continue;
      }

      // Sideway: exact current VPS rule. After a loss, use last loss cross ±3.
      // Outside the range + CandlePower >= 1.5 => PASS.
      // Outside the range + CandlePower < 1.5 => WAIT (do not block state).
      // Inside the range => BLOCK and wait for the next MA Cross.
      if (sidewayFilter && lossStreak >= 1 && lastLossCrossPrice !== null) {
        sideway.checks++;
        const lower = lastLossCrossPrice - 3;
        const upper = lastLossCrossPrice + 3;
        const cp = bodyPower(candles, i);
        const outsideRange = entry < lower || entry > upper;
        const strongCandle = cp >= 1.5;
        if (outsideRange && strongCandle) {
          // PASS
        } else if (outsideRange && !strongCandle) {
          sideway.waited = (sideway.waited || 0) + 1;
          noTrade++;
          continue;
        } else {
          recordBlockedSignal(sideway, i, side, entry);
          noTrade++;
          continue;
        }
      }

      let decision: 'MARKET' | 'BUY_LIMIT' | 'SELL_LIMIT' = 'MARKET';
      let finalEntry = entry;

      if (antiFomo) {
        fomo.checks++;
        const th1 = fomoTh1(candles, i);
        const th2 = fomoTh2(candles, i, entry, side);

        // Exact source flow: TH1 + TH2 => MARKET; otherwise TH3.
        if (th1 && th2) {
          decision = 'MARKET';
        } else {
          const th3 = fomoTh3(candles, i, side);
          if (!th3.pass || th3.limitPrice == null) {
            recordBlockedSignal(fomo, i, side, entry);
            noTrade++;
            continue;
          }
          decision = th3.decision as 'BUY_LIMIT' | 'SELL_LIMIT';
          finalEntry = Number(th3.limitPrice);
        }
      }

      // THIS is the replace/cancel rule:
      // only now, after a real NEW strategy signal has been accepted, remove
      // the previous pending LIMIT. The new signal can then be MARKET or a new
      // BUY_LIMIT/SELL_LIMIT which replaces it.
      if (pendingLimit) {
        pendingLimit = null;
      }

      // A valid opposite market/limit signal closes an existing position.
      if (open && open.side !== side) {
        closeTrade(Number(c.time), entry, 'Opposite MA Cross');
      }
      if (open) continue;

      if (decision === 'BUY_LIMIT' || decision === 'SELL_LIMIT') {
        pendingLimit = {
          side,
          price: finalEntry,
          crossPrice: entry,
          crossTime: Number(c.time),
          decision,
        };
        // The pending order is not counted until it actually fills.
        continue;
      }

      const sltp = calculateSlTp(candles, i, side, finalEntry);
      open = {
        id: tradeId++,
        side,
        entryTime: Number(c.time),
        entryPrice: finalEntry,
        lot: resolveLot(lossStreak),
        crossPrice: entry,
        sl: sltp.sl,
        tp: sltp.tp,
        initialTp: sltp.tp,
        beApplied: false,
        trailingApplied: false,
        entryType: 'MARKET',
      };
      acceptedSignals++;
      marketEntries++;
    }

    if (open) {
      const last = candles[candles.length - 1];
      closeTrade(Number(last.time), Number(last.close), 'End of Backtest');
    }

    const wins = result.filter(x => x.result === 'WIN').length;
    const losses = result.filter(x => x.result === 'LOSS').length;
    const total = result.length;
    const wr = total ? wins / total * 100 : 0;
    const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;

    // Session Advisor: analyze the actual completed trades by entry hour. No
    // alternate configurations are tested here.
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
    const sessionAdvisor = bestWindow?.trades
      ? {
          bestWindow: `${String(bestWindow.start).padStart(2,'0')}:00 - ${String((bestWindow.start + bestWindow.size) % 24).padStart(2,'0')}:00`,
          bestHour: `${String(bestHour).padStart(2,'0')}:00`,
          bestPnl: bestWindow.pnl,
          bestWinRate: bestWindow.trades ? bestWindow.wins / bestWindow.trades * 100 : 0,
          trades: bestWindow.trades,
          recommendation: bestWindow.pnl > 0
            ? `Nếu muốn thử tối ưu session thủ công, nên ưu tiên kiểm tra ${String(bestWindow.start).padStart(2,'0')}:00 - ${String((bestWindow.start + bestWindow.size) % 24).padStart(2,'0')}:00 vì đây là cửa sổ có P/L lịch sử tốt nhất trong chính lần backtest này.`
            : 'Chưa có cửa sổ giờ dương rõ ràng; không nên thay đổi session chỉ dựa trên mẫu dữ liệu này.'
        }
      : emptySessionAdvisor();

    const advice: string[] = [];
    if (total === 0) advice.push('Không có lệnh hoàn tất. Hãy kiểm tra MA Cross, Session, Sideway và Anti FOMO trong chính cấu hình hiện tại.');
    else {
      if (wr < 45) advice.push(`Win Rate hiện tại ${wr.toFixed(1)}%. Nên thử thay đổi từng thông số một, bắt đầu từ filter có tác động lớn nhất thay vì đổi nhiều cấu hình cùng lúc.`);
      if (pf > 0 && pf < 1) advice.push(`Profit Factor ${pf.toFixed(2)} đang dưới 1. Cấu hình hiện tại chưa có lợi thế rõ ràng trên mẫu dữ liệu này.`);
      if (pf >= 1.3 && wr >= 50) advice.push(`Cấu hình hiện tại có tín hiệu tích cực: Win Rate ${wr.toFixed(1)}%, Profit Factor ${pf.toFixed(2)}. Nên giữ nguyên làm baseline và chỉ thử thay đổi từng tham số.`);
      if (maxDrawdown > Math.abs(balance - initialBalance || 1) * 0.8) advice.push(`Drawdown $${maxDrawdown.toFixed(2)} khá lớn so với P/L cuối kỳ. Nên ưu tiên kiểm tra BE/Trailing/AI Exit trước khi thay đổi MA.`);
      if (sideway.blocked) advice.push(`Sideway đã BLOCK ${sideway.blocked}/${sideway.checks} case (${(sideway.blocked / sideway.checks * 100).toFixed(1)}%). Counterfactual: đúng ${sideway.correct}, sai ${sideway.wrong}, chưa kết luận ${sideway.unknown}.`);
      if (sideway.checks && sideway.blocked === 0) advice.push('Sideway có kiểm tra nhưng chưa BLOCK tín hiệu nào trong mẫu này; chưa có cơ sở để thay đổi filter.');
      if (fomo.blocked) advice.push(`Anti FOMO đã loại ${fomo.blocked}/${fomo.checks} case (${(fomo.blocked / fomo.checks * 100).toFixed(1)}%). Counterfactual: đúng ${fomo.correct}, sai ${fomo.wrong}, chưa kết luận ${fomo.unknown}.`);
      if (aiProfitExit) {
        if (aiExitStat.closes) advice.push(`AI Profit Exit đã CLOSE ${aiExitStat.closes} lệnh chủ động; hãy xem Trade History để đánh giá các EXIT này trước khi quyết định tắt/bật.`);
        else advice.push('AI Profit Exit đang ON nhưng chưa có CLOSE chủ động đủ rõ trong mẫu; chưa nên kết luận AI Exit có lợi hay hại.');
      }
      if (breakEven) advice.push('Break Even đang ON. Nên kiểm tra các lệnh BE trong Trade History trước khi thử OFF; không tự động thay đổi cấu hình.');
      if (trailing) advice.push('Trailing đang ON và độc lập với AI Exit. Nếu nhiều lệnh bị đóng sớm, có thể thử OFF riêng Trailing ở một lần backtest tiếp theo.');
      advice.push(sessionAdvisor.recommendation);
    }

    aiExitStat.averageScore = aiScoreSamples ? aiScoreTotal / aiScoreSamples : 0;
    aiExitStat.averageProfit = aiExitStat.closes ? aiProfitTotal / aiExitStat.closes : 0;

    const currentConfigText = configLabel(runCfg);

    const finalStats: BacktestStats = {
      sideway, fomo, session, friday, totalSignals: crosses.length, acceptedSignals,
      marketEntries, limitEntries, noTrade, advice, sessionAdvisor, aiExit: aiExitStat,
    };
    const nextRecommendations = makeRecommendations(runCfg, finalStats, result, balance - initialBalance, maxDrawdown);
    setBacktestStats(finalStats);
    setRecommendations(nextRecommendations);
    setRunHistory(prev => [...prev, { run: prev.length + 1, config: runCfg, pnl: balance - initialBalance, winRate: wr, profitFactor: pf, drawdown: maxDrawdown, trades: result.length }].slice(-20));
    setTrades(result);
    setBotBalance(Number(balance.toFixed(2)));
    setBotRunning(false);
    setVisible(candles.length);
    setData((d:any) => ({ ...d, candles, crosses, lastBacktestConfig: currentConfigText }));
  }

  async function start() {
    setError('');
    setPlaying(false);
    setBotRunning(true);
    setTrades([]);
    setBotBalance(initialBalance);

    if (useLotChain && lotChain.length === 0) {
      setError('Chuỗi lot không hợp lệ.');
      return;
    }

    try {
      const d = await api('/api/replay/prepare', {
        method: 'POST',
        body: JSON.stringify({
          symbol: 'XAUUSD',
          timeframe: 'M1',
          from_time: new Date(from).toISOString(),
          to_time: new Date(to).toISOString(),
          ma_fast: fast,
          ma_slow: slow,
          ema_trend: trend,
          ma_trend: maTrendEnabled,
          sideway_filter: sidewayFilter,
          anti_fomo: antiFomo,
          be: breakEven,
          trailing,
          ai_profit_exit: aiProfitExit,
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

      setData(d);
      setVisible(Math.min(Math.max(fast, slow, trend) + 5, d.candles.length));
    } catch (e: any) {
      setError(e?.message || 'Không thể khởi động replay');
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

          <label>
            Market
            <select defaultValue="XAUUSD">
              <option>XAUUSD</option>
            </select>
          </label>

          <label>
            Timeframe
            <select defaultValue="M1">
              <option>M1</option>
            </select>
          </label>

          <div className="two">
            <label>
              MA Fast
              <input type="number" value={fast} onChange={(e) => setFast(+e.target.value)} />
            </label>
            <label>
              MA Slow
              <input type="number" value={slow} onChange={(e) => setSlow(+e.target.value)} />
            </label>
          </div>

          <label>
            EMA Trend
            <input type="number" value={trend} onChange={(e) => setTrend(+e.target.value)} />
          </label>

          <label className="switch-row compact-switch">
            <input type="checkbox" checked={maTrendEnabled} onChange={(e) => setMaTrendEnabled(e.target.checked)} />
            <span className="switch" />
            <span className="switch-content">
              <strong>MA Trend Filter</strong>
              <small>Yêu cầu Cross cách MA Trend tối thiểu ±3 giá</small>
            </span>
          </label>

          <div className="section-title space">FILTERS</div>

          <div className="strategy-option">
            <label className="switch-row">
              <input type="checkbox" checked={sidewayFilter} onChange={(e) => setSidewayFilter(e.target.checked)} />
              <span className="switch" />
              <span className="switch-content">
                <strong>Sideway Filter</strong>
                <small>AI lọc thị trường đi ngang</small>
              </span>
            </label>

            <label className="switch-row">
              <input type="checkbox" checked={antiFomo} onChange={(e) => setAntiFomo(e.target.checked)} />
              <span className="switch" />
              <span className="switch-content">
                <strong>Anti FOMO</strong>
                <small>AI chống đánh đuổi giá</small>
              </span>
            </label>
          </div>

          <div className="section-title space">POSITION MANAGEMENT</div>

          <div className="strategy-option">
            <label className="switch-row">
              <input type="checkbox" checked={breakEven} onChange={(e) => setBreakEven(e.target.checked)} />
              <span className="switch" />
              <span className="switch-content">
                <strong>Break Even</strong>
                <small>Tự dời SL về Entry</small>
              </span>
            </label>

            <label className="switch-row">
              <input type="checkbox" checked={trailing} onChange={(e) => setTrailing(e.target.checked)} />
              <span className="switch" />
              <span className="switch-content">
                <strong>Trailing Stop</strong>
                <small>Khóa lợi nhuận</small>
              </span>
            </label>

            <label className="switch-row ai-profit-exit-row">
              <input type="checkbox" checked={aiProfitExit} onChange={(e) => setAiProfitExit(e.target.checked)} />
              <span className="switch" />
              <span className="switch-content">
                <strong>AI Profit Exit</strong>
                <small>AI tự phân tích và chủ động chốt lời khi xác suất đảo chiều tăng</small>
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
            <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>

          <label>
            To
            <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>

          <button className="primary wide" onClick={start}>START REPLAY</button>

          <button className="bot-button wide" onClick={() => { void runBot(); }} disabled={!data}>
            {botRunning ? 'RUN BOT AGAIN' : '▶ RUN BOT'}
          </button>

          {error && <div className="error">{error}</div>}

          <div className="legend">
            <span><i className="dot orange" />MA Fast</span>
            <span><i className="dot purple" />MA Slow</span>
            <span><i className="dot cyan" />EMA Trend</span>
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
                <strong>XAUUSD · M1</strong>
                <span>{candle ? fmt(candle.time) : 'Ready for replay'}</span>
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
              <MarketChart candles={data.candles} visibleCount={visible} crosses={data.crosses} />
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
              <div className="market-row"><span>EMA {trend}</span><b>{candle?.ema_trend?.toFixed(2) || '—'}</b></div>
              <div className="market-row"><span>MA Trend Filter</span><b className={maTrendEnabled ? 'up' : ''}>{maTrendEnabled ? 'ON' : 'OFF'}</b></div>
              <div className="market-row"><span>Sideway</span><b className={sidewayFilter ? 'up' : ''}>{sidewayFilter ? 'ON' : 'OFF'}</b></div>
              <div className="market-row"><span>Anti FOMO</span><b className={antiFomo ? 'up' : ''}>{antiFomo ? 'ON' : 'OFF'}</b></div>
              <div className="market-row"><span>AI Profit Exit</span><b className={aiProfitExit ? 'up' : ''}>{aiProfitExit ? 'ON' : 'OFF'}</b></div>
            </div>

            <div className="panel">
              <div className="panel-title">CROSS EVENTS</div>
              {data?.crosses?.slice(-6).reverse().map((x: any) => (
                <div className="event" key={x.index}>
                  <span className={x.type === 'BUY_CROSS' ? 'buy' : 'sell'}>{x.type === 'BUY_CROSS' ? 'BUY' : 'SELL'}</span>
                  <span>{fmt(x.time)}</span>
                  <b>{Number(x.price).toFixed(2)}</b>
                  <small>{x.trend}</small>
                </div>
              )) || <div className="muted">No replay loaded.</div>}
            </div>
          </div>

          <div className="panel effectiveness-panel">
            <div className="panel-title">FILTER EFFECTIVENESS & CONFIG ADVISOR</div>
            <div className="effect-grid">
              {[['SIDEWAY',backtestStats.sideway],['ANTI FOMO',backtestStats.fomo],['SESSION',backtestStats.session],['FRIDAY LOCK',backtestStats.friday]].map(([name,st]:any)=>{
                const blockRate = st.checks > 0 ? (st.blocked / st.checks) * 100 : null;
                const precision = st.blocked > 0 ? (st.correct / st.blocked) * 100 : null;
                return (
                  <div className="effect-card" key={name}>
                    <strong>{name}</strong>
                    <span>{st.checks > 0 ? `Chặn ${st.blocked}/${st.checks}` : 'Không có dữ liệu'}</span>
                    <b>{blockRate === null ? '—' : `${blockRate.toFixed(1)}%`}</b>
                    <small>Đúng {st.correct} · Sai {st.wrong} · Chưa rõ {st.unknown}</small>
                    {precision !== null && <small>Hiệu quả chặn: {precision.toFixed(1)}%</small>}
                    {name === 'SIDEWAY' && !!st.waited && <small>WAIT CandlePower: {st.waited}</small>}
                  </div>
                );
              })}
            </div>
            <div className="advisor-row"><div><span>TÍN HIỆU</span><b>{backtestStats.totalSignals}</b></div><div><span>ĐƯỢC VÀO</span><b>{backtestStats.acceptedSignals}</b></div><div><span>MARKET</span><b>{backtestStats.marketEntries}</b></div><div><span>LIMIT</span><b>{backtestStats.limitEntries}</b></div><div><span>NO TRADE</span><b>{backtestStats.noTrade}</b></div></div>
            <div className="ai-exit-summary">
              <div className="ai-exit-head"><span>AI PROFIT EXIT</span><b className={backtestStats.aiExit.enabled ? 'up' : ''}>{backtestStats.aiExit.enabled ? 'ACTIVE' : 'OFF'}</b></div>
              <div className="ai-exit-grid">
                <div><span>CHỐT CHỦ ĐỘNG</span><b>{backtestStats.aiExit.closes}</b></div>
                <div><span>PROTECT</span><b>{backtestStats.aiExit.protects}</b></div>
                <div><span>HOLD</span><b>{backtestStats.aiExit.holds}</b></div>
                <div><span>AVG SCORE</span><b>{backtestStats.aiExit.averageScore.toFixed(1)}</b></div>
                <div><span>AVG PROFIT / EXIT</span><b className={backtestStats.aiExit.averageProfit >= 0 ? 'up' : 'down'}>${backtestStats.aiExit.averageProfit.toFixed(2)}</b></div>
              </div>
              <small>AI không đóng chỉ vì profit vừa dương; engine kết hợp trend, momentum, candle, RSI, volatility và mức profit để quyết định HOLD / PROTECT / CLOSE.</small>
            </div>
            <div className="best-config">
              <span>CẤU HÌNH ĐÃ CHẠY</span>
              <b>{data?.lastBacktestConfig || 'Chưa chạy backtest'}</b>
            </div>

            <div className="recommendations-panel">
              <div className="recommended-head">
                <div>
                  <span>AI NEXT EXPERIMENTS</span>
                  <strong>Đề xuất cho lần chạy tiếp theo</strong>
                </div>
                {recommendations.length > 0 && <small>AI không tự chạy. Em chọn đề xuất nào thì cấu hình đó mới được áp dụng và RUN.</small>}
              </div>
              <div className="recommendation-list">
                {recommendations.length ? recommendations.map((r, idx) => (
                  <div className="recommendation-card" key={r.id}>
                    <div className="recommendation-top">
                      <div><span>ĐỀ XUẤT #{idx + 1}</span><strong>{r.title}</strong></div>
                      <button className="recommendation-run" disabled={botRunning} onClick={() => {
                        setFast(r.config.fast); setSlow(r.config.slow); setTrend(r.config.trend); setMaTrendEnabled(r.config.maTrendEnabled);
                        setSidewayFilter(r.config.sidewayFilter); setAntiFomo(r.config.antiFomo); setBreakEven(r.config.breakEven); setTrailing(r.config.trailing);
                        setAiProfitExit(r.config.aiProfitExit); setFridayLock(r.config.fridayLock); setUseLotChain(r.config.useLotChain);
                        setBaseLot(r.config.baseLot); setUseTradingSession(r.config.useTradingSession); setSessionFrom(r.config.sessionFrom); setSessionTo(r.config.sessionTo);
                        setCustomLotChain(r.config.lotChain.join(', ')); setLotChainMode('custom');
                        void runBot(r.config);
                      }}>DÙNG CẤU HÌNH NÀY & RUN</button>
                    </div>
                    <div className="recommendation-config">{configLabel(r.config)}</div>
                    <div className="recommendation-reason"><b>Vì sao:</b> {r.reason}</div>
                    <div className="recommendation-reason"><b>Mục tiêu kiểm chứng:</b> {r.expected}</div>
                  </div>
                )) : <div className="muted">Sau mỗi RUN BOT, AI sẽ đưa ra tối đa 3 cấu hình đáng thử tiếp theo.</div>}
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
                      <td>{fmt(trade.entryTime)}</td>
                      <td>{trade.entryPrice.toFixed(2)}</td>
                      <td>{fmt(trade.exitTime)}</td>
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
        </section>
      </div>
    </main>
  );
}
