'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  LineType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import type { Bar, SeriesDef } from '@/lib/types';
import { TIMEFRAMES } from '@/lib/types';

export type ChartLine = {
  id: string;
  price: number;
  color: string;
  title: string;
  style?: 'solid' | 'dashed' | 'dotted';
  width?: number;
};

export type ChartMarker = {
  time: number;
  position: 'aboveBar' | 'belowBar' | 'inBar';
  color: string;
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  text?: string;
};

export type ChartHandle = {
  reset: (closed: Bar[], forming: Bar | null) => void;
  updateBar: (bar: Bar) => void;
  setIndicators: (defs: SeriesDef[], chartTf: string, untilSec: number, minSec: number) => void;
  advanceIndicators: (untilSec: number) => void;
  setMarkers: (markers: ChartMarker[]) => void;
  setLines: (lines: ChartLine[]) => void;
  setTimeOffset: (hours: number) => void;
  setDigits: (digits: number) => void;
  scrollToEnd: () => void;
};

type IndicatorState = {
  def: SeriesDef;
  api: ISeriesApi<'Line'>;
  ptr: number;
  lag: number;            // giây: điểm chỉ hiện khi time + lag <= thời điểm replay
  levelLines: IPriceLine[];
};

const pad = (n: number) => String(n).padStart(2, '0');

