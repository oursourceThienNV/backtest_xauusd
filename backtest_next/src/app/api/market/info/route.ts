import { ok, readJson, route } from '@/server/http';
import { marketInfo } from '@/server/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Thông tin dữ liệu tick: symbol, ngày có dữ liệu. Body: { symbol? } */
export const POST = route(async (req) => ok(await marketInfo(await readJson(req))));
