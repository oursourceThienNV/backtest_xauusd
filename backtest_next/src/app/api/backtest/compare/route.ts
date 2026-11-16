import { ok, readJson, route } from '@/server/http';
import { backtestCompare } from '@/server/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
/** So sánh nhiều phương pháp. Body: { from_day, to_day, strategies?, configs?, save? } */
export const POST = route(async (req) => ok(await backtestCompare(await readJson(req))));
