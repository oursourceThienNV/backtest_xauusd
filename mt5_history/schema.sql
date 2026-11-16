CREATE DATABASE IF NOT EXISTS mt5_backtest
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE mt5_backtest;

-- Ghi lại những ngày đã lấy xong (collector tự tạo).
-- status: ok = đủ tick, khớp M1 MT5 | unverified = có dữ liệu, không đối chiếu được
--         closed = cuối tuần không có giao dịch
-- Muốn lấy lại 1 ngày: xoá dòng của ngày đó trong bảng này rồi chạy lại.
CREATE TABLE IF NOT EXISTS sync_log (
    symbol VARCHAR(32) NOT NULL,
    timeframe VARCHAR(8) NOT NULL,
    trade_day DATE NOT NULL,
    row_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL,
    synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, timeframe, trade_day)
) ENGINE=InnoDB;

-- Tick gốc (từng nhịp giá thật, chính xác tới mili-giây) — TIMEFRAME=TICK
-- seq = thứ tự các tick có cùng time_msc
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

-- Ví dụ: xem toàn bộ biến động trong 1 phút
-- SELECT tick_time, bid, ask FROM xauusd_ticks
-- WHERE symbol = 'XAUUSDc'
--   AND tick_time >= '2026-11-02 14:30:00' AND tick_time < '2026-11-02 14:31:00'
-- ORDER BY time_msc, seq;

-- Nến 1 giây (dựng từ tick) — TIMEFRAME=S1
CREATE TABLE IF NOT EXISTS xauusd_s1 (
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
    UNIQUE KEY uk_xauusd_s1 (symbol, timeframe, candle_time)
) ENGINE=InnoDB;

-- Nến M1 (dữ liệu cũ) — TIMEFRAME=M1
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
    UNIQUE KEY uk_xauusd_m1 (symbol, timeframe, candle_time)
) ENGINE=InnoDB;

-- Ví dụ: dựng lại nến M1 từ S1 (để đối chiếu với MT5)
-- SELECT
--   DATE_FORMAT(candle_time, '%Y-%m-%d %H:%i:00') AS m1_time,
--   SUBSTRING_INDEX(GROUP_CONCAT(open_price  ORDER BY candle_time), ',', 1)       AS open_price,
--   MAX(high_price) AS high_price,
--   MIN(low_price)  AS low_price,
--   SUBSTRING_INDEX(GROUP_CONCAT(close_price ORDER BY candle_time DESC), ',', 1)  AS close_price,
--   SUM(tick_volume) AS tick_volume
-- FROM xauusd_s1
-- WHERE symbol = 'XAUUSDc' AND candle_time >= '2026-11-02' AND candle_time < '2026-11-03'
-- GROUP BY m1_time
-- ORDER BY m1_time;
