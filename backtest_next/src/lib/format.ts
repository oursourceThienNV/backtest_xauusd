const pad = (n: number) => String(n).padStart(2, '0');

/** epoch ms -> 'dd/mm hh:mm:ss' theo múi giờ offsetHours (0 = giờ MT5). */
export function fmtTime(ms: number | null | undefined, offsetHours = 0, withDate = true, withSec = true) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const d = new Date(ms + offsetHours * 3600_000);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${withSec ? ':' + pad(d.getUTCSeconds()) : ''}`;
  return withDate ? `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${time}` : time;
}

export function fmtDateTimeFull(ms: number, offsetHours = 0) {
  const d = new Date(ms + offsetHours * 3600_000);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
}

export function fmtMoney(v: number | null | undefined, sign = true) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!sign) return (v < 0 ? '-' : '') + s;
  return (v > 0 ? '+' : v < 0 ? '-' : '') + s;
}

export function fmtNum(v: number | null | undefined, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

export function fmtDuration(ms: number) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}p`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${pad(m % 60)}`;
  return `${Math.floor(h / 24)}d${pad(h % 24)}h`;
}

export function dayToMs(day: string) {
  return Date.parse(`${day}T00:00:00Z`);
}

export function msToDay(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number) {
  return msToDay(dayToMs(day) + n * 86400_000);
}

export function cls(...names: (string | false | null | undefined)[]) {
  return names.filter(Boolean).join(' ');
}

export function storageGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function storageSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* bỏ qua */
  }
}
