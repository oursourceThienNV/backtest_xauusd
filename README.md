# VPS Backtest v2

## One database

Everything uses one MariaDB database:

`mt5_backtest`

Tables:
- `xauusd_m1`
- `users`
- `backtest_sessions`
- `decisions`

## Backend

```powershell
cd backend
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Swagger: http://127.0.0.1:8000/docs

Create the first user:

`POST /api/auth/register`

```json
{
  "username": "admin",
  "password": "your-password"
}
```

Password is stored as an Argon2id hash.

## Frontend

```powershell
cd frontend
copy .env.local.example .env.local
npm install
npm run dev
```

Open http://localhost:3000

## Backend .env

```env
APP_NAME=VPS Backtest API
JWT_SECRET=change-this-secret
JWT_EXPIRE_MINUTES=1440
DB_HOST=160.30.112.14
DB_PORT=3306
DB_NAME=mt5_backtest
DB_USER=root
DB_PASSWORD=BackTest@2026
CORS_ORIGINS=http://localhost:3000
```

## Current replay

Historical XAUUSD M1 -> MA Fast/Slow -> Cross -> EMA Trend -> Next.js chart.

Next phase:

MA Cross -> VPS `/trade/decision` -> BUY/SELL/BUY_LIMIT/SELL_LIMIT/NO TRADE -> virtual execution -> WIN/LOSS.
