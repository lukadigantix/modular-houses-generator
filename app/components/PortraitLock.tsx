'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

export default function PortraitLock() {
  const pathname = usePathname();
  const [isPortrait, setIsPortrait] = useState(false);

  useEffect(() => {
    const check = () => {
      setIsPortrait(window.matchMedia('(orientation: portrait)').matches);
    };
    check();
    const mq = window.matchMedia('(orientation: portrait)');
    mq.addEventListener('change', check);
    return () => mq.removeEventListener('change', check);
  }, []);

  // Only enforce on non-login pages and only on touch/tablet devices
  if (pathname === '/login' || !isPortrait) return null;

  return (
    <div
      style={{
        position:        'fixed',
        inset:           0,
        zIndex:          99999,
        background:      '#0a0a0a',
        display:         'flex',
        flexDirection:   'column',
        alignItems:      'center',
        justifyContent:  'center',
        gap:             24,
        color:           '#fff',
        fontFamily:      'sans-serif',
        textAlign:       'center',
        padding:         32,
      }}
    >
      {/* Rotate icon */}
      <svg
        width="72"
        height="72"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ opacity: 0.85 }}
      >
        <rect x="4" y="2" width="16" height="20" rx="2" />
        <path d="M9 21h6" />
        <path d="M17 7H7m0 0 3-3M7 7l3 3" />
      </svg>

      <p style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>
        Molimo okrenite uređaj
      </p>
      <p style={{ fontSize: 15, opacity: 0.6, margin: 0, maxWidth: 280 }}>
        Aplikacija radi samo u horizontalnom prikazu (landscape).
      </p>
    </div>
  );
}
