import { ok, readJson, route } from '@/server/http';
import { marketTicks } from '@/server/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Tick cho replay (nén gọn). Body: { from_ms, limit?, to_ms?, symbol? } */
export const POST = route(async (req) => ok(await marketTicks(await readJson(req))));
