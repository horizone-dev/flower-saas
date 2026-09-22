import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { installRequestContext } from './common/context/index.js';
import { installRawBodyCapture } from './common/http/raw-body.js';
import { WebhookRecoveryProcessor } from './modules/payments/webhook-recovery.repository.js';
import { assertEveryRouteDeclaresIntent } from './common/auth/index.js';
import { assertNoIdempotencyOnCredentialRoutes } from './common/idempotency/index.js';
import { rootLogger } from './common/logger/logger.js';
import { loadConfig } from './config/env.js';

const CORRELATION_HEADER = 'x-correlation-id';

async function bootstrap(): Promise<void> {
  const config = loadConfig();

  const adapter = new FastifyAdapter({ trustProxy: true, genReqId: () => randomUUID() });

  // Correlation id: honour an inbound header, else use Fastify's request id.
  adapter.getInstance().addHook('onRequest', (request, reply, done) => {
    const inbound = request.headers[CORRELATION_HEADER];
    const correlationId = (Array.isArray(inbound) ? inbound[0] : inbound) ?? String(request.id);
    (request as { correlationId?: string }).correlationId = correlationId;
    void reply.header(CORRELATION_HEADER, correlationId);
    done();
  });

  // Establish the per-request RequestContext (ALS) before guards run. The auth
  // guard (task 1.5) layers the session's tenant/user/scope onto it.
  installRequestContext(adapter.getInstance());

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: ['error', 'warn', 'log'],
    bufferLogs: true,
  });

  app.setGlobalPrefix('v1', { exclude: ['healthz', 'readyz'] });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  // CORS for browser clients (the POS PWA). Protected API calls are Bearer
  // (Authorization header); `credentials: true` is needed only so the HttpOnly
  // refresh cookie flows on `/v1/auth/*` — the origin list is an explicit
  // allow-list (never `*`), so a credentialed cross-origin request from an
  // unknown page is rejected before it reaches a handler.
  const corsOrigins = config.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (corsOrigins.length > 0) {
    app.enableCors({
      origin: corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'authorization',
        'content-type',
        'idempotency-key',
        'x-auth-transport',
        CORRELATION_HEADER,
      ],
    });
  }

  // hard gate G8 — refuse to start if any route lacks @RequirePermission / @Public
  assertEveryRouteDeclaresIntent(app);
  // task 2.2 — refuse to start if @Idempotent is on an auth / credential route
  assertNoIdempotencyOnCredentialRoutes(app);

  const openapi = new DocumentBuilder()
    .setTitle('Flower SaaS API')
    .setDescription('REST /v1 — multi-tenant florist commerce platform')
    .setVersion('0.0.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, openapi));

  // `app.init()` is what actually registers Nest's own default
  // `application/json` body parser (lazily, not at adapter construction
  // time) — `installRawBodyCapture` must run AFTER that registration
  // exists, so it can replace it rather than collide with it. `app.listen`
  // below calls `init()` again, but it is idempotent once already
  // initialized.
  await app.init();
  installRawBodyCapture(adapter.getInstance());

  // task 3b.5 Checkpoint F reliability pass — the durable RECEIVED-webhook
  // recovery loop. Started ONLY here (never from `PaymentModule` itself),
  // so integration tests that bootstrap `AppModule` directly never get a
  // background poll loop; production, which runs through this file, does.
  const webhookRecovery = app.get(WebhookRecoveryProcessor);
  webhookRecovery.start(
    config.WEBHOOK_RECOVERY_TICK_INTERVAL_MS,
    config.WEBHOOK_RECOVERY_BATCH_SIZE,
  );

  await app.listen({ port: config.API_PORT, host: config.API_HOST });
  rootLogger.info(
    { port: config.API_PORT, host: config.API_HOST, env: config.NODE_ENV },
    'api listening',
  );

  const shutdown = (signal: string): void => {
    rootLogger.info({ signal }, 'shutting down');
    webhookRecovery
      .stop()
      .then(() => app.close())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        rootLogger.error({ err }, 'error during shutdown');
        process.exit(1);
      });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err: unknown) => {
  rootLogger.fatal({ err }, 'failed to start api');
  process.exit(1);
});
