import os
import sys
import time
from datetime import datetime, timedelta, timezone

import MetaTrader5 as mt5
import mysql.connector
import numpy as np
from dotenv import load_dotenv


# ============================================================
# LOAD ENV
# ============================================================

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


# ============================================================
# MT5 CONFIG
# ============================================================

# Không cần LOGIN / PASSWORD / SERVER.
# Collector sẽ sử dụng account đang đăng nhập trong MT5 Terminal.

MT5_PATH = os.getenv("MT5_PATH", "").strip()

SYMBOL = os.getenv("MT5_SYMBOL", "XAUUSD").strip()
TIMEFRAME_NAME = os.getenv("TIMEFRAME", "TICK").upper().strip()

MONTHS_BACK = int(os.getenv("MONTHS_BACK", "2"))
DAYS_END = int(os.getenv("DAYS_END", "1"))

# Giá dùng để dựng nến từ tick (chỉ áp dụng cho S1): BID hoặc ASK.
# Chart MT5 mặc định dựng nến theo BID.
S1_PRICE = os.getenv("S1_PRICE", "BID").upper().strip()

# Số dòng mỗi lần INSERT (S1 có rất nhiều dòng).
INSERT_BATCH = int(os.getenv("INSERT_BATCH", "5000"))

# MT5 có thể trả tick chưa đủ khi đang tải lịch sử từ server.
# Lấy lại tới khi 2 lần liên tiếp ra cùng số tick (tối đa FETCH_RETRIES lần).
FETCH_RETRIES = int(os.getenv("FETCH_RETRIES", "6"))

# Số tick mỗi lần gọi mt5.copy_ticks_from (lấy theo trang).
TICK_PAGE_SIZE = int(os.getenv("TICK_PAGE_SIZE", "200000"))

# Múi giờ dùng để chia ngày và lưu thời gian vào DB.
# 0 = giờ MT5 (server Exness, UTC) — mặc định. 7 = giờ Việt Nam.
TZ_OFFSET_HOURS = float(os.getenv("TZ_OFFSET_HOURS", "0"))
DAY_TZ = timezone(timedelta(hours=TZ_OFFSET_HOURS))

# Đối chiếu tick với nến M1 gốc của MT5 sau mỗi ngày (TICK/S1).
VERIFY_M1 = os.getenv("VERIFY_M1", "1").strip() not in ("0", "false", "no")


# ============================================================
# DATABASE CONFIG
# ============================================================

DB_CONFIG = {
    "host": os.getenv("DB_HOST"),
    "port": int(os.getenv("DB_PORT", "3306")),
    "database": os.getenv("DB_NAME", "mt5_backtest"),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD"),
}


# ============================================================
# TIMEFRAME
# ============================================================

# S1 không phải timeframe gốc của MT5.
# Nến S1 được dựng từ tick (copy_ticks_from).

TIMEFRAMES = {
    "TICK": None,
    "S1": None,
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "M30": mt5.TIMEFRAME_M30,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
    "D1": mt5.TIMEFRAME_D1,
}


TIMEFRAME_SECONDS = {
    "TICK": 1,
    "S1": 1,
    "M1": 60,
    "M5": 300,
    "M15": 900,
    "M30": 1800,
    "H1": 3600,
    "H4": 14400,
    "D1": 86400,
}


# Mỗi lần request MT5 lấy đúng 1 ngày (UTC).


def is_tick_timeframe():
    # Các chế độ lấy dữ liệu từ tick
    return TIMEFRAME_NAME in ("S1", "TICK")


def is_raw_tick():
    # Lưu nguyên từng tick, không gộp nến
    return TIMEFRAME_NAME == "TICK"


def table_name():
    # TICK -> xauusd_ticks, S1 -> xauusd_s1, M1 -> xauusd_m1, ...
    if is_raw_tick():
        return "xauusd_ticks"
    return f"xauusd_{TIMEFRAME_NAME.lower()}"


def step():
    return timedelta(seconds=TIMEFRAME_SECONDS[TIMEFRAME_NAME])


# ============================================================
# LOG
# ============================================================

def log(message):
    print(
        f"[{datetime.now():%Y-%m-%d %H:%M:%S}] "
        f"{message}",
        flush=True,
    )


# ============================================================
# MT5 CONNECTION
# ============================================================

