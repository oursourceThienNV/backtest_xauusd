"""
Kiểm tra MT5 có trả tick được không.
Chạy:  python check_ticks.py
Rồi gửi toàn bộ kết quả in ra.
"""

import os
import time
from datetime import datetime, timedelta, timezone

import MetaTrader5 as mt5

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
except Exception:
    pass


def show(title, fn):
    t0 = time.perf_counter()
    try:
        res = fn()
    except Exception as e:
        print(f"[{title}] EXCEPTION: {e}")
        return
    dt = time.perf_counter() - t0
    if res is None:
        print(f"[{title}] None | {dt:.1f}s | error={mt5.last_error()}")
    else:
        extra = ""
        if len(res):
            key = "time_msc" if "time_msc" in res.dtype.names else "time"
            a, b = int(res[0][key]), int(res[-1][key])
            if key == "time_msc":
                a, b = a // 1000, b // 1000
            extra = (f" | {datetime.fromtimestamp(a, tz=timezone.utc)}"
                     f" -> {datetime.fromtimestamp(b, tz=timezone.utc)}")
        print(f"[{title}] {len(res):,} rows | {dt:.1f}s{extra}")


path = os.getenv("MT5_PATH", "").strip()
ok = mt5.initialize(path=path) if path else mt5.initialize()
print("Python package MetaTrader5:", getattr(mt5, "__version__", "?"))
print("initialize:", ok, mt5.last_error())
print("terminal  :", mt5.version())

ti = mt5.terminal_info()
if ti:
    print(f"connected={ti.connected} maxbars={ti.maxbars} "
          f"data_path={ti.data_path}")

sym = None
for name in (os.getenv("MT5_SYMBOL", "XAUUSD"), "XAUUSDc", "XAUUSDm", "XAUUSD"):
    if mt5.symbol_info(name):
        sym = name
        break
if not sym:
    cands = [s.name for s in (mt5.symbols_get() or []) if s.name.upper().startswith("XAUUSD")]
    sym = sorted(cands, key=len)[0] if cands else None
print("symbol    :", sym)
mt5.symbol_select(sym, True)

now = datetime.now(timezone.utc)
y = (now - timedelta(days=1)).replace(hour=14, minute=0, second=0, microsecond=0)
old = datetime(2026, 9, 11, 1, 0, tzinfo=timezone.utc)
old_naive = datetime(2026, 9, 11, 1, 0)

print("\n--- 1. Tick gần đây")
show("ticks_from now-1h, 1000", lambda: mt5.copy_ticks_from(sym, now - timedelta(hours=1), 1000, mt5.COPY_TICKS_ALL))
show("ticks_range hôm qua 14-15h", lambda: mt5.copy_ticks_range(sym, y, y + timedelta(hours=1), mt5.COPY_TICKS_ALL))

print("\n--- 2. Tick ngày cũ 2026-09-11")
show("ticks_range 01-02h (UTC aware)", lambda: mt5.copy_ticks_range(sym, old, old + timedelta(hours=1), mt5.COPY_TICKS_ALL))
show("ticks_range 01-02h (naive)", lambda: mt5.copy_ticks_range(sym, old_naive, old_naive + timedelta(hours=1), mt5.COPY_TICKS_ALL))
show("ticks_from 01h, 20000", lambda: mt5.copy_ticks_from(sym, old, 20000, mt5.COPY_TICKS_ALL))

print("\n--- 3. Nến M1 ngày cũ")
show("rates M1 2026-09-11", lambda: mt5.copy_rates_range(sym, mt5.TIMEFRAME_M1, old, old + timedelta(days=1)))

print("\n--- 4. Tick cũ nhất MT5 có")
show("ticks_from 2026-01-01, 5", lambda: mt5.copy_ticks_from(sym, datetime(2026, 1, 1, tzinfo=timezone.utc), 5, mt5.COPY_TICKS_ALL))

mt5.shutdown()
