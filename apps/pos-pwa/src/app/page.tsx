'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '@/lib/auth';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace(getToken() ? '/access' : '/login');
  }, [router]);
  return <p className="muted content">Loading…</p>;
}