const ReplayChart = forwardRef<ChartHandle, { height?: number }>(function ReplayChart(_props, ref) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const lines = useRef<Map<string, { line: IPriceLine; key: string }>>(new Map());
  const indicators = useRef<IndicatorState[]>([]);
  const offset = useRef(0);
  const minSec = useRef(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;

    const fmt = (time: Time, withDate: boolean) => {
      if (typeof time !== 'number') return '';
      const d = new Date((time + offset.current * 3600) * 1000);
      const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      return withDate ? `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${hm}` : hm;
    };

    const c = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: '#0a0d12' },
        textColor: '#7f8999',
        panes: { separatorColor: '#1c2430', separatorHoverColor: '#2a3547' },
      },
      grid: { vertLines: { color: '#131922' }, horzLines: { color: '#131922' } },
      rightPriceScale: { borderColor: '#242a35' },
      timeScale: {
        borderColor: '#242a35',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        barSpacing: 8,
        shiftVisibleRangeOnNewBar: true,
        tickMarkFormatter: (time: Time) => fmt(time, false),
      },
      localization: { timeFormatter: (time: Time) => fmt(time, true) },
      crosshair: { mode: CrosshairMode.Normal },
      width: el.clientWidth,
      height: el.clientHeight,
    });

    const cs = c.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
      priceLineVisible: false,
      priceFormat: { type: 'price', precision: 3, minMove: 0.001 },
    });

    chart.current = c;
    candles.current = cs;
    markers.current = createSeriesMarkers(cs, []);

    const ro = new ResizeObserver(() => c.applyOptions({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);

    return () => {
      ro.disconnect();
      c.remove();
      chart.current = null;
      candles.current = null;
      markers.current = null;
      lines.current.clear();
      indicators.current = [];
    };
  }, []);

  useImperativeHandle(ref, () => ({
    reset(closed, forming) {
      const cs = candles.current;
      if (!cs) return;
      const data = forming ? [...closed, forming] : closed;
      cs.setData(data.map((b) => ({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close })));
    },

    updateBar(bar) {
      candles.current?.update({ time: bar.time as Time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    },

    setIndicators(defs, chartTf, untilSec, min) {
      const c = chart.current;
      if (!c) return;

      for (const s of indicators.current) {
        try {
          c.removeSeries(s.api);
        } catch {
          /* đã xóa */
        }
      }
      indicators.current = [];
      minSec.current = min;

      // Bỏ các khung phụ (RSI / ADX) cũ
      for (let k = c.panes().length - 1; k >= 1; k--) {
        try {
          c.removePane(k);
        } catch {
          /* bỏ qua */
        }
      }

      const shown = defs.filter((d) => d.tf === 'ANY' || d.tf === chartTf);

      for (const def of shown) {
        const api = c.addSeries(
          LineSeries,
          {
            color: def.color,
            lineWidth: def.pane === 0 ? 1 : 2,
            lineType: def.step ? LineType.WithSteps : LineType.Simple,
            priceLineVisible: false,
            lastValueVisible: def.pane !== 0,
            crosshairMarkerVisible: false,
            title: def.pane === 0 ? '' : def.name,
          },
          def.pane,
        );

        const levelLines = (def.levels || []).map((price) =>
          api.createPriceLine({ price, color: '#475569', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: '' }),
        );

        const lag = def.tf === 'ANY' ? 0 : TIMEFRAMES[def.tf] ?? 0;
        let lo = 0;
        while (lo < def.data.length && def.data[lo].time < min) lo++;
        let ptr = lo;
        while (ptr < def.data.length && def.data[ptr].time + lag <= untilSec) ptr++;

        api.setData(def.data.slice(lo, ptr).map((p) => ({ time: p.time as Time, value: p.value })));
        indicators.current.push({ def, api, ptr, lag, levelLines });
      }

      const panes = c.panes();
      if (panes.length > 1) {
        panes[0].setStretchFactor(3);
        panes[1].setStretchFactor(1);
      }
    },

    advanceIndicators(untilSec) {
      for (const s of indicators.current) {
        const data = s.def.data;
        while (s.ptr < data.length && data[s.ptr].time + s.lag <= untilSec) {
          const p = data[s.ptr];
          if (p.time >= minSec.current) s.api.update({ time: p.time as Time, value: p.value });
          s.ptr++;
        }
      }
    },

    setMarkers(list) {
      markers.current?.setMarkers(
        [...list].sort((a, b) => a.time - b.time).map((m) => ({ ...m, time: m.time as Time })) as SeriesMarker<Time>[],
      );
    },

    setLines(list) {
      const cs = candles.current;
      if (!cs) return;

      const keep = new Set<string>();

      for (const l of list) {
        keep.add(l.id);
        const key = `${l.price}|${l.color}|${l.title}|${l.style}`;
        const existing = lines.current.get(l.id);
        if (existing && existing.key === key) continue;
        if (existing) cs.removePriceLine(existing.line);
        const line = cs.createPriceLine({
          price: l.price,
          color: l.color,
          lineWidth: (l.width ?? 1) as 1 | 2 | 3 | 4,
          lineStyle: l.style === 'dashed' ? LineStyle.Dashed : l.style === 'dotted' ? LineStyle.Dotted : LineStyle.Solid,
          axisLabelVisible: true,
          title: l.title,
        });
        lines.current.set(l.id, { line, key });
      }

      for (const [id, v] of lines.current) {
        if (!keep.has(id)) {
          cs.removePriceLine(v.line);
          lines.current.delete(id);
        }
      }
    },

    setTimeOffset(hours) {
      offset.current = hours;
      const fmt = (time: Time, withDate: boolean) => {
        if (typeof time !== 'number') return '';
        const d = new Date((time + offset.current * 3600) * 1000);
        const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
        return withDate ? `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${hm}` : hm;
      };
      // Gán lại formatter để chart vẽ lại trục thời gian theo múi giờ mới
      chart.current?.applyOptions({
        localization: { timeFormatter: (t: Time) => fmt(t, true) },
        timeScale: { tickMarkFormatter: (t: Time) => fmt(t, false) },
      });
    },

    setDigits(digits) {
      const minMove = Number((1 / 10 ** digits).toFixed(digits));
      candles.current?.applyOptions({ priceFormat: { type: 'price', precision: digits, minMove } });
    },

    scrollToEnd() {
      chart.current?.timeScale().scrollToRealTime();
    },
  }));

  return <div ref={box} className="chart" />;
});

export default ReplayChart;
