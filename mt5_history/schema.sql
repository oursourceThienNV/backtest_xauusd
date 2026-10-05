CREATE DATABASE IF NOT EXISTS mt5_backtest
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE mt5_backtest;

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
    UNIQUE KEY uk_xauusd_m1 (symbol, timeframe, candle_time),
    KEY idx_xauusd_m1_time (symbol, timeframe, candle_time)
) ENGINE=InnoDB;
