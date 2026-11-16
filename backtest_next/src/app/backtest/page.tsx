'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import EventLog from '@/components/EventLog';
import ReplayChart, { type ChartHandle } from '@/components/ReplayChart';
import ReportPanel from '@/components/ReportPanel';
import StrategyForm from '@/components/StrategyForm';
import TopNav from '@/components/TopNav';
import TradesTable from '@/components/TradesTable';
import { backtestService, marketService } from '@/services';
import { addDays, cls, dayToMs, fmtDateTimeFull, fmtMoney, fmtTime, storageGet, storageSet } from '@/lib/format';
import { Replayer, type ReplayState } from '@/lib/replay';
import type { BacktestResult, Bar, MarketInfo, StrategyKey, StrategyMeta, Trade } from '@/lib/types';
import { EXIT_LABEL, TIMEFRAMES } from '@/lib/types';

type Mode = StrategyKey | 'market';

const SPEEDS = [1, 2, 5, 10, 30, 60, 120, 300, 900, 1800, 3600];
const RANGES = [
  { label: '1 ngày', days: 1 },
  { label: '3 ngày', days: 3 },
  { label: '1 tuần', days: 7 },
  { label: '2 tuần', days: 14 },
  { label: '1 tháng', days: 31 },
  { label: '2 tháng', days: 62 },
];

const speedLabel = (s: number) => (s >= 3600 ? `${s / 3600}h/s` : s >= 60 ? `${s / 60}p/s` : `x${s}`);

