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
}: {
  candles: Candle[];
  visibleCount: number;
  crosses: any[];
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || !candles.length) return;

    const el = ref.current;
    el.innerHTML = '';

    // Map the chart's numeric coordinate to the original DB candle_time.
    // All labels are rendered from candle_time, never from the browser timezone.
    const dbTimeByTimestamp = new Map<number, string>(
      candles.map((c) => [Number(c.time), String(c.candle_time ?? '')]),
    );
    const formatChartTime = (time: Time) => {
      if (typeof time === 'number') {
        return formatDbTime(dbTimeByTimestamp.get(Number(time)), true);
      }
      return '';
    };

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
        tickMarkFormatter: (time: Time) => {
          if (typeof time !== 'number') return '';
          return formatDbTime(dbTimeByTimestamp.get(Number(time)), false);
        },
      },
      localization: {
        timeFormatter: formatChartTime,
      },
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

    const shown = candles.slice(0, visibleCount);
    cs.setData(shown.map((c) => ({
      time: c.time as any,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    })));

    const ma1 = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 2 });
    const ma2 = chart.addSeries(LineSeries, { color: '#a78bfa', lineWidth: 2 });
    const ema = chart.addSeries(LineSeries, { color: '#38bdf8', lineWidth: 2 });

    ma1.setData(shown.filter((c) => c.ma_fast != null).map((c) => ({ time: c.time as any, value: c.ma_fast as number })));
    ma2.setData(shown.filter((c) => c.ma_slow != null).map((c) => ({ time: c.time as any, value: c.ma_slow as number })));
    ema.setData(shown.filter((c) => c.ema_trend != null).map((c) => ({ time: c.time as any, value: c.ema_trend as number })));

    const marks = crosses
      .filter((x) => x.index < visibleCount)
      .map((x) => ({
        time: x.time as any,
        position: x.type === 'BUY_CROSS' ? 'belowBar' : 'aboveBar',
        color: x.type === 'BUY_CROSS' ? '#22c55e' : '#ef4444',
        shape: x.type === 'BUY_CROSS' ? 'arrowUp' : 'arrowDown',
        text: x.type === 'BUY_CROSS' ? 'BUY' : 'SELL',
      } as any));

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
  }, [candles, visibleCount, crosses]);

  return <div ref={ref} className="chart" />;
}
