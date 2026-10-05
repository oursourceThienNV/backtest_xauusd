from typing import List

def sma(values: List[float], period: int):
    out = [None] * len(values)
    if period <= 0: return out
    running = 0.0
    for i, v in enumerate(values):
        running += v
        if i >= period: running -= values[i-period]
        if i >= period-1: out[i] = running / period
    return out

def ema(values, period):
    if not values:
        return []

    values = [float(v) if v is not None else None for v in values]

    k = 2.0 / (period + 1)
    result = [None] * len(values)

    if len(values) < period:
        return result

    seed = sum(values[:period]) / period
    result[period - 1] = seed

    for i in range(period, len(values)):
        seed = values[i] * k + seed * (1.0 - k)
        result[i] = seed

    return result

def build_crosses(candles, ma_fast_period, ma_slow_period, ema_period):
    closes = [c["close"] for c in candles]
    fast = ema(closes, ma_fast_period)
    slow = ema(closes, ma_slow_period)
    trend_ema = ema(closes, ema_period)
    crosses = []
    for i in range(1, len(candles)):
        if fast[i] is None or slow[i] is None or fast[i-1] is None or slow[i-1] is None:
            continue
        kind = None
        if fast[i-1] <= slow[i-1] and fast[i] > slow[i]: kind = "BUY_CROSS"
        elif fast[i-1] >= slow[i-1] and fast[i] < slow[i]: kind = "SELL_CROSS"
        if kind:
            trend = "NEUTRAL"
            if trend_ema[i] is not None:
                if closes[i] > trend_ema[i]: trend = "UPTREND"
                elif closes[i] < trend_ema[i]: trend = "DOWNTREND"
            crosses.append({"index": i, "time": candles[i]["time"], "type": kind, "price": closes[i], "ma_fast": fast[i], "ma_slow": slow[i], "ema_trend": trend_ema[i] or 0, "trend": trend})
    return fast, slow, trend_ema, crosses
