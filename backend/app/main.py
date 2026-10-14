from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
from .config import settings
from .db import Base, engine, get_db
from .models import User, BacktestSession
from .schemas import LoginRequest, LoginResponse, ReplayRequest
from .security import hash_password, verify_password, create_token, get_current_user
from .indicators import build_crosses
import calendar

@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield

app = FastAPI(title=settings.app_name, version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[x.strip() for x in settings.cors_origins.split(",") if x.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    return {"name": settings.app_name, "status": "running"}

@app.get("/api/health")
def health(db: Session = Depends(get_db)):
    db.execute(text("SELECT 1"))
    return {"status": "ok", "database": "connected"}

@app.post("/api/auth/register")
def register(body: LoginRequest, db: Session = Depends(get_db)):
    if db.query(User).filter(User.username == body.username).first():
        raise HTTPException(409, "Username already exists")
    user = User(username=body.username, password_hash=hash_password(body.password))
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"id": user.id, "username": user.username}

@app.post("/api/auth/login", response_model=LoginResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == body.username).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "Invalid username or password")
    return LoginResponse(access_token=create_token(user.id, user.username), username=user.username)

@app.get("/api/auth/me")
def me(user: User = Depends(get_current_user)):
    return {"id": user.id, "username": user.username}

@app.post("/api/replay/prepare")
def prepare_replay(
    body: ReplayRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if body.from_time >= body.to_time:
        raise HTTPException(400, "From time must be before To time")
    if body.ma_fast >= body.ma_slow:
        raise HTTPException(400, "MA Fast must be smaller than MA Slow")

    sql = text("""
        SELECT
            candle_time,
            open_price AS open,
            high_price AS high,
            low_price AS low,
            close_price AS close,
            tick_volume AS volume
        FROM xauusd_m1
        WHERE symbol LIKE :symbol_prefix
        AND timeframe = :tf
        AND candle_time >= :from_time
        AND candle_time < :end_time_exclusive
        ORDER BY candle_time ASC
    """)

    end_time_exclusive = body.to_time.replace(
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    ) + timedelta(days=1)

    rows = db.execute(sql, {
        "symbol_prefix": f"{body.symbol}%",
        "tf": body.timeframe,
        "from_time": body.from_time,
        "end_time_exclusive": end_time_exclusive,
    }).mappings().all()
    print("TOTAL ROWS:", len(rows))
    if rows:
        print("FIRST ROW:", dict(rows[0]))
        print("LAST ROW:", dict(rows[-1]))

    candles = []

    for row in rows:
        candle = dict(row)

        # Giữ nguyên thời gian đọc từ DB để đối chiếu
        db_time = candle["candle_time"]

        # Chuyển các thành phần giờ trong DB thành timestamp giây
        # theo quy ước UTC để biểu đồ hiển thị đúng giờ DB.
        candle["time"] = calendar.timegm(db_time.timetuple())

        # Trả thêm chuỗi thời gian gốc cho frontend
        candle["candle_time"] = db_time.strftime("%Y-%m-%d %H:%M:%S")

        candles.append(candle)
    if not candles:
        raise HTTPException(404, "No XAUUSD M1 data found for selected period")

    fast, slow, trend_ema, crosses = build_crosses(
        candles, body.ma_fast, body.ma_slow, body.ema_trend
    )

    session = BacktestSession(
        user_id=user.id,
        symbol=body.symbol,
        timeframe=body.timeframe,
        from_time=body.from_time,
        to_time=body.to_time,
        ma_fast=body.ma_fast,
        ma_slow=body.ma_slow,
        ema_trend=body.ema_trend,
        status="READY",
    )
    db.add(session)
    db.commit()
    db.refresh(session)

    enriched = []
    for i, candle in enumerate(candles):
        ema_value = trend_ema[i]
        if ema_value is None:
            trend = "NEUTRAL"
        elif candle["close"] > ema_value:
            trend = "UPTREND"
        elif candle["close"] < ema_value:
            trend = "DOWNTREND"
        else:
            trend = "NEUTRAL"

        enriched.append({
            **candle,
            "ma_fast": fast[i],
            "ma_slow": slow[i],
            "ema_trend": ema_value,
            "trend": trend,
        })

    return {
        "session_id": session.id,
        "candles": enriched,
        "crosses": crosses,
        "total_candles": len(enriched),
        "total_crosses": len(crosses),
    }
