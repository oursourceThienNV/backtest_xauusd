"""
Phát lại thị trường từ bảng xauusd_ticks theo đúng nhịp thời gian thật.

Ví dụ:
    # Phát lại 1 phút lúc 14:30 giờ MT5 (= 21:30 giờ VN) ngày 2026-11-02, tốc độ thật
    python replay.py --start "2026-11-02 14:30:00" --minutes 1

    # Nhanh gấp 10 lần
    python replay.py --start "2026-11-02 14:30:00" --minutes 5 --speed 10

    # Không chờ, in toàn bộ tick ngay
    python replay.py --start "2026-11-02 14:30:00" --speed 0

    # Xuất ra CSV để dùng ở chỗ khác
    python replay.py --start "2026-11-02 14:30:00" --minutes 60 --csv out.csv

Giờ nhập vào là giờ MT5 (server Exness = UTC), giống thời gian lưu trong DB.
Giờ Việt Nam = giờ MT5 + 7 tiếng.

Có thể dùng hàm iter_ticks() trong code backtest của bạn: nó trả về
từng tick theo thứ tự thời gian, đúng như thị trường đã diễn ra.
"""

import argparse
import csv
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import mysql.connector
from dotenv import load_dotenv


def _load_env():
    """
    Đọc .env nằm cạnh file .py (không phụ thuộc thư mục đang đứng).
    Nếu Notepad lỡ lưu thành .env.txt thì vẫn đọc được.
    """
    here = os.path.dirname(os.path.abspath(__file__))

    for name in (".env", ".env.txt", "env.txt"):
        path = os.path.join(here, name)
        if os.path.isfile(path):
            load_dotenv(path, override=True)
            return path

    return None


ENV_FILE = _load_env()

DB_CONFIG = {
    "host": os.getenv("DB_HOST"),
    "port": int(os.getenv("DB_PORT", "3306")),
    "database": os.getenv("DB_NAME", "mt5_backtest"),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD"),
}


def resolve_symbol(conn, symbol):
    """XAUUSD -> XAUUSDc (symbol thực tế đã lưu trong DB)."""
    cur = conn.cursor()
    cur.execute(
        "SELECT DISTINCT symbol FROM xauusd_ticks WHERE symbol LIKE %s",
        (symbol + "%",),
    )
    names = sorted((r[0] for r in cur.fetchall()), key=len)
    cur.close()

    if not names:
        raise RuntimeError(f"Không có tick nào cho symbol {symbol} trong DB.")

    return names[0]


def iter_ticks(conn, symbol, start, end, page=50000):
    """
    Trả về từng tick (dict) trong [start, end) theo thứ tự thời gian.
    Đọc theo trang để không tốn RAM khi phát lại khoảng dài.
    """
    cur = conn.cursor(dictionary=True)

    last_key = (int(start.timestamp() * 1000) - 1, 65535)
    end_ms = int(end.timestamp() * 1000)

    while True:
        cur.execute(
            """
            SELECT tick_time, time_msc, seq, bid, ask, volume, flags
            FROM xauusd_ticks
            WHERE symbol = %s
              AND (time_msc, seq) > (%s, %s)
              AND time_msc < %s
            ORDER BY time_msc, seq
            LIMIT %s
            """,
            (symbol, last_key[0], last_key[1], end_ms, page),
        )
        rows = cur.fetchall()

        if not rows:
            break

        for r in rows:
            yield r

        last_key = (rows[-1]["time_msc"], rows[-1]["seq"])

    cur.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default=os.getenv("MT5_SYMBOL", "XAUUSD"))
    ap.add_argument("--start", required=True, help='Giờ MT5, vd "2026-11-02 14:30:00" (= 21:30 giờ VN)')
    ap.add_argument("--minutes", type=float, default=1)
    ap.add_argument("--speed", type=float, default=1,
                    help="1 = tốc độ thật, 10 = nhanh gấp 10, 0 = không chờ")
    ap.add_argument("--csv", help="Xuất ra file CSV thay vì phát lại")
    args = ap.parse_args()

    # Giờ nhập vào theo TZ_OFFSET_HOURS (mặc định 0 = giờ MT5)
    tz = timezone(timedelta(hours=float(os.getenv("TZ_OFFSET_HOURS", "0"))))
    start = datetime.fromisoformat(args.start).replace(tzinfo=tz)
    end = start + timedelta(minutes=args.minutes)

    if not DB_CONFIG["host"]:
        sys.exit("Chưa có DB_HOST: không tìm thấy file .env cạnh replay.py")

    conn = mysql.connector.connect(**DB_CONFIG)
    symbol = resolve_symbol(conn, args.symbol)

    if args.csv:
        n = 0
        with open(args.csv, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["tick_time", "time_msc", "bid", "ask", "volume", "flags"])
            for t in iter_ticks(conn, symbol, start, end):
                w.writerow([t["tick_time"], t["time_msc"], t["bid"],
                            t["ask"], t["volume"], t["flags"]])
                n += 1
        print(f"Đã xuất {n:,} tick -> {args.csv}")
        conn.close()
        return

    print(f"Replay {symbol} | {start:%Y-%m-%d %H:%M:%S} -> {end:%H:%M:%S} {start:%z} "
          f"| speed={args.speed}")
    print(f"{'time':<23} {'bid':>10} {'ask':>10} {'Δbid':>8}  ")

    wall_start = time.perf_counter()
    first_ms = None
    prev_bid = None
    hi = lo = None
    count = 0
    reversals = 0
    last_dir = 0

    for t in iter_ticks(conn, symbol, start, end):
        ms = t["time_msc"]

        if first_ms is None:
            first_ms = ms

        # Chờ đúng khoảng cách thời gian giữa các tick
        if args.speed > 0:
            target = (ms - first_ms) / 1000 / args.speed
            delay = target - (time.perf_counter() - wall_start)
            if delay > 0:
                time.sleep(delay)

        bid = float(t["bid"])
        ask = float(t["ask"])

        diff = 0.0 if prev_bid is None else bid - prev_bid
        arrow = "▲" if diff > 0 else "▼" if diff < 0 else " "

        d = 1 if diff > 0 else -1 if diff < 0 else 0
        if d and last_dir and d != last_dir:
            reversals += 1
        if d:
            last_dir = d

        hi = bid if hi is None else max(hi, bid)
        lo = bid if lo is None else min(lo, bid)

        print(f"{t['tick_time'].strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]:<23} "
              f"{bid:>10.3f} {ask:>10.3f} {diff:>+8.3f} {arrow}", flush=True)

        prev_bid = bid
        count += 1

    conn.close()

    if count == 0:
        print("Không có tick trong khoảng này (thị trường đóng cửa hoặc chưa tải).")
        return

    print("-" * 60)
    print(f"Ticks: {count:,} | High: {hi:.3f} | Low: {lo:.3f} | "
          f"Đổi chiều: {reversals:,} lần")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(1)
