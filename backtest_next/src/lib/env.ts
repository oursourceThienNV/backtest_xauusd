/** Gốc URL gọi API: để trống = cùng origin (API nằm ngay trong dự án Next.js, src/app/api/**). */
export const ApiUrl = {
  get: () => (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/+$/, ''),
};
