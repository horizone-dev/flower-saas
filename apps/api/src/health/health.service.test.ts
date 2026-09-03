import { describe, it, expect } from 'vitest';
import { HealthService } from './health.service.js';
import { loadConfig } from '../config/env.js';

// Point every dependency at a closed port so the probes deterministically fail.
const unreachable = loadConfig({
  POSTGRES_HOST: '127.0.0.1',
  POSTGRES_PORT: '59991',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '59992',
  S3_ENDPOINT: 'http://127.0.0.1:59993',
});

describe('HealthService', () => {
  it('liveness is always ok', () => {
    expect(new HealthService(unreachable).health()).toEqual({ status: 'ok' });
  });

  it('readiness reports every dependency and is "down" when all fail', async () => {
    const res = await new HealthService(unreachable).readiness();
    expect(Object.keys(res.checks).sort()).toEqual(['db', 'migrations', 'redis', 'storage']);
    expect(res.checks['db']).toBe('down');
    expect(res.checks['migrations']).toBe('down');
    expect(res.status).toBe('down');
  });
});
