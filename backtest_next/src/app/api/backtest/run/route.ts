import { ok, readJson, route } from '@/server/http';
import { backtestRun } from '@/server/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
/** Chạy backtest 1 phương pháp. Body: { strategy, from_day, to_day, config?, label?, save? } */
export const POST = route(async (req) => ok(await backtestRun(await readJson(req))));