def connect_mt5():
    """
    Connect to the currently logged-in MT5 terminal.

    If MT5_PATH is configured and terminal is not running,
    MetaTrader5.initialize() can launch that terminal.

    No username/password/server is required.
    """

    log(f"Config file  : {ENV_FILE or 'KHÔNG TÌM THẤY .env'}")
    log("Connecting to MT5...")

    kwargs = {}

    if MT5_PATH:
        kwargs["path"] = MT5_PATH
        log(f"MT5 path     : {MT5_PATH}")

    initialized = mt5.initialize(**kwargs)

    if not initialized:
        error = mt5.last_error()

        raise RuntimeError(
            f"MT5 initialize failed: {error}"
        )

    account = mt5.account_info()

    if account is None:
        error = mt5.last_error()

        raise RuntimeError(
            "MT5 terminal đã được mở nhưng chưa có account đăng nhập. "
            f"MT5 error: {error}"
        )

    log(
        "MT5 connected: "
        f"login={account.login}, "
        f"server={account.server}, "
        f"balance={account.balance}"
    )

    terminal = mt5.terminal_info()

    if terminal is not None:
        log(
            "MT5 terminal: "
            f"build={terminal.build}, "
            f"connected={terminal.connected}"
        )

    version = mt5.version()

    if version:
        log(
            f"MT5 version  : {version}"
        )


# ============================================================
# SYMBOL
# ============================================================

def get_symbol():
    """
    Find broker symbol.

    Example:
        Config: XAUUSD
        Broker : XAUUSDc

    The function tries exact match first,
    then symbols beginning with XAUUSD.
    """

    log(f"Looking for symbol: {SYMBOL}")

    info = mt5.symbol_info(SYMBOL)

    if info is not None:
        log(f"Exact symbol found: {SYMBOL}")
        return SYMBOL

    symbols = mt5.symbols_get()

    if symbols:
        candidates = [
            s.name
            for s in symbols
            if s.name.upper().startswith(SYMBOL.upper())
        ]

        if candidates:
            # Ưu tiên symbol ngắn nhất.
            candidates.sort(key=len)

            broker_symbol = candidates[0]

            log(
                f"Exact symbol {SYMBOL} not found. "
                f"Using broker symbol: {broker_symbol}"
            )

            return broker_symbol

    raise RuntimeError(
        f"Cannot find symbol '{SYMBOL}'. "
        "Check the symbol name in Exness MT5."
    )


# ============================================================
# SELECT SYMBOL
# ============================================================

def select_symbol(symbol):
    info = mt5.symbol_info(symbol)

    if info is None:
        raise RuntimeError(
            f"Symbol info not found: {symbol}"
        )

    if not info.visible:
        log(f"Symbol {symbol} is not visible. Selecting...")

        if not mt5.symbol_select(symbol, True):
            raise RuntimeError(
                f"Cannot select symbol {symbol}: "
                f"{mt5.last_error()}"
            )

    else:
        mt5.symbol_select(symbol, True)

    info = mt5.symbol_info(symbol)

    log(
        f"Symbol ready : {symbol} | "
        f"digits={info.digits} | "
        f"point={info.point}"
    )

    return info


# ============================================================
# DATABASE CONNECTION
# ============================================================

def connect_db():
    if not DB_CONFIG["host"]:
        raise RuntimeError(
            "Chưa có DB_HOST. Không tìm thấy hoặc không đọc được file .env "
            f"trong thư mục {os.path.dirname(os.path.abspath(__file__))}. "
            "Kiểm tra file tên đúng là '.env' (không phải '.env.txt') "
            "và có dòng DB_HOST=..."
        )

    log(
        f"Connecting MariaDB: "
        f"{DB_CONFIG['host']}:{DB_CONFIG['port']}"
    )

    conn = mysql.connector.connect(**DB_CONFIG)

    if not conn.is_connected():
        raise RuntimeError(
            "Cannot connect to MariaDB."
        )

    log("MariaDB connected.")

    return conn


# ============================================================
# CREATE TABLE
# ============================================================

