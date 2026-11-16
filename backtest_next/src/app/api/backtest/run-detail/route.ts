import { ok, readJson, route } from '@/server/http';
import { runDetail } from '@/server/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
/** Chi tiết 1 lần chạy (kèm đường chỉ báo). Body: { id, series? } */
export const POST = route(async (req) => ok(await runDetail(await readJson(req))));
