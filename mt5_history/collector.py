import os
import sys
from datetime import datetime, timedelta, timezone

import MetaTrader5 as mt5
import mysql.connector
from dotenv import load_dotenv


# ============================================================
# LOAD ENV
# ============================================================

load_dotenv()


# ============================================================
# MT5 CONFIG
# ============================================================

# Không cần LOGIN / PASSWORD / SERVER.
# Collector sẽ sử dụng account đang đăng nhập trong MT5 Terminal.

MT5_PATH = os.getenv("MT5_PATH", "").strip()

SYMBOL = os.getenv("MT5_SYMBOL", "XAUUSD").strip()
TIMEFRAME_NAME = os.getenv("TIMEFRAME", "M1").upper().strip()

MONTHS_BACK = int(os.getenv("MONTHS_BACK", "6"))
DAYS_END = int(os.getenv("DAYS_END", "1"))


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

TIMEFRAMES = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "M30": mt5.TIMEFRAME_M30,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
    "D1": mt5.TIMEFRAME_D1,
}


TIMEFRAME_MINUTES = {
    "M1": 1,
    "M5": 5,
    "M15": 15,
    "M30": 30,
    "H1": 60,
    "H4": 240,
    "D1": 1440,
}


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

    # --------------------------------------------------------
    # Account đang login trong terminal
    # --------------------------------------------------------

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

    # --------------------------------------------------------
    # Terminal info
    # --------------------------------------------------------

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

    # --------------------------------------------------------
    # Exact match
    # --------------------------------------------------------

    info = mt5.symbol_info(SYMBOL)

    if info is not None:
        log(f"Exact symbol found: {SYMBOL}")
        return SYMBOL

    # --------------------------------------------------------
    # Try broker suffix
    # --------------------------------------------------------

    symbols = mt5.symbols_get()

    if symbols:
        candidates = [
            s.name
            for s in symbols
            if s.name.upper().startswith(SYMBOL.upper())
        ]

        if candidates:
            # Ưu tiên symbol ngắn nhất.
            # Ví dụ:
            # XAUUSDc
            # XAUUSDc.a
            # XAUUSDm
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
        # Vẫn select để đảm bảo symbol active.
        mt5.symbol_select(symbol, True)

    info = mt5.symbol_info(symbol)

    log(
        f"Symbol ready : {symbol} | "
        f"digits={info.digits} | "
        f"point={info.point}"
    )


# ============================================================
# DATABASE CONNECTION
# ============================================================

def connect_db():
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

def ensure_table(conn):
    sql = """
    CREATE TABLE IF NOT EXISTS xauusd_m1 (
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

        UNIQUE KEY uk_xauusd_m1 (
            symbol,
            timeframe,
            candle_time
        ),

        KEY idx_xauusd_m1_time (
            symbol,
            timeframe,
            candle_time
        )

    ) ENGINE=InnoDB;
    """

    cur = conn.cursor()

    cur.execute(sql)

    conn.commit()

    cur.close()


# ============================================================
# GET EXISTING RANGE
# ============================================================

