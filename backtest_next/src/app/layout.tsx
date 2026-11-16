import type { Metadata } from 'next';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'VPS Backtest',
  description: 'Phát lại thị trường XAUUSD từ tick thật và backtest 4 phương pháp giao dịch',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