TICK_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS xauusd_ticks (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    symbol VARCHAR(32) NOT NULL,
    tick_time DATETIME(3) NOT NULL,
    time_msc BIGINT NOT NULL,
    seq SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    bid DECIMAL(16,5) NOT NULL,
    ask DECIMAL(16,5) NOT NULL,
    last_price DECIMAL(16,5) NOT NULL DEFAULT 0,
    volume BIGINT UNSIGNED NOT NULL DEFAULT 0,
    volume_real DOUBLE NOT NULL DEFAULT 0,
    flags INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uk_xauusd_ticks (symbol, time_msc, seq),
    KEY idx_xauusd_ticks_time (symbol, tick_time)
) ENGINE=InnoDB;
"""


def ensure_table(conn):
    t = table_name()

    if is_raw_tick():
        cur = conn.cursor()
        cur.execute(TICK_TABLE_SQL)
        # Bảng tạo từ bản trước chưa có volume_real
        cur.execute(
            "ALTER TABLE xauusd_ticks "
            "ADD COLUMN IF NOT EXISTS volume_real DOUBLE NOT NULL DEFAULT 0 "
            "AFTER volume"
        )
        conn.commit()
        cur.close()
        return

    sql = f"""
    CREATE TABLE IF NOT EXISTS {t} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        symbol VARCHAR(32) NOT NULL,
        timeframe VARCHAR(8) NOT NULL,
        candle_time DATETIME NOT NULL,
        open_price DECIMAL(16,5) NOT NULL,
        high_price DECIMAL(16,5) NOT NULL,
        low_price DECIMAL(16,5) NOT NULL,
        close_price DECIMAL(16,5) NOT NULL,
        tick_volume BIGINT UNSIGNED NOT NULL DEFAULT 0,
        spread INT NOT NULL DEFAULT 0,
        real_volume BIGINT UNSIGNED NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_{t} (symbol, timeframe, candle_time)
    ) ENGINE=InnoDB;
    """

    cur = conn.cursor()
    cur.execute(sql)
    conn.commit()
    cur.close()


# ============================================================
# SYNC LOG — ghi lại những ngày đã lấy xong
# ============================================================

SYNC_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS sync_log (
    symbol VARCHAR(32) NOT NULL,
    timeframe VARCHAR(8) NOT NULL,
    trade_day DATE NOT NULL,
    row_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL,
    synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, timeframe, trade_day)
) ENGINE=InnoDB;
"""


def ensure_sync_table(conn):
    cur = conn.cursor()
    cur.execute(SYNC_TABLE_SQL)
    conn.commit()
    cur.close()


def get_done_days(conn, symbol, first_day, last_day):
    cur = conn.cursor()
    cur.execute(
        """
        SELECT trade_day FROM sync_log
        WHERE symbol = %s AND timeframe = %s
          AND trade_day BETWEEN %s AND %s
        """,
        (symbol, TIMEFRAME_NAME, first_day, last_day),
    )
    done = {r[0] for r in cur.fetchall()}
    cur.close()
    return done


