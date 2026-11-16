'use client';

import { useEffect, useRef } from 'react';
import { ColorType, LineSeries, createChart, type Time } from 'lightweight-charts';

export type EquityLine = { name: string; color: string; points: { time: number; value: number }[] };

function dedupe(points: { time: number; value: number }[]) {
  const out: { time: number; value: number }[] = [];
  for (const p of [...points].sort((a, b) => a.time - b.time)) {
    if (out.length && out[out.length - 1].time === p.time) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

export default function EquityChart({ lines, height = 240, offsetHours = 0 }: { lines: EquityLine[]; height?: number; offsetHours?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const pad = (n: number) => String(n).padStart(2, '0');
    const fmt = (time: Time) => {
      if (typeof time !== 'number') return '';
      const d = new Date((time + offsetHours * 3600) * 1000);
      return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    };

    const chart = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: '#0b1017' }, textColor: '#7f8999' },
      grid: { vertLines: { color: '#131922' }, horzLines: { color: '#131922' } },
      rightPriceScale: { borderColor: '#242a35' },
      timeScale: { borderColor: '#242a35', timeVisible: true, tickMarkFormatter: (t: Time) => fmt(t).slice(0, 5) },
      localization: { timeFormatter: fmt },
      width: el.clientWidth,
      height,
    });

    for (const l of lines) {
      const s = chart.addSeries(LineSeries, { color: l.color, lineWidth: 2, title: l.name, priceLineVisible: false });
      s.setData(dedupe(l.points).map((p) => ({ time: p.time as Time, value: p.value })));
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [lines, height, offsetHours]);

  return <div ref={ref} style={{ width: '100%', height }} />;
}
