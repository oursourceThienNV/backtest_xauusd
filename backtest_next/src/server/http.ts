import 'server-only';
import { NextRequest, NextResponse } from 'next/server';

/** Cùng khuôn với Gia Phả: { responseCode, responseMessage, body } */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const badRequest = (m = 'Dữ liệu không hợp lệ') => new HttpError(400, m);
export const notFound = (m = 'Không tìm thấy dữ liệu') => new HttpError(404, m);

export function ok(body: any = true, message = 'Thành công') {
  return NextResponse.json({ responseCode: '00', responseMessage: message, body });
}

export function fail(status: number, message: string) {
  return NextResponse.json({ responseCode: String(status), responseMessage: message, message }, { status });
}

export async function readJson<T = any>(req: NextRequest): Promise<T> {
  try {
    const text = await req.text();
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw badRequest('JSON không hợp lệ');
  }
}

type Handler = (req: NextRequest, ctx: any) => Promise<Response>;

/** Bọc route: bắt lỗi, trả JSON thống nhất */
export function route(fn: Handler): Handler {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e: any) {
      if (e instanceof HttpError) return fail(e.status, e.message);
      console.error('[api]', req.nextUrl.pathname, e);
      return fail(500, e?.message ? `Lỗi máy chủ: ${e.message}` : 'Lỗi máy chủ, vui lòng thử lại sau');
    }
  };
}
