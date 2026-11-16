import { ok, readJson, route } from '@/server/http';
import { runsList } from '@/server/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Lịch sử chạy. Body: { limit?, strategy? } */
export const POST = route(async (req) => ok(await runsList(await readJson(req))));
