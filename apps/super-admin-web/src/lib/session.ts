import { cookies } from 'next/headers';

/**
 * The Super Admin session is a first-party HttpOnly cookie (OD1) — never shared
 * with the tenant apps, its own base URL. Phase 1 stores the access + refresh
 * tokens directly; a later phase swaps to an opaque server session id.
 */
const ACCESS = 'sa_access';
const REFRESH = 'sa_refresh';

const secure = process.env['NODE_ENV'] === 'production';

export async function getAccessToken(): Promise<string | null> {
  return (await cookies()).get(ACCESS)?.value ?? null;
}

export async function getRefreshToken(): Promise<string | null> {
  return (await cookies()).get(REFRESH)?.value ?? null;
}

export async function setSession(accessToken: string, refreshToken?: string): Promise<void> {
  const jar = await cookies();
  jar.set(ACCESS, accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 12,
  });
  if (refreshToken) {
    jar.set(REFRESH, refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
  }
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(ACCESS);
  jar.delete(REFRESH);
}
