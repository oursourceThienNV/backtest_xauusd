import { ok, readJson, route } from '@/server/http';
import { runDelete } from '@/server/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Xóa 1 lần chạy. Body: { id } */
export const POST = route(async (req) => ok(await runDelete(await readJson(req))));
