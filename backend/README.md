# VPS Backtest Backend

## Setup
1. Create database with `schema.sql`.
2. Copy `.env.example` to `.env` and set MariaDB credentials.
3. `python -m venv venv`
4. Windows: `venv\\Scripts\\activate`
5. `pip install -r requirements.txt`
6. `uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`

The market database must contain the existing `xauusd_m1` table.
