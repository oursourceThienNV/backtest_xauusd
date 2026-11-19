/** Cấu hình đọc từ .env (giống Gia Phả: DB_* + các thông số backtest). */

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};

export const settings = {
  // Bảng tick do tool mt5_history ghi (TIMEFRAME=TICK)
  ticksTable: process.env.TICKS_TABLE || 'xauusd_ticks',
  // Symbol gốc; tự tìm symbol thật trong DB (vd XAUUSDc)
  marketSymbol: process.env.MARKET_SYMBOL || 'XAUUSD',
  // Số chữ số thập phân của giá (XAUUSDc Exness = 3)
  priceDigits: num(process.env.PRICE_DIGITS, 3),
  // 1 lot XAUUSD = 100 oz -> lãi/lỗ = chênh giá × 100 × lot
  contractSize: num(process.env.CONTRACT_SIZE, 100),
  // Giờ máy chạy bot (khung giờ giao dịch + khóa cuối tuần). Tick trong DB là giờ MT5 (UTC).
  sessionTzOffsetHours: num(process.env.SESSION_TZ_OFFSET_HOURS, 7),
  // Cache tick / nến theo ngày (đọc DB 1 lần)
  cacheDir: process.env.CACHE_DIR || '.cache',
  /** Giới hạn số ngày mỗi lần chạy; 0 = không giới hạn (mặc định) */
  maxBacktestDays: num(process.env.MAX_BACKTEST_DAYS, 0),
  /** Số ngày tick giữ sẵn trong RAM để chạy lại nhanh */
  memCacheDays: num(process.env.TICK_MEM_CACHE_DAYS, 20),
};
