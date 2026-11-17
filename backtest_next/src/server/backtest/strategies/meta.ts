// Mô tả + ô cấu hình 4 phương pháp (frontend tự dựng form từ đây).
// Giá trị mặc định = mặc định trên giao diện bot live.

export type FieldDef = { key: string; label: string; type: string; default: any; min?: number; max?: number; step?: number; group?: string; help?: string; show_if?: string; options?: string[] };
export type StrategyMeta = { name: string; color: string; warmup_days: number; timeframes: string; summary: string; steps: string[]; presets?: Record<string, { label: string; values: Record<string, any> }>; fields: FieldDef[] };

export const STRATEGY_META: Record<string, StrategyMeta> = {
  "ma_cross": {
    "name": "MA Cross",
    "color": "#f59e0b",
    "warmup_days": 4,
    "timeframes": "M1",
    "summary": "MA Fast cắt MA Slow trên M1, lọc trend MA200, FOMO, Sideway, J-K. Vào lệnh MARKET.",
    "steps": [
      "Trend MA200: Close > MA → chỉ BUY, Close < MA → chỉ SELL",
      "MA Fast cắt MA Slow (SMA) trên nến M1 đã đóng → điểm Cross (mỗi Cross xét 1 lần)",
      "FOMO: Cross − Low (BUY) / High − Cross (SELL) > 200% biên độ TB 3 nến trước → bỏ",
      "Sideway TH1: Cross trong ±3 giá Cross của lệnh thua đầu tiên • TH2: Cross trong ±3 giá MA Trend → bỏ",
      "J-K (tùy chọn): độ dốc SMA khung lớn phải nằm trong ngưỡng",
      "SL = đáy/đỉnh 10 nến trước Cross ± 0.1, khoảng SL 3.01–8.99 giá (ngoài khoảng → bỏ lệnh)",
      "TP = khoảng SL × R:R (đúng tỉ lệ nhập)"
    ],
    "presets": {
      "low": {
        "label": "Lợi nhuận thấp (an toàn)",
        "values": {
          "ma_fast": 9,
          "ma_slow": 21,
          "ma_trend": true,
          "ma_value": 200,
          "sideway_filter": true,
          "sideway_ma_filter": true,
          "anti_fomo": true
        }
      },
      "high": {
        "label": "Lợi nhuận cao",
        "values": {
          "ma_fast": 9,
          "ma_slow": 21,
          "ma_trend": false,
          "ma_value": 200,
          "sideway_filter": true,
          "sideway_ma_filter": false,
          "anti_fomo": true
        }
      }
    },
    "fields": [
      {
        "key": "ma_fast",
        "label": "MA Fast",
        "type": "number",
        "default": 9,
        "min": 1,
        "step": 1,
        "group": "Thông số phương pháp"
      },
      {
        "key": "ma_slow",
        "label": "MA Slow",
        "type": "number",
        "default": 21,
        "min": 2,
        "step": 1,
        "group": "Thông số phương pháp"
      },
      {
        "key": "ma_trend",
        "label": "Lọc trend MA Trend",
        "type": "bool",
        "default": true,
        "group": "Thông số phương pháp"
      },
      {
        "key": "ma_value",
        "label": "MA Trend",
        "type": "number",
        "default": 200,
        "min": 2,
        "step": 1,
        "group": "Thông số phương pháp"
      },
      {
        "key": "anti_fomo",
        "label": "Chống FOMO (200% biên độ)",
        "type": "bool",
        "default": true,
        "group": "Thông số phương pháp"
      },
      {
        "key": "sideway_filter",
        "label": "Sideway TH1 (±3 Cross lệnh thua đầu)",
        "type": "bool",
        "default": true,
        "group": "Thông số phương pháp"
      },
      {
        "key": "sideway_ma_filter",
        "label": "Sideway TH2 (±3 MA Trend)",
        "type": "bool",
        "default": true,
        "group": "Thông số phương pháp"
      },
      {
        "key": "jk_filter",
        "label": "Lọc độ dốc J-K",
        "type": "bool",
        "default": false,
        "group": "Thông số phương pháp"
      },
      {
        "key": "jk_timeframe",
        "label": "J-K khung",
        "type": "select",
        "default": "M15",
        "options": [
          "M1",
          "M5",
          "M15",
          "M30",
          "H1",
          "H4"
        ],
        "group": "Thông số phương pháp",
        "show_if": "jk_filter"
      },
      {
        "key": "jk_sma_period",
        "label": "J-K SMA",
        "type": "number",
        "default": 20,
        "min": 2,
        "group": "Thông số phương pháp",
        "show_if": "jk_filter"
      },
      {
        "key": "jk_max_abs_k",
        "label": "|K| tối đa",
        "type": "number",
        "default": 0.3,
        "step": 0.01,
        "group": "Thông số phương pháp",
        "show_if": "jk_filter"
      },
      {
        "key": "jk_min_abs_j",
        "label": "|J| tối thiểu",
        "type": "number",
        "default": 0.5,
        "step": 0.01,
        "group": "Thông số phương pháp",
        "show_if": "jk_filter"
      },
      {
        "key": "jk_max_abs_j",
        "label": "|J| tối đa (999 = không giới hạn)",
        "type": "number",
        "default": 1.0,
        "step": 0.01,
        "group": "Thông số phương pháp",
        "show_if": "jk_filter"
      },
      {
        "key": "jk_block_no_data",
        "label": "J-K chặn khi thiếu dữ liệu",
        "type": "bool",
        "default": true,
        "group": "Thông số phương pháp",
        "show_if": "jk_filter"
      },
      {
        "key": "initial_balance",
        "label": "Vốn ban đầu",
        "type": "number",
        "default": 10000,
        "min": 1,
        "step": 100,
        "group": "Quản lý lệnh"
      },
      {
        "key": "lot",
        "label": "Lot ban đầu",
        "type": "number",
        "default": 0.01,
        "min": 0.01,
        "step": 0.01,
        "group": "Quản lý lệnh"
      },
      {
        "key": "rr_risk",
        "label": "R:R – Risk",
        "type": "number",
        "default": 1.0,
        "min": 0.1,
        "step": 0.1,
        "group": "Quản lý lệnh"
      },
      {
        "key": "rr_reward",
        "label": "R:R – Reward",
        "type": "number",
        "default": 0.9,
        "min": 0.1,
        "step": 0.1,
        "group": "Quản lý lệnh"
      },
      {
        "key": "multi_lot",
        "label": "Sử dụng chuỗi lot",
        "type": "bool",
        "default": false,
        "group": "Quản lý lệnh",
        "help": "Thắng -> L1, thua -> L2, L3, L4, L5 (giữ L5 tới khi thắng)"
      },
      {
        "key": "lots",
        "label": "Chuỗi lot L1→L5",
        "type": "lots",
        "default": [
          0.01,
          0.02,
          0.04,
          0.08,
          0.16
        ],
        "group": "Quản lý lệnh",
        "show_if": "multi_lot"
      },
      {
        "key": "be",
        "label": "Tự dời SL về Entry (hòa vốn)",
        "type": "bool",
        "default": false,
        "group": "Bảo vệ lợi nhuận"
      },
      {
        "key": "be_trigger_pct",
        "label": "Hòa vốn khi đạt % TP",
        "type": "number",
        "default": 50,
        "min": 1,
        "max": 100,
        "group": "Bảo vệ lợi nhuận",
        "show_if": "be"
      },
      {
        "key": "trailing",
        "label": "Trailing stop khóa lời",
        "type": "bool",
        "default": false,
        "group": "Bảo vệ lợi nhuận"
      },
      {
        "key": "trailing_trigger_pct",
        "label": "Trailing khi đạt % TP",
        "type": "number",
        "default": 50,
        "min": 1,
        "max": 100,
        "group": "Bảo vệ lợi nhuận",
        "show_if": "trailing"
      },
      {
        "key": "trailing_lock_pct",
        "label": "Khóa % lợi nhuận",
        "type": "number",
        "default": 60,
        "min": 1,
        "max": 99,
        "group": "Bảo vệ lợi nhuận",
        "show_if": "trailing"
      },
      {
        "key": "friday_lock",
        "label": "Khóa lệnh cuối tuần (00:01 thứ 7)",
        "type": "bool",
        "default": false,
        "group": "Thời gian"
      },
      {
        "key": "trading_time_enabled",
        "label": "Chỉ giao dịch trong khung giờ",
        "type": "bool",
        "default": false,
        "group": "Thời gian"
      },
      {
        "key": "trading_time_from",
        "label": "Từ (giờ VN)",
        "type": "time",
        "default": "06:00",
        "group": "Thời gian",
        "show_if": "trading_time_enabled"
      },
      {
        "key": "trading_time_to",
        "label": "Đến (giờ VN)",
        "type": "time",
        "default": "12:00",
        "group": "Thời gian",
        "show_if": "trading_time_enabled"
      }
    ]
  },
  "bollinger": {
    "name": "Bollinger",
    "color": "#a78bfa",
    "warmup_days": 4,
    "timeframes": "M15 → M1",
    "summary": "Vòng lặp xu hướng M15 theo độ dốc SMA20, nến M15 đóng ngoài biên, vào lệnh bằng cặp nến M1.",
    "steps": [
      "M15: Delta = SMA20[1] − SMA20[2]. |Delta| < ngưỡng → SIDEWAY, dừng; ≥ ngưỡng → TREND MẠNH, bắt đầu vòng lặp",
      "Trong vòng lặp: nến M15 đóng cùng chiều SMA20 và NGOÀI biên (TĂNG: > Upper, GIẢM: < Lower) → sang M1",
      "M1: Dist Upper − Lower < ngưỡng → sideway, không vào",
      "Cặp nến M1: nến 1 đóng cùng phía SMA20, nến 2 cùng phía + thân ≥ 70% → vào lệnh MARKET",
      "SL = đáy/đỉnh 10 nến trước nến 2 ± 0.1 (tối đa 10 giá) • TP = khoảng SL × R:R (đúng tỉ lệ nhập)",
      "Lệnh kết thúc → chờ nến M15 ngoài biên mới; vòng lặp kết thúc khi Delta đổi dấu"
    ],
    "fields": [
      {
        "key": "bb_delta_pips",
        "label": "Ngưỡng Delta SMA20 M15 (pip)",
        "type": "number",
        "default": 5,
        "min": 0.1,
        "step": 0.5,
        "group": "Thông số phương pháp"
      },
      {
        "key": "bb_width_m1_pips",
        "label": "Dist Upper − Lower M1 tối thiểu (pip)",
        "type": "number",
        "default": 30,
        "min": 0,
        "step": 1,
        "group": "Thông số phương pháp"
      },
      {
        "key": "initial_balance",
        "label": "Vốn ban đầu",
        "type": "number",
        "default": 10000,
        "min": 1,
        "step": 100,
        "group": "Quản lý lệnh"
      },
      {
        "key": "lot",
        "label": "Lot ban đầu",
        "type": "number",
        "default": 0.01,
        "min": 0.01,
        "step": 0.01,
        "group": "Quản lý lệnh"
      },
      {
        "key": "rr_risk",
        "label": "R:R – Risk",
        "type": "number",
        "default": 1.0,
        "min": 0.1,
        "step": 0.1,
        "group": "Quản lý lệnh"
      },
      {
        "key": "rr_reward",
        "label": "R:R – Reward",
        "type": "number",
        "default": 0.9,
        "min": 0.1,
        "step": 0.1,
        "group": "Quản lý lệnh"
      },
      {
        "key": "multi_lot",
        "label": "Sử dụng chuỗi lot",
        "type": "bool",
        "default": false,
        "group": "Quản lý lệnh",
        "help": "Thắng -> L1, thua -> L2, L3, L4, L5 (giữ L5 tới khi thắng)"
      },
      {
        "key": "lots",
        "label": "Chuỗi lot L1→L5",
        "type": "lots",
        "default": [
          0.01,
          0.02,
          0.04,
          0.08,
          0.16
        ],
        "group": "Quản lý lệnh",
        "show_if": "multi_lot"
      },
      {
        "key": "be",
        "label": "Tự dời SL về Entry (hòa vốn)",
        "type": "bool",
        "default": false,
        "group": "Bảo vệ lợi nhuận"
      },
      {
        "key": "be_trigger_pct",
        "label": "Hòa vốn khi đạt % TP",
        "type": "number",
        "default": 50,
        "min": 1,
        "max": 100,
        "group": "Bảo vệ lợi nhuận",
        "show_if": "be"
      },
      {
        "key": "trailing",
        "label": "Trailing stop khóa lời",
        "type": "bool",
        "default": false,
        "group": "Bảo vệ lợi nhuận"
      },
      {
        "key": "trailing_trigger_pct",
        "label": "Trailing khi đạt % TP",
        "type": "number",
        "default": 50,
        "min": 1,
        "max": 100,
        "group": "Bảo vệ lợi nhuận",
        "show_if": "trailing"
      },
      {
        "key": "trailing_lock_pct",
        "label": "Khóa % lợi nhuận",
        "type": "number",
        "default": 60,
        "min": 1,
        "max": 99,
        "group": "Bảo vệ lợi nhuận",
        "show_if": "trailing"
      },
      {
        "key": "friday_lock",
        "label": "Khóa lệnh cuối tuần (00:01 thứ 7)",
        "type": "bool",
        "default": false,
        "group": "Thời gian"
      },
      {
        "key": "trading_time_enabled",
        "label": "Chỉ giao dịch trong khung giờ",
        "type": "bool",
        "default": false,
        "group": "Thời gian"
      },
      {
        "key": "trading_time_from",
        "label": "Từ (giờ VN)",
        "type": "time",
        "default": "06:00",
        "group": "Thời gian",
        "show_if": "trading_time_enabled"
      },
      {
        "key": "trading_time_to",
        "label": "Đến (giờ VN)",
        "type": "time",
        "default": "12:00",
        "group": "Thời gian",
        "show_if": "trading_time_enabled"
      }
    ]
  },
  "adx": {
    "name": "ADX",
    "color": "#facc15",
    "warmup_days": 10,
    "timeframes": "H1 → M1",
    "summary": "ADX H1 < ngưỡng → chờ giá chọc thủng H1-High/Low, nến M1 xác nhận, đặt BUY/SELL STOP tại đỉnh/đáy M1.",
    "steps": [
      "H1 vừa đóng: ADX ≥ ngưỡng → thị trường mạnh, DỪNG (hủy lệnh chờ); ADX < ngưỡng → ghi H1-High / H1-Low",
      "MUA: giá M1 chọc thủng H1-Low ≥ N pip → chờ nến M1 XANH đóng trên H1-Low",
      "BÁN: giá M1 chọc thủng H1-High ≥ N pip → chờ nến M1 ĐỎ đóng dưới H1-High",
      "MUA đặt BUY STOP = giá đóng cửa đỉnh M1 gần nhất • BÁN đặt SELL STOP = giá đóng cửa đáy M1 gần nhất",
      "SL = đáy/đỉnh M1 gần nhất ± 0.1, 4–8 giá • TP = khoảng SL × R:R (đúng tỉ lệ nhập)",
      "Mỗi lần chọc thủng 1 lệnh; lệnh chờ chưa khớp khi hết giờ H1 → hủy"
    ],
    "fields": [
      {
        "key": "adx_period",
        "label": "Chu kỳ ADX (H1)",
        "type": "number",
        "default": 14,
        "min": 2,
        "step": 1,
        "group": "Thông số phương pháp"
      },
      {
        "key": "adx_max",
        "label": "Ngưỡng dừng ADX ≥",
        "type": "number",
        "default": 35,
        "min": 1,
        "step": 1,
        "group": "Thông số phương pháp"
      },
      {
        "key": "adx_method",
        "label": "Cách tính ADX",
        "type": "select",
        "default": "MT5",
        "options": [
          "MT5",
          "WILDER"
        ],
        "group": "Thông số phương pháp"
      },
      {
        "key": "pierce_pips",
        "label": "Chọc thủng H1 (pip)",
        "type": "number",
        "default": 50,
        "min": 0,
        "step": 5,
        "group": "Thông số phương pháp"
      },
      {
        "key": "swing_bars",
        "label": "Nến xác định đỉnh/đáy M1",
        "type": "number",
        "default": 2,
        "min": 1,
        "step": 1,
        "group": "Thông số phương pháp"
      },
      {
        "key": "initial_balance",
        "label": "Vốn ban đầu",
        "type": "number",
        "default": 10000,
        "min": 1,
        "step": 100,
        "group": "Quản lý lệnh"
      },
      {
        "key": "lot",
        "label": "Lot ban đầu",
        "type": "number",
        "default": 0.01,
        "min": 0.01,
        "step": 0.01,
        "group": "Quản lý lệnh"
      },
      {
        "key": "rr_risk",
        "label": "R:R – Risk",
        "type": "number",
        "default": 1.0,
        "min": 0.1,
        "step": 0.1,
        "group": "Quản lý lệnh"
      },
      {
        "key": "rr_reward",
        "label": "R:R – Reward",
        "type": "number",
        "default": 1.0,
        "min": 0.1,
        "step": 0.1,
        "group": "Quản lý lệnh"
      },
      {
        "key": "multi_lot",
        "label": "Sử dụng chuỗi lot",
        "type": "bool",
        "default": false,
        "group": "Quản lý lệnh",
        "help": "Thắng -> L1, thua -> L2, L3, L4, L5 (giữ L5 tới khi thắng)"
      },
      {
        "key": "lots",
        "label": "Chuỗi lot L1→L5",
        "type": "lots",
        "default": [
          0.01,
          0.02,
          0.04,
          0.08,
          0.16
        ],
        "group": "Quản lý lệnh",
        "show_if": "multi_lot"
      },
      {
        "key": "be",
        "label": "Tự dời SL về Entry (hòa vốn)",
        "type": "bool",
        "default": false,
        "group": "Bảo vệ lợi nhuận"
      },
      {
        "key": "be_trigger_pct",
        "label": "Hòa vốn khi đạt % TP",
        "type": "number",
        "default": 50,
        "min": 1,
        "max": 100,
        "group": "Bảo vệ lợi nhuận",
        "show_if": "be"
      },
      {
        "key": "trailing",
        "label": "Trailing stop khóa lời",
        "type": "bool",
        "default": false,
        "group": "Bảo vệ lợi nhuận"
      },
      {
        "key": "trailing_trigger_pct",
        "label": "Trailing khi đạt % TP",
        "type": "number",
        "default": 50,
        "min": 1,
        "max": 100,
        "group": "Bảo vệ lợi nhuận",
        "show_if": "trailing"
      },
      {
        "key": "trailing_lock_pct",
        "label": "Khóa % lợi nhuận",
        "type": "number",
        "default": 60,
        "min": 1,
        "max": 99,
        "group": "Bảo vệ lợi nhuận",
        "show_if": "trailing"
      },
      {
        "key": "friday_lock",
        "label": "Khóa lệnh cuối tuần (00:01 thứ 7)",
        "type": "bool",
        "default": false,
        "group": "Thời gian"
      },
      {
        "key": "trading_time_enabled",
        "label": "Chỉ giao dịch trong khung giờ",
        "type": "bool",
        "default": false,
        "group": "Thời gian"
      },
      {
        "key": "trading_time_from",
        "label": "Từ (giờ VN)",
        "type": "time",
        "default": "06:00",
        "group": "Thời gian",
        "show_if": "trading_time_enabled"
      },
      {
        "key": "trading_time_to",
        "label": "Đến (giờ VN)",
        "type": "time",
        "default": "12:00",
        "group": "Thời gian",
        "show_if": "trading_time_enabled"
      }
    ]
  },
  "sma_rsi": {
    "name": "SMA20 + RSI",
    "color": "#22d3ee",
    "warmup_days": 4,
    "timeframes": "H1 → M1",
    "summary": "Hướng theo Close H1 so với SMA20, vào lệnh theo chu kỳ RSI M1 70/30, có chốt lời sớm theo RSI.",
    "steps": [
      "H1 vừa đóng: Close > SMA20 → chỉ BUY • Close < SMA20 → chỉ SELL",
      "BUY: RSI vượt 70 rồi cắt xuống (điểm chờ mua) → RSI xuống dưới 30 rồi cắt lên, nến xác nhận RSI > 30 → VÀO",
      "SELL: RSI xuống dưới 30 rồi cắt lên (điểm chờ bán) → RSI vượt 70 rồi cắt xuống, nến xác nhận RSI < 70 → VÀO",
      "SL = đáy/đỉnh 10 nến ± 0.1, tối đa 80 pip • TP = khoảng SL × R:R",
      "Chốt lời sớm theo RSI: BUY đóng khi RSI > 70 rồi xuống dưới 70 • SELL đóng khi RSI < 30 rồi lên trên 30"
    ],
    "fields": [
      {
        "key": "sma_period",
        "label": "SMA khung H1",
        "type": "number",
        "default": 20,
        "min": 2,
        "step": 1,
        "group": "Thông số phương pháp"
      },
      {
        "key": "rsi_period",
        "label": "Chu kỳ RSI (M1)",
        "type": "number",
        "default": 14,
        "min": 2,
        "step": 1,
        "group": "Thông số phương pháp"
      },
      {
        "key": "rsi_high",
        "label": "RSI ngưỡng trên",
        "type": "number",
        "default": 70,
        "min": 51,
        "max": 99,
        "group": "Thông số phương pháp"
      },
      {
        "key": "rsi_low",
        "label": "RSI ngưỡng dưới",
        "type": "number",
        "default": 30,
        "min": 1,
        "max": 49,
        "group": "Thông số phương pháp"
      },
      {
        "key": "sl_lookback",
        "label": "Số nến tìm đáy/đỉnh SL",
        "type": "number",
        "default": 10,
        "min": 2,
        "step": 1,
        "group": "Thông số phương pháp"
      },
      {
        "key": "sl_max_pips",
        "label": "SL tối đa (pip)",
        "type": "number",
        "default": 80,
        "min": 1,
        "step": 5,
        "group": "Thông số phương pháp"
      },
      {
        "key": "rsi_exit",
        "label": "Chốt lời sớm theo RSI",
        "type": "bool",
        "default": true,
        "group": "Thông số phương pháp"
      },
      {
        "key": "initial_balance",
        "label": "Vốn ban đầu",
        "type": "number",
        "default": 10000,
        "min": 1,
        "step": 100,
        "group": "Quản lý lệnh"
      },
      {
        "key": "lot",
        "label": "Lot ban đầu",
        "type": "number",
        "default": 0.01,
        "min": 0.01,
        "step": 0.01,
        "group": "Quản lý lệnh"
      },
      {
        "key": "rr_risk",
        "label": "R:R – Risk",
        "type": "number",
        "default": 1.0,
        "min": 0.1,
        "step": 0.1,
        "group": "Quản lý lệnh"
      },
      {
        "key": "rr_reward",
        "label": "R:R – Reward",
        "type": "number",
        "default": 1.0,
        "min": 0.1,
        "step": 0.1,
        "group": "Quản lý lệnh"
      },
      {
        "key": "multi_lot",
        "label": "Sử dụng chuỗi lot",
        "type": "bool",
        "default": false,
        "group": "Quản lý lệnh",
        "help": "Thắng -> L1, thua -> L2, L3, L4, L5 (giữ L5 tới khi thắng)"
      },
      {
        "key": "lots",
        "label": "Chuỗi lot L1→L5",
        "type": "lots",
        "default": [
          0.01,
          0.02,
          0.04,
          0.08,
          0.16
        ],
        "group": "Quản lý lệnh",
        "show_if": "multi_lot"
      },
      {
        "key": "be",
        "label": "Tự dời SL về Entry (hòa vốn)",
        "type": "bool",
        "default": false,
        "group": "Bảo vệ lợi nhuận"
      },
      {
        "key": "be_trigger_pct",
        "label": "Hòa vốn khi đạt % TP",
        "type": "number",
        "default": 50,
        "min": 1,
        "max": 100,
        "group": "Bảo vệ lợi nhuận",
        "show_if": "be"
      },
      {
        "key": "trailing",
        "label": "Trailing stop khóa lời",
        "type": "bool",
        "default": false,
        "group": "Bảo vệ lợi nhuận"
      },
      {
        "key": "trailing_trigger_pct",
        "label": "Trailing khi đạt % TP",
        "type": "number",
        "default": 50,
        "min": 1,
        "max": 100,
        "group": "Bảo vệ lợi nhuận",
        "show_if": "trailing"
      },
      {
        "key": "trailing_lock_pct",
        "label": "Khóa % lợi nhuận",
        "type": "number",
        "default": 60,
        "min": 1,
        "max": 99,
        "group": "Bảo vệ lợi nhuận",
        "show_if": "trailing"
      },
      {
        "key": "friday_lock",
        "label": "Khóa lệnh cuối tuần (00:01 thứ 7)",
        "type": "bool",
        "default": false,
        "group": "Thời gian"
      },
      {
        "key": "trading_time_enabled",
        "label": "Chỉ giao dịch trong khung giờ",
        "type": "bool",
        "default": false,
        "group": "Thời gian"
      },
      {
        "key": "trading_time_from",
        "label": "Từ (giờ VN)",
        "type": "time",
        "default": "06:00",
        "group": "Thời gian",
        "show_if": "trading_time_enabled"
      },
      {
        "key": "trading_time_to",
        "label": "Đến (giờ VN)",
        "type": "time",
        "default": "12:00",
        "group": "Thời gian",
        "show_if": "trading_time_enabled"
      }
    ]
  }
};
