import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { DbService } from '@flower/backend';
import { WorkerModule } from './worker.module.js';

/**
 * Proves the worker's Nest application context boots over `@flower/backend`
 * alone (no HTTP adapter, no controllers) and resolves a real backend service —
 * PHASE-2-CORE-PLAN §2.3 / HG-RUNTIME. `DbService` is lazy (it only opens a
 * Prisma client when `.appClient()` / `.platformClient()` is first called), so
 * this needs no database.
 */
describe('WorkerModule application context', () => {
  let ctx: INestApplicationContext | undefined;

  beforeEach(() => {
    process.env['NODE_ENV'] = 'test';
    process.env['LOG_LEVEL'] = 'silent';
  });

  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
    delete process.env['DATABASE_URL'];
  });

  it('boots as an application context (no HTTP listener) and resolves DbService', async () => {
    ctx = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
      abortOnError: false,
    });
    const db = ctx.get(DbService);
    expect(db).toBeInstanceOf(DbService);
  });

  it('DbService.appClient() fails closed with no DATABASE_URL configured', async () => {
    delete process.env['DATABASE_URL'];
    ctx = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
      abortOnError: false,
    });
    const db = ctx.get(DbService);
    expect(() => db.appClient()).toThrow(/DATABASE_URL/);
  });
});
