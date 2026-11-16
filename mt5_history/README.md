# MT5 XAUUSD Data Collector

Collector chạy trên máy/VPS Windows có MetaTrader 5 (đã đăng nhập tài khoản) và ghi dữ liệu vào MariaDB.

## Chọn loại dữ liệu (`TIMEFRAME` trong `.env`)

| TIMEFRAME | Lưu gì | Bảng | Dùng khi |
|---|---|---|---|
| `TICK` | **Từng tick gốc**: bid, ask, thời gian tới mili-giây | `xauusd_ticks` | Muốn tái hiện đúng thị trường: giá chạy qua lại thế nào trong 1 phút, đúng thứ tự đã xảy ra |
| `S1` | Nến 1 giây dựng từ tick | `xauusd_s1` | Nhẹ hơn TICK, vẫn thấy biến động trong phút nhưng gộp theo giây |
| `M1`…`D1` | Nến gốc MT5 | `xauusd_m1`… | Như cũ |

## TICK — tái hiện thị trường thật

MT5 lưu mọi lần giá thay đổi mà server Exness gửi về (tick). Với `TIMEFRAME=TICK` collector lưu **nguyên vẹn**
từng tick, không gộp, không làm tròn thời gian:

- `tick_time`: thời điểm tick theo giờ MT5 (mili-giây); `time_msc`: epoch mili-giây
- `seq`: thứ tự nếu nhiều tick cùng 1 mili-giây
- `bid`, `ask`: giá mua/bán thật tại thời điểm đó (spread thật, kể cả lúc giãn khi ra tin)
- `volume`, `flags`: thông tin MT5 kèm theo

Một phút XAUUSD thường có vài chục đến vài trăm tick, lúc ra tin có thể hơn 1.000. Phát lại theo thứ tự
`time_msc, seq` là thấy đúng giá đã nhảy lên xuống thế nào, giống chế độ "Every tick based on real ticks"
trong Strategy Tester của MT5.

### Đảm bảo dữ liệu đúng thực tế

- **Lấy đủ tick:** MT5 có thể trả về tick chưa đầy đủ khi đang tải lịch sử từ server. Collector lấy lại mỗi ngày
  cho tới khi 2 lần liên tiếp ra cùng số tick (`FETCH_RETRIES`, mặc định 6 lần).
- **Đối chiếu với MT5:** sau mỗi ngày, collector dựng nến M1 từ tick rồi so với nến M1 gốc của MT5
  (`VERIFY_M1=1`). Log sẽ ghi:
  - `Verify M1 : OK 1,380/1,380 phút khớp 100% với MT5` → ngày đó đủ tick, đúng như thực tế.
  - `thiếu tick N phút` / `lệch OHLC N phút` → broker không có đủ tick cho khoảng đó, kèm các phút bị lệch.
    Thường gặp ở những ngày rất cũ. Mở chart XAUUSD trong MT5 cho tải lịch sử, rồi xoá dữ liệu ngày đó và chạy lại.
- Lưu đủ mọi trường MT5 trả về: `bid`, `ask`, `last`, `volume`, `volume_real`, `flags`, thời gian mili-giây.

Giới hạn duy nhất là MT5/Exness chỉ lưu tick (giá bid/ask). Không có lịch sử sổ lệnh (độ sâu thị trường)
và không có giá của các broker khác.

Dung lượng: khoảng 100–300 nghìn tick mỗi ngày → 6 tháng khoảng 15–40 triệu dòng (vài GB).

### Phát lại

```bash
# 1 phút lúc 14:30 giờ MT5 (= 21:30 giờ VN), tốc độ thật
python replay.py --start "2026-11-02 14:30:00" --minutes 1

# nhanh gấp 10 lần
python replay.py --start "2026-11-02 14:30:00" --minutes 5 --speed 10

# in ngay không chờ
python replay.py --start "2026-11-02 14:30:00" --speed 0

# xuất CSV
python replay.py --start "2026-11-02 14:30:00" --minutes 60 --csv out.csv
```

Trong code backtest có thể dùng `iter_ticks(conn, symbol, start, end)` trong `replay.py`: hàm này trả từng tick
theo đúng thứ tự thời gian, đọc theo trang nên chạy được khoảng dài mà không tốn RAM.

## S1 — nến 1 giây

Gộp tick theo từng giây: OHLC theo BID (hoặc ASK nếu `S1_PRICE=ASK`), `tick_volume` = số tick,
`spread` = spread nhỏ nhất trong giây. Giây không có tick thì không có nến.

## Cài đặt & chạy

```bash
pip install -r requirements.txt
```

Copy `.env.example` -> `.env`, điền thông tin DB, đặt `TIMEFRAME=TICK`.

```bash
python main.py
```

Mỗi lần chạy, collector kiểm tra **từng ngày** trong `MONTHS_BACK` tháng gần nhất (mặc định 2), tính tới 23:59:59 hôm qua giờ MT5:

- Ngày đã lấy xong → **bỏ qua**.
- Ngày chưa có (kể cả ngày bị thiếu ở giữa) → **lấy và thêm vào**.
- **Không bao giờ xoá dữ liệu cũ**, kể cả dữ liệu cũ hơn 2 tháng.
- `INSERT IGNORE` chống trùng, chạy lại bao nhiêu lần cũng không bị nhân đôi.

Những ngày đã xong được ghi vào bảng `sync_log`. Ngày chỉ được tính là xong khi:
- có tick và khớp nến M1 gốc của MT5 (`ok`), hoặc
- là thứ 7/chủ nhật không có giao dịch (`closed`).

Ngày thường mà 0 tick (nghỉ lễ, MT5 chưa tải) hoặc chưa khớp M1 thì **lần sau tự lấy lại**.
Cuối log có dòng `Sẽ lấy lại lần sau: ...` liệt kê những ngày đó.

Muốn lấy lại 1 ngày bất kỳ: xoá dòng ngày đó trong `sync_log` rồi chạy lại.

## Lưu ý

- Tick được lấy bằng `copy_ticks_from` theo trang 200.000 tick. Không dùng `copy_ticks_range` vì trên MT5 build 6230
  hàm này treo ~100 giây rồi báo `Terminal: Call failed`. Ngày nào MT5 lỗi sẽ được lấy lại ở lần chạy sau.

- Đây là tick thật của **Exness** (vàng spot không có sàn tập trung, broker khác sẽ lệch vài cent).
- Độ dài lịch sử tick phụ thuộc broker. Nếu ngày cũ trả về 0 tick, mở chart XAUUSD trong MT5,
  hoặc View → Symbols → Ticks để terminal tải tick về trước.
- **Thời gian theo giờ MT5** (server Exness = UTC, `TZ_OFFSET_HOURS=0`): 1 ngày = 00:00–23:59:59 giờ MT5,
  lấy tới 23:59:59 hôm qua giờ MT5. Khớp với chart và nến D1 trên MT5.
  Đổi sang giờ Việt Nam: **cộng 7 tiếng**, vd trong SQL: `DATE_ADD(tick_time, INTERVAL 7 HOUR)`.
  `time_msc` là epoch mili-giây (không phụ thuộc múi giờ).
- Collector tự tìm symbol có hậu tố của broker (vd `XAUUSDc`, `XAUUSDm`).