def get_existing_range(conn, symbol):
    cur = conn.cursor()

    cur.execute(
        """
        SELECT
            MIN(candle_time),
            MAX(candle_time),
            COUNT(*)
        FROM xauusd_m1
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
# INSERT RATES
# ============================================================

def insert_rates(conn, symbol, rates):

    if rates is None:
        return 0

    if len(rates) == 0:
        return 0

    sql = """
    INSERT IGNORE INTO xauusd_m1
    (
        symbol,
        timeframe,
        candle_time,
        open_price,
        high_price,
        low_price,
        close_price,
        tick_volume,
        spread,
        real_volume
    )
    VALUES
    (
        %s,
        %s,
        %s,
        %s,
        %s,
        %s,
        %s,
        %s,
        %s,
        %s
    )
    """

    rows = []

    for r in rates:

        # MT5 timestamp -> UTC datetime
        candle_dt = (
            datetime
            .fromtimestamp(
                int(r["time"]),
                tz=timezone.utc,
            )
            .replace(tzinfo=None)
        )

        rows.append(
            (
                symbol,
                TIMEFRAME_NAME,
                candle_dt,

                float(r["open"]),
                float(r["high"]),
                float(r["low"]),
                float(r["close"]),

                int(r["tick_volume"]),
                int(r["spread"]),
                int(r["real_volume"]),
            )
        )

    cur = conn.cursor()

    cur.executemany(
        sql,
        rows,
    )

    inserted = cur.rowcount

    conn.commit()

    cur.close()

    return inserted


# ============================================================
# FETCH MT5 DATA
# ============================================================

def fetch_rates(symbol, start_dt, end_dt):
    """
    Get historical rates from MT5.

    start_dt/end_dt MUST be UTC aware datetimes.
    """

    timeframe = TIMEFRAMES[TIMEFRAME_NAME]

    rates = mt5.copy_rates_range(
        symbol,
        timeframe,
        start_dt,
        end_dt,
    )

    if rates is None:

        error = mt5.last_error()

        log(
            f"MT5 returned None | "
            f"{start_dt} -> {end_dt} | "
            f"error={error}"
        )

        return None

    return rates


# ============================================================
# VALIDATE RECEIVED DATA
# ============================================================

def validate_rates(
    rates,
    start_dt,
    end_dt,
):
    """
    Validate MT5 response.

    For M1, a 7-day request should normally contain
    thousands of candles.

    This function does NOT fail simply because the market
    was closed. It only prints diagnostics.
    """

    if rates is None:

        log(
            "WARNING: rates=None"
        )

        return

    count = len(rates)

    if count == 0:

        log(
            f"WARNING: 0 candles returned | "
            f"{start_dt} -> {end_dt}"
        )

        return

    # --------------------------------------------------------
    # First / last candle returned
    # --------------------------------------------------------

    first_time = int(rates[0]["time"])
    last_time = int(rates[-1]["time"])

    first_dt = datetime.fromtimestamp(
        first_time,
        tz=timezone.utc,
    )

    last_dt = datetime.fromtimestamp(
        last_time,
        tz=timezone.utc,
    )

    log(
        f"MT5 range   : "
        f"{first_dt} -> {last_dt}"
    )

    log(
        f"MT5 candles  : {count:,}"
    )

    # --------------------------------------------------------
    # M1 diagnostic
    # --------------------------------------------------------

    if TIMEFRAME_NAME == "M1" and count <= 10:

        log(
            "WARNING: MT5 returned an unexpectedly small "
            f"number of M1 candles ({count}) for this range."
        )

        log(
            "WARNING: Check MT5 -> Tools -> Options -> Charts "
            "-> Max bars in chart."
        )

        log(
            "WARNING: Also make sure the XAUUSDc M1 chart/history "
            "is available in the MT5 terminal."
        )


# ============================================================
# CALCULATE DATE RANGE
# ============================================================

def calculate_date_range():

    now_utc = datetime.now(timezone.utc)

    # --------------------------------------------------------
    # End = yesterday 23:59:59 UTC
    # --------------------------------------------------------

    end_date = (
        now_utc - timedelta(days=DAYS_END)
    ).replace(
        hour=23,
        minute=59,
        second=59,
        microsecond=0,
    )

    # --------------------------------------------------------
    # Approximately MONTHS_BACK months
    # --------------------------------------------------------

    start_date = (
        end_date
        - timedelta(
            days=MONTHS_BACK * 30 + 2
        )
    )

    start_date = start_date.replace(
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    )

    return start_date, end_date


# ============================================================
# GET NEXT CANDLE
# ============================================================

def get_next_candle(dt):

    minutes = TIMEFRAME_MINUTES[TIMEFRAME_NAME]

    return dt + timedelta(
        minutes=minutes
    )


# ============================================================
# COLLECT
# ============================================================

def collect():

    # --------------------------------------------------------
    # Validate timeframe
    # --------------------------------------------------------

    if TIMEFRAME_NAME not in TIMEFRAMES:

        raise ValueError(
            f"Unsupported timeframe: {TIMEFRAME_NAME}. "
            f"Supported: {', '.join(TIMEFRAMES.keys())}"
        )

    if MONTHS_BACK <= 0:

        raise ValueError(
            "MONTHS_BACK must be greater than 0."
        )

    # --------------------------------------------------------
    # MT5
    # --------------------------------------------------------

    connect_mt5()

    # --------------------------------------------------------
    # Symbol
    # --------------------------------------------------------

    symbol = get_symbol()

    select_symbol(symbol)

    # --------------------------------------------------------
    # Database
    # --------------------------------------------------------

    conn = connect_db()

    ensure_table(conn)

    # --------------------------------------------------------
    # Existing data
    # --------------------------------------------------------

    (
        existing_min,
        existing_max,
        existing_count,
    ) = get_existing_range(
        conn,
        symbol,
    )

    # --------------------------------------------------------
    # Requested range
    # --------------------------------------------------------

    start_date, end_date = calculate_date_range()

    log("========================================")

    log(
        f"Symbol       : {symbol}"
    )

    log(
        f"Timeframe    : {TIMEFRAME_NAME}"
    )

    log(
        f"Requested    : "
        f"{start_date} UTC -> {end_date} UTC"
    )

    log(
        f"Existing DB  : "
        f"{existing_count or 0:,} candles"
    )

    if existing_min:

        log(
            f"DB range     : "
            f"{existing_min} -> {existing_max}"
        )

    # --------------------------------------------------------
    # Incremental sync
    # --------------------------------------------------------

    if existing_max:

        # DB DATETIME is stored without timezone.
        # Convert it back to UTC-aware datetime.

        existing_max_utc = existing_max.replace(
            tzinfo=timezone.utc
        )

        next_candle = get_next_candle(
            existing_max_utc
        )

        if next_candle > end_date:

            log(
                "Database is already up to date."
            )

            log(
                "Nothing to insert."
            )

            conn.close()

            mt5.shutdown()

            return

        start_date = max(
            start_date,
            next_candle,
        )

        log(
            f"Incremental : "
            f"{start_date} UTC -> {end_date} UTC"
        )

    # --------------------------------------------------------
    # Collect
    # --------------------------------------------------------

    total_received = 0
    total_inserted = 0

    # 7 days / request
    chunk_days = 7

    cursor_time = start_date

    while cursor_time <= end_date:

        # ----------------------------------------------------
        # Calculate chunk end
        # ----------------------------------------------------

        chunk_end = min(
            cursor_time
            + timedelta(
                days=chunk_days
            )
            - timedelta(
                minutes=1
            ),
            end_date,
        )

        log("")

        log(
            f"Requesting MT5: "
            f"{cursor_time} -> {chunk_end}"
        )

        # ----------------------------------------------------
        # Get data
        # ----------------------------------------------------

        rates = fetch_rates(
            symbol,
            cursor_time,
            chunk_end,
        )

        # ----------------------------------------------------
        # Validate
        # ----------------------------------------------------

        if rates is None:

            log(
                "No rates returned."
            )

        else:

            received = len(rates)

            validate_rates(
                rates,
                cursor_time,
                chunk_end,
            )

            if received > 0:

                inserted = insert_rates(
                    conn,
                    symbol,
                    rates,
                )

            else:

                inserted = 0

            total_received += received

            total_inserted += inserted

            log(
                f"{cursor_time:%Y-%m-%d} -> "
                f"{chunk_end:%Y-%m-%d} | "
                f"received={received:,} "
                f"inserted={inserted:,}"
            )

        # ----------------------------------------------------
        # Next chunk
        # ----------------------------------------------------

        cursor_time = (
            chunk_end
            + timedelta(
                minutes=TIMEFRAME_MINUTES[
                    TIMEFRAME_NAME
                ]
            )
        )

    # ========================================================
    # FINAL DB STATUS
    # ========================================================

    (
        existing_min,
        existing_max,
        existing_count,
    ) = get_existing_range(
        conn,
        symbol,
    )

    log("")

    log("========================================")
    log("SYNC COMPLETED")
    log("========================================")

    log(
        f"Received this run : "
        f"{total_received:,}"
    )

    log(
        f"Inserted this run : "
        f"{total_inserted:,}"
    )

    log(
        f"Total in DB       : "
        f"{existing_count or 0:,}"
    )

    log(
        f"DB range          : "
        f"{existing_min} -> {existing_max}"
    )

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

        log(
            "Stopped by user."
        )

        try:
            mt5.shutdown()
        except Exception:
            pass

        sys.exit(1)

    except Exception as exc:

        log(
            f"ERROR: {exc}"
        )

        try:
            mt5.shutdown()
        except Exception:
            pass

        sys.exit(1)