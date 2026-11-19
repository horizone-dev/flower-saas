import type { NextConfig } from 'next';

/**
 * `API_PROXY_TARGET` (optional, build/start-time): proxy `/v1/*` to the API so the browser talks to ONE origin (no CORS, the HttpOnly refresh
 * cookie stays first-party). Used by the end-to-end rehearsal and by single-origin deployments; when unset, the app calls
 * `NEXT_PUBLIC_API_BASE_URL` directly (the API then needs `CORS_ORIGINS`).
 */
const apiProxyTarget = process.env['API_PROXY_TARGET'];

const config: NextConfig = {
  output: 'standalone',
  transpilePackages: [
    '@flower/ui',
    '@flower/api-client',
    '@flower/shared-types',
    '@flower/i18n',
    '@flower/permissions',
  ],
  async rewrites() {
    return apiProxyTarget
      ? [{ source: '/v1/:path*', destination: `${apiProxyTarget.replace(/\/+$/, '')}/v1/:path*` }]
      : [];
  },
};

export default config;
