from datetime import datetime
from sqlalchemy import String, Boolean, DateTime, BigInteger, ForeignKey, Float, Text, JSON
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base

class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class BacktestSession(Base):
    __tablename__ = "backtest_sessions"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    symbol: Mapped[str] = mapped_column(String(32))
    timeframe: Mapped[str] = mapped_column(String(8), default="M1")
    from_time: Mapped[datetime] = mapped_column(DateTime)
    to_time: Mapped[datetime] = mapped_column(DateTime)
    ma_fast: Mapped[int] = mapped_column()
    ma_slow: Mapped[int] = mapped_column()
    ema_trend: Mapped[int] = mapped_column()
    status: Mapped[str] = mapped_column(String(20), default="READY")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class Decision(Base):
    __tablename__ = "decisions"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("backtest_sessions.id"), index=True)
    event_time: Mapped[datetime] = mapped_column(DateTime, index=True)
    cross_type: Mapped[str] = mapped_column(String(20))
    decision: Mapped[str] = mapped_column(String(30))
    payload: Mapped[dict] = mapped_column(JSON)
    response: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
