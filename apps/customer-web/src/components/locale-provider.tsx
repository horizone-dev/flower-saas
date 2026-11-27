'use client';

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Locale } from '@flower/i18n';
import { t as translate, type MessageKey } from '@/lib/i18n';

interface LocaleApi {
  locale: Locale;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

const Ctx = createContext<LocaleApi | null>(null);

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const api = useMemo<LocaleApi>(
    () => ({ locale, t: (key, params) => translate(locale, key, params) }),
    [locale],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useLocale(): LocaleApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLocale must be used inside LocaleProvider');
  return v;
}
