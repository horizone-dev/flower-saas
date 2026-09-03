import { describe, it, expect } from 'vitest';
import { HealthService } from './health.service.js';
import { DbService } from '../common/db/db.module.js';
import { loadConfig } from '../config/env.js';

// Point every dependency at a closed port so the probes deterministically fail;
// no DATABASE_URL, so the DB client construction throws -> db/migrations "down".
const unreachable = loadConfig({
  POSTGRES_HOST: '127.0.0.1',
  POSTGRES_PORT: '59991',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '59992',
  S3_ENDPOINT: 'http://127.0.0.1:59993',
});

const make = (): HealthService => new HealthService(unreachable, new DbService(unreachable));

describe('HealthService', () => {
  it('liveness is always ok', () => {
    expect(make().health()).toEqual({ status: 'ok' });
  });

  it('readiness reports every dependency and is "down" when all fail', async () => {
    const res = await make().readiness();
    expect(Object.keys(res.checks).sort()).toEqual(['db', 'migrations', 'redis', 'storage']);
    expect(res.checks['db']).toBe('down');
    expect(res.checks['migrations']).toBe('down');
    expect(res.status).toBe('down');
  });
});