def mark_day_done(conn, symbol, day, row_count, status):
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO sync_log (symbol, timeframe, trade_day, row_count, status)
        VALUES (%s, %s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE
            row_count = VALUES(row_count),
            status = VALUES(status)
        """,
        (symbol, TIMEFRAME_NAME, day, row_count, status),
    )
    conn.commit()
    cur.close()


# ============================================================
# GET EXISTING RANGE
# ============================================================

def get_existing_range(conn, symbol):
    cur = conn.cursor()

    if is_raw_tick():
        cur.execute(
            """
            SELECT MIN(tick_time), MAX(tick_time), COUNT(*)
            FROM xauusd_ticks
            WHERE symbol = %s
            """,
            (symbol,),
        )
        row = cur.fetchone()
        cur.close()
        return row

    cur.execute(
        f"""
        SELECT
            MIN(candle_time),
            MAX(candle_time),
            COUNT(*)
        FROM {table_name()}
        WHERE
            symbol = %s
            AND timeframe = %s
        """,
        (
            symbol,
            TIMEFRAME_NAME,
        ),
    )

    row = cur.fetchone()
    cur.close()

    return row


# ============================================================
# INSERT ROWS
# ============================================================

def insert_rows(conn, rows):
    """
    rows: list of tuples, ghi theo từng batch INSERT_BATCH dòng.
    """

    if not rows:
        return 0

    if is_raw_tick():
        sql = """
        INSERT IGNORE INTO xauusd_ticks
        (symbol, tick_time, time_msc, seq, bid, ask, last_price,
         volume, volume_real, flags)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """
    else:
        sql = f"""
        INSERT IGNORE INTO {table_name()}
        (symbol, timeframe, candle_time, open_price, high_price,
         low_price, close_price, tick_volume, spread, real_volume)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """

    inserted = 0
    cur = conn.cursor()

    for i in range(0, len(rows), INSERT_BATCH):
        batch = rows[i:i + INSERT_BATCH]
        cur.executemany(sql, batch)
        inserted += cur.rowcount
        conn.commit()

    cur.close()

    return inserted


def to_db_time(ts_seconds):
    """Epoch giây -> datetime theo DAY_TZ (giờ VN mặc định) để lưu DB."""
    return (
        datetime
        .fromtimestamp(int(ts_seconds), tz=DAY_TZ)
        .replace(tzinfo=None)
    )


# ============================================================
# BAR TIMEFRAMES (M1, M5, ...) — copy_rates_range
# ============================================================

def fetch_rates(symbol, start_dt, end_dt):
    rates = mt5.copy_rates_range(
        symbol,
        TIMEFRAMES[TIMEFRAME_NAME],
        start_dt,
        end_dt,
    )

    if rates is None:
        log(
            f"MT5 returned None | "
            f"{start_dt} -> {end_dt} | "
            f"error={mt5.last_error()}"
        )

    return rates


def rates_to_rows(symbol, rates):
    rows = []

    for r in rates:
        rows.append(
            (
                symbol,
                TIMEFRAME_NAME,
                to_db_time(r["time"]),
                float(r["open"]),
                float(r["high"]),
                float(r["low"]),
                float(r["close"]),
                int(r["tick_volume"]),
                int(r["spread"]),
                int(r["real_volume"]),
            )
        )

    return rows


# ============================================================
# TICK — mt5.copy_ticks_from theo trang
# ============================================================
#
# Không dùng mt5.copy_ticks_range: trên một số build MT5 (vd 6230)
# hàm này treo ~100 giây rồi báo (-1, 'Terminal: Call failed'),
# trong khi copy_ticks_from vẫn chạy bình thường.

_TICK_DTYPE = [
    ("time", "<i8"),
    ("bid", "<f8"),
    ("ask", "<f8"),
    ("last", "<f8"),
    ("volume", "<u8"),
    ("time_msc", "<i8"),
    ("flags", "<u4"),
    ("volume_real", "<f8"),
]


def _empty_ticks():
    return np.zeros(0, dtype=_TICK_DTYPE)


def _ticks_from_stable(symbol, from_sec, count):
    """
    Gọi copy_ticks_from, lặp lại tới khi kết quả ổn định
    (MT5 có thể trả thiếu khi đang tải lịch sử từ server).
    """

    prev = None
    ticks = None

    for attempt in range(1, FETCH_RETRIES + 1):

        ticks = mt5.copy_ticks_from(
            symbol,
            int(from_sec),
            int(count),
            mt5.COPY_TICKS_ALL,
        )

        if ticks is None:
            log(
                f"MT5 returned None (ticks) | from "
                f"{datetime.fromtimestamp(from_sec, tz=DAY_TZ)} | "
                f"error={mt5.last_error()} | attempt {attempt}/{FETCH_RETRIES}"
            )
            time.sleep(5)
            continue

        n = len(ticks)

        # Trang đầy -> chắc chắn đã có đủ dữ liệu cho trang này
        if n >= count:
            return ticks

        if prev is not None and n == prev:
            return ticks

        if prev is not None:
            log(f"Ticks still loading: {prev:,} -> {n:,}, retry...")

        prev = n
        time.sleep(1 if attempt == 1 else 3)

    if ticks is not None:
        log(
            f"WARNING: tick count not stable after {FETCH_RETRIES} attempts, "
            f"using last result ({len(ticks):,})"
        )

    return ticks


def fetch_ticks(symbol, start_dt, end_dt):
    """
    Lấy toàn bộ tick có thời gian trong [start_dt, end_dt).

    Lấy theo trang TICK_PAGE_SIZE tick. Mỗi trang đầy thì bỏ giây
    cuối (có thể chưa đủ tick) và trang sau bắt đầu lại từ giây đó,
    nên không thiếu và không trùng tick.

    Trả về None nếu MT5 lỗi (ngày đó sẽ được lấy lại lần sau).
    """

    start_ms = int(start_dt.timestamp() * 1000)
    end_ms = int(end_dt.timestamp() * 1000)

    cur_sec = start_ms // 1000
    pieces = []

    while cur_sec * 1000 < end_ms:

        page = _ticks_from_stable(symbol, cur_sec, TICK_PAGE_SIZE)

        if page is None:
            return None

        full = len(page) >= TICK_PAGE_SIZE

        page = page[page["time_msc"] >= cur_sec * 1000]

        if len(page) == 0:
            break

        last_sec = int(page["time_msc"][-1]) // 1000

        if full and last_sec > cur_sec:
            # Giây cuối có thể bị cắt dở -> để trang sau lấy lại
            keep = page[page["time_msc"] < last_sec * 1000]
            next_sec = last_sec
        else:
            if full:
                log(
                    f"WARNING: > {TICK_PAGE_SIZE:,} ticks trong 1 giây, "
                    "tăng TICK_PAGE_SIZE"
                )
            keep = page
            next_sec = last_sec + 1

        keep = keep[keep["time_msc"] < end_ms]

        if len(keep):
            pieces.append(keep)

        # Trang không đầy = đã tới tick mới nhất MT5 có
        if not full:
            break

        cur_sec = next_sec

    if not pieces:
        return _empty_ticks()

    return np.concatenate(pieces)


def ticks_to_s1(ticks, start_dt, end_dt, point):
    """
    Gộp tick thành nến 1 giây.

    - Chỉ lấy tick có time_msc trong [start_dt, end_dt + 1s)
      để không có giây nào bị cắt đôi giữa 2 chunk.
    - OHLC theo giá S1_PRICE (BID mặc định).
    - tick_volume = số tick trong giây đó.
    - spread      = spread nhỏ nhất trong giây (points), giống MT5.
    - real_volume = tổng volume thực (nếu broker có).

    Chỉ những giây có tick mới tạo nến (giống MT5: không có tick
    thì không có bar).

    Returns structured numpy array:
        time, open, high, low, close, tick_volume, spread, real_volume
    """

    dtype = [
        ("time", "i8"),
        ("open", "f8"),
        ("high", "f8"),
        ("low", "f8"),
        ("close", "f8"),
        ("tick_volume", "i8"),
        ("spread", "i8"),
        ("real_volume", "i8"),
    ]

    if ticks is None or len(ticks) == 0:
        return np.zeros(0, dtype=dtype)

    price_field = "ask" if S1_PRICE == "ASK" else "bid"

    t_ms = ticks["time_msc"].astype(np.int64)
    price = ticks[price_field].astype(np.float64)
    bid = ticks["bid"].astype(np.float64)
    ask = ticks["ask"].astype(np.float64)
    vol = ticks["volume"].astype(np.int64)

    start_ms = int(start_dt.timestamp()) * 1000
    end_ms = (int(end_dt.timestamp()) + 1) * 1000

    # Bỏ tick ngoài khoảng và tick không có giá (vd: tick chỉ đổi last).
    mask = (
        (t_ms >= start_ms)
        & (t_ms < end_ms)
        & (price > 0)
    )

    t_ms = t_ms[mask]
    price = price[mask]
    bid = bid[mask]
    ask = ask[mask]
    vol = vol[mask]

    if len(t_ms) == 0:
        return np.zeros(0, dtype=dtype)

    # Đảm bảo đúng thứ tự thời gian (stable để giữ thứ tự tick cùng ms).
    order = np.argsort(t_ms, kind="stable")
    t_ms = t_ms[order]
    price = price[order]
    bid = bid[order]
    ask = ask[order]
    vol = vol[order]

    sec = t_ms // 1000

    # Vị trí bắt đầu của mỗi giây
    starts = np.flatnonzero(
        np.concatenate(([True], sec[1:] != sec[:-1]))
    )
    ends = np.concatenate((starts[1:], [len(sec)])) - 1

    bars = np.zeros(len(starts), dtype=dtype)

    bars["time"] = sec[starts]
    bars["open"] = price[starts]
    bars["close"] = price[ends]
    bars["high"] = np.maximum.reduceat(price, starts)
    bars["low"] = np.minimum.reduceat(price, starts)
    bars["tick_volume"] = ends - starts + 1
    bars["real_volume"] = np.add.reduceat(vol, starts)

    # Spread (points). Tick thiếu bid/ask thì không tính spread.
    if point and point > 0:
        spread_pts = np.where(
            (bid > 0) & (ask > 0),
            np.rint((ask - bid) / point),
            np.iinfo(np.int64).max,
        ).astype(np.int64)

        min_spread = np.minimum.reduceat(spread_pts, starts)
        min_spread[min_spread == np.iinfo(np.int64).max] = 0
        bars["spread"] = min_spread

    return bars


def ticks_to_rows(symbol, ticks, start_dt, end_dt):
    """
    Giữ nguyên từng tick trong [start_dt, end_dt + 1s).

    seq = thứ tự của tick trong cùng 1 mili-giây (MT5 có thể có
    nhiều tick cùng time_msc). Vì chunk luôn bắt đầu ở đầu giây,
    seq luôn tính giống nhau giữa các lần chạy -> INSERT IGNORE
    chống trùng chính xác.
    """

    if ticks is None or len(ticks) == 0:
        return []

    t_ms = ticks["time_msc"].astype(np.int64)

    start_ms = int(start_dt.timestamp()) * 1000
    end_ms = (int(end_dt.timestamp()) + 1) * 1000

    mask = (t_ms >= start_ms) & (t_ms < end_ms)
    ticks = ticks[mask]

    if len(ticks) == 0:
        return []

    order = np.argsort(ticks["time_msc"], kind="stable")
    ticks = ticks[order]

    rows = []
    prev_ms = None
    seq = 0

    for tk in ticks:
        ms = int(tk["time_msc"])

        if ms == prev_ms:
            seq += 1
        else:
            seq = 0
            prev_ms = ms

        tick_dt = (
            datetime.fromtimestamp(ms / 1000, tz=DAY_TZ)
            .replace(tzinfo=None)
        )

        rows.append(
            (
                symbol,
                tick_dt,
                ms,
                seq,
                float(tk["bid"]),
                float(tk["ask"]),
                float(tk["last"]),
                int(tk["volume"]),
                float(tk["volume_real"]) if "volume_real" in tk.dtype.names else 0.0,
                int(tk["flags"]),
            )
        )

    return rows


def verify_against_m1(symbol, ticks, start_dt, end_dt, point):
    """
    Dựng nến M1 từ tick (theo BID) và so với nến M1 gốc của MT5.
    MT5 cũng dựng M1 từ chính các tick này, nên nếu đủ tick thì
    OHLC phải khớp từng phút. Lệch = thiếu tick hoặc lịch sử tick
    của broker không đầy đủ ở khoảng đó.
    """

    # copy_rates_from lấy `count` nến tính lùi từ end_dt
    # (tránh copy_rates_range vì có thể bị treo giống copy_ticks_range).
    end_sec = int(end_dt.timestamp())
    start_sec = int(start_dt.timestamp())

    rates = mt5.copy_rates_from(
        symbol,
        mt5.TIMEFRAME_M1,
        end_sec,
        (end_sec - start_sec) // 60 + 10,
    )

    if rates is not None and len(rates):
        rates = rates[(rates["time"] >= start_sec) & (rates["time"] <= end_sec)]

    if rates is None or len(rates) == 0:
        log("Verify M1    : MT5 không có nến M1 để đối chiếu")
        return None

    bars = ticks_to_s1(ticks, start_dt, end_dt, point)

    built = {}
    for b in bars:
        m = int(b["time"]) // 60 * 60
        if m not in built:
            built[m] = [b["open"], b["high"], b["low"], b["close"]]
        else:
            x = built[m]
            x[1] = max(x[1], b["high"])
            x[2] = min(x[2], b["low"])
            x[3] = b["close"]

    tol = (point or 0.001) / 2
    missing = []
    diff = []

    for r in rates:
        m = int(r["time"])
        mine = built.get(m)

        if mine is None:
            missing.append(m)
            continue

        ref = (r["open"], r["high"], r["low"], r["close"])
        if any(abs(a - b) > tol for a, b in zip(mine, ref)):
            diff.append((m, ref, mine))

    total = len(rates)
    ok = total - len(missing) - len(diff)

    if not missing and not diff:
        log(f"Verify M1    : OK {ok:,}/{total:,} phút khớp 100% với MT5")
        return True

    log(
        f"Verify M1    : khớp {ok:,}/{total:,} | "
        f"thiếu tick {len(missing):,} phút | lệch OHLC {len(diff):,} phút"
    )

    for m in missing[:5]:
        log(f"  thiếu: {to_db_time(m)}")

    for m, ref, mine in diff[:5]:
        log(
            f"  lệch : {to_db_time(m)} "
            f"MT5 O/H/L/C={tuple(round(float(v), 5) for v in ref)} "
            f"tick={tuple(round(float(v), 5) for v in mine)}"
        )

    return False


# ============================================================
# VALIDATE RECEIVED DATA
# ============================================================

def validate_bars(bars, start_dt, end_dt, raw_ticks=None):
    """
    Chỉ in thông tin chẩn đoán, không dừng chương trình
    (thị trường đóng cửa thì 0 nến là bình thường).
    """

    if raw_ticks is not None:
        log(f"MT5 ticks    : {len(raw_ticks):,}")

    count = 0 if bars is None else len(bars)

    if count == 0:
        log(
            f"WARNING: 0 candles | "
            f"{start_dt} -> {end_dt}"
        )
        return

    first_dt = datetime.fromtimestamp(int(bars[0]["time"]), tz=DAY_TZ)
    last_dt = datetime.fromtimestamp(int(bars[-1]["time"]), tz=DAY_TZ)

    log(f"Data range   : {first_dt} -> {last_dt}")
    log(f"Candles      : {count:,}")

    if TIMEFRAME_NAME == "M1" and count <= 10:
        log(
            "WARNING: MT5 returned an unexpectedly small "
            f"number of M1 candles ({count}) for this range."
        )
        log(
            "WARNING: Check MT5 -> Tools -> Options -> Charts "
            "-> Max bars in chart."
        )


# ============================================================
# CALCULATE DATE RANGE
# ============================================================

def calculate_date_range():

    now_local = datetime.now(DAY_TZ)

    # End = (hôm nay - DAYS_END) 23:59:59 theo DAY_TZ (giờ VN)
    end_date = (
        now_local - timedelta(days=DAYS_END)
    ).replace(
        hour=23,
        minute=59,
        second=59,
        microsecond=0,
    )

    start_date = (
        end_date
        - timedelta(days=MONTHS_BACK * 30 + 2)
    ).replace(
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    )

    return start_date, end_date


# ============================================================
# COLLECT
# ============================================================

def collect():

    if TIMEFRAME_NAME not in TIMEFRAMES:
        raise ValueError(
            f"Unsupported timeframe: {TIMEFRAME_NAME}. "
            f"Supported: {', '.join(TIMEFRAMES.keys())}"
        )

    if MONTHS_BACK <= 0:
        raise ValueError("MONTHS_BACK must be greater than 0.")

    if S1_PRICE not in ("BID", "ASK"):
        raise ValueError("S1_PRICE must be BID or ASK.")

    # --------------------------------------------------------
    # MT5 + symbol
    # --------------------------------------------------------

    connect_mt5()

    symbol = get_symbol()
    symbol_info = select_symbol(symbol)

    # --------------------------------------------------------
    # Database
    # --------------------------------------------------------

    conn = connect_db()
    ensure_table(conn)

    existing_min, existing_max, existing_count = get_existing_range(
        conn, symbol
    )

    start_date, end_date = calculate_date_range()

    log("========================================")
    log(f"Symbol       : {symbol}")
    log(f"Timeframe    : {TIMEFRAME_NAME}")
    log(f"Table        : {table_name()}")
    if is_raw_tick():
        log("Source       : raw ticks (bid/ask, millisecond)")
    elif is_tick_timeframe():
        log(f"Source       : ticks ({S1_PRICE}) -> 1-second bars")
    log(f"Timezone     : UTC{TZ_OFFSET_HOURS:+g} (chia ngày + thời gian lưu DB)")
    log(f"Requested    : {start_date} -> {end_date}")
    log(f"Existing DB  : {existing_count or 0:,} rows")

    if existing_min:
        log(f"DB range     : {existing_min} -> {existing_max}")

    # --------------------------------------------------------
    # Kiểm tra từng ngày: đã lấy xong -> bỏ qua, chưa có -> lấy.
    # Không bao giờ xoá dữ liệu cũ.
    # --------------------------------------------------------

    ensure_sync_table(conn)

    first_day = start_date.date()
    last_day = end_date.date()

    all_days = [
        first_day + timedelta(days=k)
        for k in range((last_day - first_day).days + 1)
    ]

    done_days = get_done_days(conn, symbol, first_day, last_day)
    todo_days = [d for d in all_days if d not in done_days]

    log(
        f"Days         : {len(all_days)} ngày | đã có {len(done_days)} | "
        f"cần lấy {len(todo_days)}"
    )

    if not todo_days:
        log("Database is already up to date.")
        log("Nothing to insert.")
        conn.close()
        mt5.shutdown()
        return

    total_received = 0
    total_inserted = 0
    retry_days = []

    now_utc = datetime.now(timezone.utc)

    for day in todo_days:

        day_start = datetime(day.year, day.month, day.day, tzinfo=DAY_TZ)
        day_end = day_start + timedelta(days=1) - timedelta(seconds=1)

        log("")
        log(f"Requesting MT5: {day_start} -> {day_end}")

        fetch_ok = True
        verified = None

        if is_tick_timeframe():

            ticks = fetch_ticks(
                symbol,
                day_start,
                day_end + timedelta(seconds=1),
            )

            if ticks is None:
                fetch_ok = False

            if ticks is not None and len(ticks) > 0 and VERIFY_M1:
                verified = verify_against_m1(
                    symbol, ticks, day_start, day_end, symbol_info.point
                )

            if is_raw_tick():
                rows = ticks_to_rows(symbol, ticks, day_start, day_end)

                if ticks is not None:
                    log(f"MT5 ticks    : {len(ticks):,}")
                    if rows:
                        log(f"Data range   : {rows[0][1]} -> {rows[-1][1]}")
            else:
                bars = ticks_to_s1(
                    ticks,
                    day_start,
                    day_end,
                    symbol_info.point,
                )

                if ticks is not None:
                    validate_bars(bars, day_start, day_end, raw_ticks=ticks)

                rows = rates_to_rows(symbol, bars)

        else:

            rates = fetch_rates(symbol, day_start, day_end)

            if rates is not None:
                validate_bars(rates, day_start, day_end)
                rows = rates_to_rows(symbol, rates)
            else:
                fetch_ok = False
                rows = []

        received = len(rows)
        inserted = insert_rows(conn, rows)

        total_received += received
        total_inserted += inserted

        # ----------------------------------------------------
        # Đánh dấu ngày đã xong?
        # ----------------------------------------------------

        status = None
        weekend = day.weekday() >= 5  # Thứ 7, Chủ nhật

        if not fetch_ok:
            reason = "MT5 lỗi"
        elif day_end >= now_utc:
            reason = "ngày chưa kết thúc"
        elif received > 0 and verified is False:
            reason = "chưa khớp M1 của MT5"
        elif received > 0:
            status = "ok" if verified else "unverified"
        elif weekend:
            status = "closed"
        else:
            reason = "0 dữ liệu ngày thường (nghỉ lễ hoặc MT5 chưa tải)"

        if status:
            mark_day_done(conn, symbol, day, received, status)
            note = f"done ({status})"
        else:
            retry_days.append(day)
            note = f"lấy lại lần sau: {reason}"

        log(
            f"{day} | received={received:,} "
            f"inserted={inserted:,} | {note}"
        )

    # ========================================================
    # FINAL DB STATUS
    # ========================================================

    existing_min, existing_max, existing_count = get_existing_range(
        conn, symbol
    )

    log("")
    log("========================================")
    log("SYNC COMPLETED")
    log("========================================")
    log(f"Received this run : {total_received:,}")
    log(f"Inserted this run : {total_inserted:,}")
    if retry_days:
        log(
            f"Sẽ lấy lại lần sau: {len(retry_days)} ngày "
            f"({', '.join(str(d) for d in retry_days[:10])}"
            f"{' ...' if len(retry_days) > 10 else ''})"
        )
    log(f"Total in DB       : {existing_count or 0:,}")
    log(f"DB range          : {existing_min} -> {existing_max}")
    log("========================================")

    conn.close()
    mt5.shutdown()


# ============================================================
# MAIN
# ============================================================

if __name__ == "__main__":

    try:
        collect()

    except KeyboardInterrupt:
        log("Stopped by user.")
        try:
            mt5.shutdown()
        except Exception:
            pass
        sys.exit(1)

    except Exception as exc:
        log(f"ERROR: {exc}")
        try:
            mt5.shutdown()
        except Exception:
            pass
        sys.exit(1)
