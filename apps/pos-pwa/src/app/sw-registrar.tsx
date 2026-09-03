'use client';

import { useEffect } from 'react';

/** Registers the shell-precache service worker (Phase 0). */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') return;
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* registration is best-effort in Phase 0 */
    });
  }, []);
  return null;
}
