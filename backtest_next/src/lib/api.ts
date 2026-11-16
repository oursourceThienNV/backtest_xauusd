/**
 * HTTP client dùng chung (giống Gia Phả): mọi API là POST trong cùng dự án,
 * server trả { responseCode: '00', responseMessage, body }.
 * post() trả thẳng `body`; lỗi -> ApiError có message tiếng Việt của server.
 */
export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function post<T = any>(url: string, body?: any): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('Không kết nối được máy chủ, kiểm tra mạng và thử lại', 0);
  }

  const data = await r.json().catch(() => null);
  if (!r.ok || !data || data.responseCode !== '00') {
    throw new ApiError(data?.responseMessage || data?.message || r.statusText || 'Đã có lỗi xảy ra!', r.status);
  }
  return data.body as T;
}

export function errorMessage(err: any, fallback = 'Đã có lỗi xảy ra!') {
  return err?.message || fallback;
}
