import { ok, readJson, route } from '@/server/http';
import { marketCandles } from '@/server/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Nến dựng từ tick. Body: { from_day, to_day, tf?, symbol? } */
export const POST = route(async (req) => ok(await marketCandles(await readJson(req))));
