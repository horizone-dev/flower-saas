import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  // the authenticator screen shows a one-time secret: never cache it (browser, proxy or back/forward cache) and send no referrer
  async headers() {
    return [
      {
        source: '/security',
        headers: [
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
  transpilePackages: [
    '@flower/ui',
    '@flower/api-client',
    '@flower/shared-types',
    '@flower/i18n',
    '@flower/permissions',
  ],
};

export default config;
