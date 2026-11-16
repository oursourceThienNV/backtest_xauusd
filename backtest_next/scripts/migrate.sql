-- Bảng lưu lịch sử chạy backtest (app cũng tự tạo khi chạy lần đầu).
CREATE TABLE IF NOT EXISTS backtest_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  strategy VARCHAR(32) NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  from_day DATE NOT NULL,
  to_day DATE NOT NULL,
  label VARCHAR(120) NULL,
  config JSON NOT NULL,
  summary JSON NOT NULL,
  result LONGTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_backtest_runs_user_id (user_id),
  KEY ix_backtest_runs_strategy (strategy),
  KEY ix_backtest_runs_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
