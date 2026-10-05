from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session

from .config import settings
from .db import Base, engine, get_db
from .models import User, BacktestSession
from .schemas import LoginRequest, LoginResponse, ReplayRequest
from .security import hash_password, verify_password, create_token, get_current_user
from .indicators import build_crosses

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
            UNIX_TIMESTAMP(candle_time) AS time,
            open_price AS open,
            high_price AS high,
            low_price AS low,
            close_price AS close,
            tick_volume AS volume
        FROM xauusd_m1
        WHERE symbol LIKE :symbol_prefix
          AND timeframe = :tf
          AND candle_time BETWEEN :from_time AND :to_time
        ORDER BY candle_time ASC
    """)

    rows = db.execute(sql, {
        "symbol_prefix": f"{body.symbol}%",
        "tf": body.timeframe,
        "from_time": body.from_time,
        "to_time": body.to_time,
    }).mappings().all()

    candles = [dict(row) for row in rows]
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
