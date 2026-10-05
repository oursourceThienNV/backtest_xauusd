# MT5 XAUUSD Data Collector

Collector này chạy trên máy/VPS có MetaTrader 5 và kết nối tới MariaDB trên VPS Linux.

## 1. Cài Python

Khuyến nghị Python 3.11/3.12.

## 2. Cài dependencies

```bash
pip install -r requirements.txt
```

## 3. Cấu hình

Copy:

```text
.env.example -> .env
```

Điền:

- MT5_LOGIN
- MT5_PASSWORD
- MT5_SERVER
- MT5_PATH
- DB_HOST
- DB_PORT
- DB_NAME
- DB_USER
- DB_PASSWORD

## 4. Tạo bảng

Có thể chạy `schema.sql` trong DBeaver.

Collector cũng tự tạo bảng nếu chưa có.

## 5. Chạy

```bash
python collector.py
```

Lần đầu:
- Lấy khoảng 6 tháng dữ liệu tính tới hết ngày hôm qua.
- Dùng chunk 7 ngày.
- `INSERT IGNORE` để chống duplicate.

Lần chạy sau:
- Đọc candle mới nhất trong DB.
- Chỉ lấy phần dữ liệu sau candle đó.
- Nếu DB đã mới nhất thì không tải lại.

## Lưu ý về MT5

MetaTrader 5 Terminal phải được cài và đăng nhập tài khoản Exness.
Nếu symbol không phải đúng `XAUUSD`, collector sẽ thử tìm symbol bắt đầu bằng `XAUUSD`, ví dụ `XAUUSDm`.
