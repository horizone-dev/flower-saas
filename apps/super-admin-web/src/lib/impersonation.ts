import { cookies } from 'next/headers';
import { tokenApi } from './api';

const KEY = 'sa_imp';
const secure = process.env['NODE_ENV'] === 'production';

interface ImpersonationState {
  tenantId: string;
  token: string;
  exp: number;
}

export async function getImpersonation(): Promise<{ tenantId: string; token: string } | null> {
  const raw = (await cookies()).get(KEY)?.value;
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as ImpersonationState;
    if (s.exp < Date.now()) return null;
    return { tenantId: s.tenantId, token: s.token };
  } catch {
    return null;
  }
}

export async function setImpersonation(
  tenantId: string,
  token: string,
  expiresInSeconds: number,
): Promise<void> {
  const state: ImpersonationState = {
    tenantId,
    token,
    exp: Date.now() + expiresInSeconds * 1000,
  };
  (await cookies()).set(KEY, JSON.stringify(state), {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: expiresInSeconds,
  });
}

export async function clearImpersonation(): Promise<void> {
  const current = await getImpersonation();
  if (current) {
    await tokenApi(current.token)
      .endImpersonation()
      .catch(() => undefined);
  }
  (await cookies()).delete(KEY);
}
