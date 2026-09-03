import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
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

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: ['error', 'warn', 'log'],
    bufferLogs: true,
  });

  app.setGlobalPrefix('v1', { exclude: ['healthz', 'readyz'] });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const openapi = new DocumentBuilder()
    .setTitle('Flower SaaS API')
    .setDescription('REST /v1 — multi-tenant florist commerce platform')
    .setVersion('0.0.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, openapi));

  await app.listen({ port: config.API_PORT, host: config.API_HOST });
  rootLogger.info(
    { port: config.API_PORT, host: config.API_HOST, env: config.NODE_ENV },
    'api listening',
  );

  const shutdown = (signal: string): void => {
    rootLogger.info({ signal }, 'shutting down');
    app
      .close()
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