export default function BacktestPage() {
  const chart = useRef<ChartHandle>(null);
  const replayer = useRef<Replayer | null>(null);

  const [metas, setMetas] = useState<StrategyMeta[]>([]);
  const [info, setInfo] = useState<MarketInfo | null>(null);
  const [mode, setMode] = useState<Mode>('ma_cross');
  const [configs, setConfigs] = useState<Record<string, Record<string, any>>>({});
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [tf, setTf] = useState('M1');
  const [vnTime, setVnTime] = useState(false);

  const [result, setResult] = useState<BacktestResult | null>(null);
  const [replayRange, setReplayRange] = useState<{ from: string; to: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [loadingChart, setLoadingChart] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'trades' | 'report' | 'orders' | 'method'>('trades');
  const [rs, setRs] = useState<ReplayState | null>(null);
  const [speed, setSpeed] = useState(60);

  const offsetHours = vnTime ? info?.session_tz_offset_hours ?? 7 : 0;
  const digits = info?.digits ?? 3;
  const meta = metas.find((m) => m.key === mode) || null;
  const values = meta ? configs[meta.key] || meta.defaults : {};

  // ----------------------------------------------------------
  // KHỞI TẠO
  // ----------------------------------------------------------

  useEffect(() => {

    setVnTime(storageGet('ui:vnTime', false));
    setSpeed(storageGet('ui:speed', 60));
    setTf(storageGet('ui:tf', 'M1'));
    setMode(storageGet<Mode>('ui:mode', 'ma_cross'));

    (async () => {
      try {
        const [s, m] = await Promise.all([
          backtestService.strategies(),
          marketService.info(),
        ]);
        setMetas(s.strategies);
        setInfo(m);

        const cfgs: Record<string, Record<string, any>> = {};
        for (const st of s.strategies) cfgs[st.key] = { ...st.defaults, ...storageGet(`cfg:${st.key}`, {}) };
        setConfigs(cfgs);

        const last = m.last_day || new Date().toISOString().slice(0, 10);
        setToDay(storageGet('ui:to', last));
        setFromDay(storageGet('ui:from', addDays(last, -6)));

        const runId = new URLSearchParams(window.location.search).get('run');
        if (runId) await openRun(Number(runId));
      } catch (e: any) {
        setError(e.message);
      }
    })();

    return () => replayer.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => storageSet('ui:vnTime', vnTime), [vnTime]);
  useEffect(() => storageSet('ui:tf', tf), [tf]);
  useEffect(() => storageSet('ui:mode', mode), [mode]);
  useEffect(() => {
    if (fromDay) storageSet('ui:from', fromDay);
    if (toDay) storageSet('ui:to', toDay);
  }, [fromDay, toDay]);

  useEffect(() => {
    chart.current?.setTimeOffset(offsetHours);
  }, [offsetHours]);

  useEffect(() => {
    chart.current?.setDigits(digits);
  }, [digits]);

  // ----------------------------------------------------------
  // REPLAY
  // ----------------------------------------------------------

  const startReplay = useCallback(
    async (range: { from: string; to: string }, timeframe: string, res: BacktestResult | null, atMs?: number) => {
      if (!chart.current) return;
      setLoadingChart(true);
      setError('');

      try {
        const c = await marketService.candles({ from_day: range.from, to_day: range.to, tf: timeframe });

        replayer.current?.destroy();

        const startMs = dayToMs(range.from);
        const endMs = dayToMs(addDays(range.to, 1));

        const r = new Replayer(chart.current, {
          symbol: c.symbol,
          tfName: timeframe,
          tfSec: TIMEFRAMES[timeframe],
          candles: c.candles,
          startMs,
          endMs,
          contractSize: info?.contract_size ?? 100,
          digits,
          result: res,
          series: res?.series || [],
          onUpdate: setRs,
        });
        r.setSpeed(storageGet('ui:speed', 60));
        replayer.current = r;
        setReplayRange(range);

        let first = startMs;
        if (atMs !== undefined) first = atMs;
        else if (c.candles.length) first = c.candles[0].time * 1000 + 1;

        await r.seek(first);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoadingChart(false);
      }
    },
    [digits, info],
  );

  async function openRun(id: number) {
    setRunning(true);
    setError('');
    try {
      const r = await backtestService.detail(id);
      setResult(r);
      setMode(r.strategy);
      setFromDay(r.from_day);
      setToDay(r.to_day);
      setConfigs((prev) => ({ ...prev, [r.strategy]: { ...(prev[r.strategy] || {}), ...r.config } }));
      setTab('trades');
      await startReplay({ from: r.from_day, to: r.to_day }, storageGet('ui:tf', 'M1'), r);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  }

  async function run() {
    if (!fromDay || !toDay) return;
    setError('');

    if (mode === 'market') {
      setResult(null);
      await startReplay({ from: fromDay, to: toDay }, tf, null);
      return;
    }

    setRunning(true);
    try {
      storageSet(`cfg:${mode}`, values);
      const r = await backtestService.run({ strategy: mode, from_day: fromDay, to_day: toDay, config: values });
      setResult(r);
      setTab('trades');
      if (r.run_id) window.history.replaceState(null, '', `/backtest?run=${r.run_id}`);
      await startReplay({ from: fromDay, to: toDay }, tf, r);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  }

  function changeTf(next: string) {
    setTf(next);
    if (replayRange) startReplay(replayRange, next, result, rs?.simMs);
  }

  function jump(ms: number) {
    replayer.current?.seek(ms);
  }

  function jumpTrade(t: Trade) {
    const pre = TIMEFRAMES[tf] * 1000 * 15;
    jump(t.entry_ms - pre);
  }

  function setReplaySpeed(s: number) {
    setSpeed(s);
    storageSet('ui:speed', s);
    replayer.current?.setSpeed(s);
  }

  // Phím tắt: Space = chạy/dừng, → = nến kế tiếp
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        replayer.current?.toggle();
      } else if (e.code === 'ArrowRight') {
        replayer.current?.stepBar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ----------------------------------------------------------
  // HIỂN THỊ
  // ----------------------------------------------------------

  const summary = result?.summary;
  const color = meta?.color || '#3b82f6';
  const spread = rs?.bid !== null && rs?.bid !== undefined && rs?.ask !== null && rs?.ask !== undefined ? rs.ask - rs.bid : null;

  const visibleTrades = useMemo(() => result?.trades || [], [result]);
  const span = replayRange ? dayToMs(addDays(replayRange.to, 1)) - dayToMs(replayRange.from) : 0;

  const setValues = (v: Record<string, any>) => {
    if (!meta) return;
    setConfigs((prev) => ({ ...prev, [meta.key]: v }));
    storageSet(`cfg:${meta.key}`, v);
  };

  const quickRange = (days: number) => {
    const last = info?.last_day || toDay;
    if (!last) return;
    setToDay(last);
    setFromDay(addDays(last, -(days - 1)));
  };

  return (
    <main className="terminal">
      <TopNav
        right={
          <label className="tz-toggle" title="Giờ trên chart / bảng: giờ MT5 (server Exness = UTC) hoặc giờ Việt Nam">
            <input type="checkbox" checked={vnTime} onChange={(e) => setVnTime(e.target.checked)} />
            <span>{vnTime ? 'Giờ VN (+7)' : 'Giờ MT5'}</span>
          </label>
        }
      />

      <div className="workspace">
        {/* ================= SIDEBAR ================= */}
        <aside className="sidebar">
          <div className="section-title">PHƯƠNG PHÁP</div>
          <div className="method-menu">
            {metas.map((m) => (
              <button
                key={m.key}
                className={cls('method-card', mode === m.key && 'active')}
                style={{ ['--accent' as any]: m.color }}
                onClick={() => setMode(m.key)}
              >
                <b>{m.name}</b>
                <small>{m.timeframes}</small>
              </button>
            ))}
            <button
              className={cls('method-card', mode === 'market' && 'active')}
              style={{ ['--accent' as any]: '#64748b' }}
              onClick={() => setMode('market')}
            >
              <b>Chỉ xem thị trường</b>
              <small>Replay tick</small>
            </button>
          </div>

          <div className="section-title space">KHOẢNG DỮ LIỆU (GIỜ MT5)</div>
          <div className="two">
            <label>
              Từ ngày
              <input type="date" value={fromDay} min={info?.first_day || undefined} max={info?.last_day || undefined}
                onChange={(e) => setFromDay(e.target.value)} />
            </label>
            <label>
              Đến ngày
              <input type="date" value={toDay} min={info?.first_day || undefined} max={info?.last_day || undefined}
                onChange={(e) => setToDay(e.target.value)} />
            </label>
          </div>
          <div className="range-chips">
            {RANGES.map((r) => (
              <button key={r.days} className="lot-preset" onClick={() => quickRange(r.days)}>{r.label}</button>
            ))}
          </div>
          {info && (
            <div className="data-note">
              Dữ liệu tick {info.symbol}: {info.first_day} → {info.last_day}
            </div>
          )}

          {meta && (
            <>
              <div className="method-summary" style={{ borderColor: meta.color }}>
                <b style={{ color: meta.color }}>{meta.name}</b>
                <p>{meta.summary}</p>
                <button className="link-btn" onClick={() => setTab('method')}>Xem sơ đồ chi tiết →</button>
              </div>
              <StrategyForm meta={meta} values={values} onChange={setValues} />
              <button className="ghost wide-ghost" onClick={() => setValues({ ...meta.defaults })}>Khôi phục mặc định</button>
            </>
          )}

          <button className="bot-button wide" disabled={running || loadingChart || !fromDay || !toDay} onClick={run}>
            {running ? 'ĐANG CHẠY…' : mode === 'market' ? '▶ XEM THỊ TRƯỜNG' : '▶ CHẠY BACKTEST'}
          </button>
          {error && <div className="error">{error}</div>}
        </aside>

        {/* ================= MAIN ================= */}
        <section className="main">
          <div className="stats">
            <div>
              <span>LỆNH</span>
              <b>{summary ? `${rs?.closedTrades ?? 0} / ${summary.trades}` : '—'}</b>
            </div>
            <div>
              <span>TỶ LỆ THẮNG</span>
              <b>{summary ? `${summary.win_rate}%` : '—'}</b>
            </div>
            <div>
              <span>LÃI / LỖ RÒNG</span>
              <b className={summary ? (summary.net_profit >= 0 ? 'up' : 'down') : ''}>{summary ? fmtMoney(summary.net_profit) : '—'}</b>
            </div>
            <div>
              <span>PROFIT FACTOR</span>
              <b>{summary?.profit_factor ?? '—'}</b>
            </div>
            <div>
              <span>SỤT GIẢM TỐI ĐA</span>
              <b className="down">{summary ? `${fmtMoney(summary.max_drawdown, false)} (${summary.max_drawdown_pct}%)` : '—'}</b>
            </div>
            <div>
              <span>SỐ DƯ TẠI THỜI ĐIỂM REPLAY</span>
              <b className={rs && summary ? (rs.balance + rs.floating >= summary.initial_balance ? 'up' : 'down') : ''}>
                {rs && summary ? fmtMoney(rs.balance + rs.floating, false) : '—'}
              </b>
            </div>
          </div>

          <div className="chart-card">
            <div className="chart-head">
              <div className="chart-title">
                <strong>{info?.symbol || 'XAUUSD'}</strong>
                <div className="tf-tabs">
                  {Object.keys(TIMEFRAMES).map((k) => (
                    <button key={k} className={cls(tf === k && 'active')} onClick={() => changeTf(k)} disabled={loadingChart}>
                      {k}
                    </button>
                  ))}
                </div>
                {result && <span className="run-tag" style={{ color }}>{result.strategy_name}{result.run_id ? ` #${result.run_id}` : ''}</span>}
              </div>

              <div className="controls">
                <button title="Về đầu" disabled={!replayRange} onClick={() => replayRange && jump(dayToMs(replayRange.from))}>⏮</button>
                <button title="Lệnh trước" disabled={!result} onClick={() => {
                  const t = replayer.current?.nextTradeTime(-1);
                  if (t) jump(t - TIMEFRAMES[tf] * 1000 * 15);
                }}>◀ Lệnh</button>
                <button className="play" disabled={!replayRange || loadingChart} onClick={() => replayer.current?.toggle()}>
                  {rs?.playing ? '⏸ Dừng' : '▶ Chạy'}
                </button>
                <button title="Nến kế tiếp (→)" disabled={!replayRange} onClick={() => replayer.current?.stepBar()}>Nến ⏭</button>
                <button title="Lệnh kế tiếp" disabled={!result} onClick={() => {
                  const t = replayer.current?.nextTradeTime(1);
                  if (t) jump(t - TIMEFRAMES[tf] * 1000 * 15);
                }}>Lệnh ▶</button>
                <select value={speed} onChange={(e) => setReplaySpeed(Number(e.target.value))} title="Tốc độ (thời gian thị trường / 1 giây thật)">
                  {SPEEDS.map((s) => (
                    <option key={s} value={s}>{speedLabel(s)}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="chart-body">
              <ReplayChart ref={chart} />
              {!replayRange && !loadingChart && (
                <div className="chart-empty">
                  <div className="empty-icon">◫</div>
                  <h2>Chọn phương pháp và khoảng ngày</h2>
                  <p>Bấm “Chạy backtest” để mô phỏng bot trên tick thật, rồi phát lại thị trường như đang diễn ra: nến hình thành từng tick, lệnh – SL – TP – log hiện đúng lúc.</p>
                </div>
              )}
              {(loadingChart || running) && <div className="chart-loading">{running ? 'Đang chạy backtest trên tick…' : 'Đang nạp dữ liệu…'}</div>}

              {rs && (
                <div className="hud">
                  <div className="hud-time">{fmtDateTimeFull(rs.simMs, offsetHours)}</div>
                  <div className="hud-prices">
                    <span className="sell">Bid {rs.bid?.toFixed(digits) ?? '—'}</span>
                    <span>Ask {rs.ask?.toFixed(digits) ?? '—'}</span>
                    <span className="muted">Spread {spread !== null ? (spread * 10).toFixed(1) + ' pip' : '—'}</span>
                  </div>
                  {rs.openTrade && (
                    <div className="hud-trade">
                      <b className={rs.openTrade.side === 'BUY' ? 'buy' : 'sell'}>#{rs.openTrade.id} {rs.openTrade.side} {rs.openTrade.lot}</b>
                      <span> @ {rs.openTrade.entry.toFixed(digits)} • SL {rs.openSl?.toFixed(digits)} • TP {rs.openTrade.tp.toFixed(digits)}</span>
                      <b className={rs.floating >= 0 ? 'up' : 'down'}> {fmtMoney(rs.floating)}</b>
                    </div>
                  )}
                  {rs.pending && (
                    <div className="hud-trade">
                      <b className="warn">{rs.pending.type.replace('_', ' ')}</b>
                      <span> @ {rs.pending.price.toFixed(digits)} • SL {rs.pending.sl.toFixed(digits)} • TP {rs.pending.tp.toFixed(digits)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="progress-row">
              <input
                type="range"
                min={0}
                max={1000}
                value={Math.round((rs?.progress ?? 0) * 1000)}
                disabled={!replayRange}
                onChange={(e) => {
                  if (!replayRange) return;
                  const p = Number(e.target.value) / 1000;
                  jump(dayToMs(replayRange.from) + p * span);
                }}
              />
              <input
                type="datetime-local"
                className="jump-input"
                title="Nhảy tới thời điểm"
                disabled={!replayRange}
                onChange={(e) => {
                  if (!e.target.value) return;
                  const ms = Date.parse(e.target.value + ':00Z') - offsetHours * 3600_000;
                  if (Number.isFinite(ms)) jump(ms);
                }}
              />
            </div>
          </div>

          {result && (
            <div className="bottom-grid">
              <EventLog events={result.events} upto={rs?.eventIndex ?? 0} offsetHours={offsetHours} onJump={(ms) => jump(ms)} />
              <div className="panel">
                <div className="panel-title">TRẠNG THÁI BOT TẠI THỜI ĐIỂM REPLAY</div>
                <div className="market-row"><span>Số dư</span><b>{rs ? fmtMoney(rs.balance, false) : '—'}</b></div>
                <div className="market-row"><span>Lãi/lỗ đang chạy</span><b className={rs && rs.floating >= 0 ? 'up' : 'down'}>{rs ? fmtMoney(rs.floating) : '—'}</b></div>
                <div className="market-row"><span>Lệnh đã đóng</span><b>{rs?.closedTrades ?? 0}</b></div>
                <div className="market-row"><span>Lệnh đang mở</span><b>{rs?.openTrade ? `#${rs.openTrade.id} ${rs.openTrade.side}` : 'Không'}</b></div>
                <div className="market-row"><span>Lệnh chờ</span><b>{rs?.pending ? `${rs.pending.type} @ ${rs.pending.price.toFixed(digits)}` : 'Không'}</b></div>
                {rs?.openTrade && (
                  <div className="reason-box">{rs.openTrade.reason}</div>
                )}
                <div className="hint">Phím tắt: <b>Space</b> chạy/dừng • <b>→</b> nến kế tiếp • bấm vào log / lệnh để nhảy tới thời điểm đó.</div>
              </div>
            </div>
          )}

          {(result || meta) && (
            <div className="panel trades-panel">
              <div className="report-tabs">
                {result && (
                  <>
                    <button className={cls(tab === 'trades' && 'active')} onClick={() => setTab('trades')}>Danh sách lệnh ({result.trades.length})</button>
                    <button className={cls(tab === 'report' && 'active')} onClick={() => setTab('report')}>Báo cáo kết quả</button>
                    {result.orders.length > 0 && (
                      <button className={cls(tab === 'orders' && 'active')} onClick={() => setTab('orders')}>Lệnh chờ ({result.orders.length})</button>
                    )}
                  </>
                )}
                {meta && <button className={cls(tab === 'method' && 'active')} onClick={() => setTab('method')}>Cách chơi: {meta.name}</button>}
                {result?.elapsed_sec !== undefined && (
                  <span className="run-meta">{(result.ticks || 0).toLocaleString()} tick • {result.elapsed_sec}s{result.events_truncated ? ' • log bị cắt bớt' : ''}</span>
                )}
              </div>

              {result && tab === 'trades' && (
                <TradesTable
                  trades={visibleTrades}
                  digits={digits}
                  offsetHours={offsetHours}
                  activeId={rs?.openTrade?.id}
                  visibleUntil={rs?.simMs}
                  onJump={jumpTrade}
                />
              )}

              {result && tab === 'report' && <ReportPanel s={result.summary} color={color} offsetHours={offsetHours} />}

              {result && tab === 'orders' && (
                <div className="trade-table-wrap">
                  <table className="trade-table">
                    <thead>
                      <tr><th>#</th><th>LOẠI</th><th>GIÁ ĐẶT</th><th>SL</th><th>TP</th><th>LOT</th><th>ĐẶT LÚC</th><th>KẾT THÚC</th><th>TRẠNG THÁI</th><th>GHI CHÚ</th></tr>
                    </thead>
                    <tbody>
                      {result.orders.map((o) => (
                        <tr key={o.id} className="clickable" onClick={() => jump(o.placed_ms - TIMEFRAMES[tf] * 1000 * 15)}>
                          <td>{o.id}</td>
                          <td className={o.side === 'BUY' ? 'buy' : 'sell'}>{o.type.replace('_', ' ')}</td>
                          <td>{o.price.toFixed(digits)}</td>
                          <td>{o.sl.toFixed(digits)}</td>
                          <td>{o.tp.toFixed(digits)}</td>
                          <td>{o.lot}</td>
                          <td>{fmtTime(o.placed_ms, offsetHours)}</td>
                          <td>{fmtTime(o.end_ms, offsetHours)}</td>
                          <td><span className={cls('result', o.status === 'FILLED' ? 'win' : 'be')}>{o.status === 'FILLED' ? 'Đã khớp' : 'Đã hủy'}</span></td>
                          <td>{o.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {meta && tab === 'method' && (
                <div className="method-detail">
                  <h3 style={{ color: meta.color }}>{meta.name} <small>{meta.timeframes}</small></h3>
                  <p className="muted">{meta.summary}</p>
                  <ol>
                    {meta.steps.map((s, k) => <li key={k}>{s}</li>)}
                  </ol>
                  <div className="method-notes">
                    <div><b>Khớp lệnh trong backtest:</b> BUY mở theo Ask / đóng theo Bid, SELL mở theo Bid / đóng theo Ask; SL/TP xét trên từng tick thật, giá khớp là giá của tick chạm mức (có trượt giá khi giá nhảy).</div>
                    <div><b>Thời điểm quyết định:</b> bot chỉ dùng nến đã đóng — quyết định ở tick đầu tiên của nến kế tiếp, giống bot live chạy vòng lặp 0.5 giây.</div>
                    <div><b>Kết thúc lệnh:</b> {Object.entries(EXIT_LABEL).map(([k, v]) => `${k} = ${v}`).join(' • ')}</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
