from datetime import datetime
from pydantic import BaseModel, Field

class LoginRequest(BaseModel):
    username: str
    password: str

class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    username: str

class ReplayRequest(BaseModel):
    symbol: str = "XAUUSD"
    timeframe: str = "M1"
    from_time: datetime
    to_time: datetime
    ma_fast: int = Field(default=9, ge=1, le=500)
    ma_slow: int = Field(default=21, ge=2, le=500)
    ema_trend: int = Field(default=200, ge=2, le=1000)

class Candle(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: int = 0

class CrossEvent(BaseModel):
    index: int
    time: int
    type: str
    price: float
    ma_fast: float
    ma_slow: float
    ema_trend: float
    trend: str
