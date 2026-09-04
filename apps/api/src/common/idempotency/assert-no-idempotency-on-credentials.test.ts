import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller, Module, Post } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Public } from '../auth/public.decorator.js';
import {
  assertNoIdempotencyOnCredentialRoutes,
  IdempotencyMisconfiguredError,
} from './assert-no-idempotency-on-credentials.js';
import { Idempotent } from './idempotent.decorator.js';

@Controller('auth')
class BadAuthController {
  @Post('refresh')
  @Public()
  @Idempotent({ scope: 'auth.refresh' })
  refresh() {
    return { ok: true };
  }
}

@Controller('orders')
class GoodController {
  @Post()
  @Public()
  @Idempotent({ scope: 'orders.create' })
  create() {
    return { id: '1' };
  }
}

async function appWith(controller: unknown): Promise<NestFastifyApplication> {
  @Module({ imports: [DiscoveryModule], controllers: [controller as new () => unknown] })
  class M {}
  const ref = await Test.createTestingModule({ imports: [M] }).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1');
  await app.init();
  return app;
}

describe('assertNoIdempotencyOnCredentialRoutes', () => {
  let app: NestFastifyApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('throws when @Idempotent is on a credential-family route', async () => {
    app = await appWith(BadAuthController);
    expect(() => assertNoIdempotencyOnCredentialRoutes(app!)).toThrow(
      IdempotencyMisconfiguredError,
    );
  });

  it('passes for a normal domain route', async () => {
    app = await appWith(GoodController);
    expect(() => assertNoIdempotencyOnCredentialRoutes(app!)).not.toThrow();
  });
});
