import { ok, route } from '@/server/http';
import { strategies } from '@/server/service';

export const runtime = 'nodejs';

/** Danh sách 4 phương pháp + ô cấu hình */
export const POST = route(async () => ok(strategies()));
