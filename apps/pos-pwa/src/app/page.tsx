'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getAccessToken, bootstrapSession } from '@/lib/auth';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    async function route(): Promise<void> {
      const ok = getAccessToken() !== null || (await bootstrapSession());
      if (!cancelled) router.replace(ok ? '/access' : '/login');
    }
    void route();
    return () => {
      cancelled = true;
    };
  }, [router]);
  return <p className="muted content">Loading…</p>;
}
