CREATE DATABASE IF NOT EXISTS mt5_backtest
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE mt5_backtest;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS backtest_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  timeframe VARCHAR(8) NOT NULL DEFAULT 'M1',
  from_time DATETIME NOT NULL,
  to_time DATETIME NOT NULL,
  ma_fast INT NOT NULL,
  ma_slow INT NOT NULL,
  ema_trend INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'READY',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bt_user (user_id),
  CONSTRAINT fk_bt_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS decisions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id BIGINT UNSIGNED NOT NULL,
  event_time DATETIME NOT NULL,
  cross_type VARCHAR(20) NOT NULL,
  decision VARCHAR(30) NOT NULL,
  payload JSON NOT NULL,
  response JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_decision_session_time (session_id, event_time),
  CONSTRAINT fk_decision_session FOREIGN KEY (session_id) REFERENCES backtest_sessions(id)
) ENGINE=InnoDB;

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
