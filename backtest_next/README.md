# VPS Backtest — 1 dự án Next.js (giống Gia Phả)

Phát lại thị trường XAUUSD từ **tick thật** (dữ liệu tool `mt5_history`) và backtest 4 phương pháp:
**MA Cross, Bollinger, ADX, SMA20 + RSI**. Không còn backend Python / FastAPI — toàn bộ logic chạy trong Next.js.

## Cấu trúc

```
src/
  app/                      giao diện + API nội bộ
    backtest/ compare/ history/   3 trang
    api/**/route.ts         POST, trả { responseCode: '00', responseMessage, body }
  components/               biểu đồ replay, form cấu hình, bảng lệnh, báo cáo...
  lib/                      api.ts (post), replay.ts, tickFeed.ts, format.ts, types.ts
  services/index.ts         marketService, backtestService (gọi /api/...)
  server/                   CHỈ chạy phía server (import 'server-only')
    db.ts http.ts config.ts service.ts runs.ts indicators.ts
    market/                 đọc tick từ DB + cache file, dựng nến
    backtest/               engine, broker (SL/TP/BE/Trailing từng tick), report, runner
      strategies/           maCross, bollinger, adx, smaRsi, meta (ô cấu hình)
scripts/migrate.sql         bảng backtest_runs (app tự tạo nếu chưa có)
```

## Chạy

```bash
cp .env.example .env        # điền DB_HOST, DB_USER, DB_PASSWORD, DB_NAME (cùng DB tool mt5_history)
npm install
npm run dev                 # http://localhost:3000
```

Chạy thật (server):

```bash
npm run build
npm start                   # hoặc: npx next start -p 3002
```

## Ghi chú

- Tick trong DB là giờ MT5. Khung giờ giao dịch + khóa cuối tuần tính theo `SESSION_TZ_OFFSET_HOURS` (mặc định +7).
- Lần đầu đọc 1 ngày sẽ lấy từ DB rồi lưu `.cache/ticks/...`; lần sau đọc file, rất nhanh.
  Muốn đọc lại từ DB thì xóa thư mục `.cache`.
- Chuỗi lot: thắng -> L1, thua -> L2, L3, L4, L5 (giữ L5 tới khi thắng).
- Không có đăng nhập; lịch sử chạy lưu ở bảng `backtest_runs` (user_id = 0).
