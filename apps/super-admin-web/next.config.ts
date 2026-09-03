import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  transpilePackages: [
    '@flower/ui',
    '@flower/api-client',
    '@flower/shared-types',
    '@flower/i18n',
    '@flower/permissions',
  ],
};

export default config;
