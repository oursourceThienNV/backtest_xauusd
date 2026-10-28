'use client';

import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  CandlestickSeries,
  LineSeries,
  createSeriesMarkers,
  type Time,
} from 'lightweight-charts';

type Candle = {
  time: number;
  candle_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  ma_fast?: number | null;
  ma_slow?: number | null;
  ema_trend?: number | null;
  bbMiddle?: number | null;
  bbUpper?: number | null;
  bbLower?: number | null;
};

type Signal = {
  index: number;
  time: number;
  price: number;
  type: 'BUY_CROSS' | 'SELL_CROSS';
  status?: 'ENTERED' | 'BLOCKED' | 'SKIPPED';
  reason?: string;
};

function formatDbTime(value?: string, includeDate = true) {
  if (!value) return '';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return String(value);
  const [, yyyy, mm, dd, hh, mi, ss = '00'] = match;
  return includeDate ? `${dd}/${mm}/${yyyy} ${hh}:${mi}:${ss}` : `${dd}/${mm} ${hh}:${mi}`;
}

export default function MarketChart({
  candles,
  visibleCount,
  crosses,
  strategyMode = 'ma',
}: {
  candles: Candle[];
  visibleCount: number;
  crosses: Signal[];
  strategyMode?: 'ma' | 'bollinger';
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || !candles.length) return;
    const el = ref.current;
    el.innerHTML = '';

    const dbTimeByTimestamp = new Map<number, string>(
      candles.map((c) => [Number(c.time), String(c.candle_time ?? '')]),
    );
    const formatChartTime = (time: Time) =>
      typeof time === 'number' ? formatDbTime(dbTimeByTimestamp.get(Number(time)), true) : '';

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: '#0a0d12' },
        textColor: '#7f8999',
      },
      grid: {
        vertLines: { color: '#151a23' },
        horzLines: { color: '#151a23' },
      },
      rightPriceScale: { borderColor: '#242a35' },
      timeScale: {
        borderColor: '#242a35',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time) =>
          typeof time === 'number'
            ? formatDbTime(dbTimeByTimestamp.get(Number(time)), false)
            : '',
      },
      localization: { timeFormatter: formatChartTime },
      crosshair: { mode: 1 },
      width: el.clientWidth,
      height: el.clientHeight,
    });

    const cs = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });

    const shown = candles.slice(0, Math.max(0, visibleCount));
    cs.setData(shown.map((c) => ({
      time: c.time as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    })));

    // Only draw the indicator family belonging to the selected strategy.
    if (strategyMode === 'ma') {
      const maFast = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 2, title: 'MA Fast' });
      const maSlow = chart.addSeries(LineSeries, { color: '#a78bfa', lineWidth: 2, title: 'MA Slow' });
      const emaTrend = chart.addSeries(LineSeries, { color: '#38bdf8', lineWidth: 2, title: 'EMA Trend' });
      maFast.setData(shown.filter(c => c.ma_fast != null).map(c => ({ time: c.time as Time, value: Number(c.ma_fast) })));
      maSlow.setData(shown.filter(c => c.ma_slow != null).map(c => ({ time: c.time as Time, value: Number(c.ma_slow) })));
      emaTrend.setData(shown.filter(c => c.ema_trend != null).map(c => ({ time: c.time as Time, value: Number(c.ema_trend) })));
    } else {
      const upper = chart.addSeries(LineSeries, { color: '#64748b', lineWidth: 1, title: 'BB Upper' });
      const middle = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 2, title: 'SMA20' });
      const lower = chart.addSeries(LineSeries, { color: '#64748b', lineWidth: 1, title: 'BB Lower' });
      upper.setData(shown.filter(c => c.bbUpper != null).map(c => ({ time: c.time as Time, value: Number(c.bbUpper) })));
      middle.setData(shown.filter(c => c.bbMiddle != null).map(c => ({ time: c.time as Time, value: Number(c.bbMiddle) })));
      lower.setData(shown.filter(c => c.bbLower != null).map(c => ({ time: c.time as Time, value: Number(c.bbLower) })));
    }

    const marks = crosses
      .filter((x) => x.index < visibleCount)
      .map((x) => {
        const buy = x.type === 'BUY_CROSS';
        return {
          time: x.time as Time,
          position: buy ? 'belowBar' : 'aboveBar',
          color: x.status === 'BLOCKED' ? '#f59e0b' : buy ? '#22c55e' : '#ef4444',
          shape: buy ? 'arrowUp' : 'arrowDown',
          // Keep the chart clean: status/reason details belong below Trade History.
          text: buy ? 'BUY' : 'SELL',
        } as any;
      });

    createSeriesMarkers(cs, marks);
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [candles, visibleCount, crosses, strategyMode]);

  return <div ref={ref} className="chart" />;
}
