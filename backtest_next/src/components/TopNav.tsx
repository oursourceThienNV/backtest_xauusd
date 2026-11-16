'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cls } from '@/lib/format';

const LINKS = [
  { href: '/backtest', label: 'Replay & Backtest' },
  { href: '/compare', label: 'So sánh 4 phương pháp' },
  { href: '/history', label: 'Lịch sử chạy' },
];

export default function TopNav({ right }: { right?: React.ReactNode }) {
  const path = usePathname();

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mini">V</div>
        <div>
          <strong>VPS BACKTEST</strong>
          <span>XAUUSD • TICK REPLAY</span>
        </div>
      </div>

      <nav className="nav-tabs">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={cls('nav-tab', path?.startsWith(l.href) && 'active')}>
            {l.label}
          </Link>
        ))}
      </nav>

      <div className="top-actions">
        {right}
      </div>
    </header>
  );
}
