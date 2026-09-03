import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { MinioContainer, type StartedMinioContainer } from '@testcontainers/minio';

/**
 * A running integration stack: Postgres 17 + Redis 7 + MinIO. Started once per
 * suite (`--no-file-parallelism`); torn down in `afterAll`. Mirrors the local
 * `docker-compose.yml` services the app actually uses (ARCHITECTURE §54).
 */
export interface TestStack {
  readonly postgres: {
    readonly container: StartedPostgreSqlContainer;
    /** direct connection string (app role posture is applied by the caller) */
    readonly url: string;
    readonly host: string;
    readonly port: number;
  };
  readonly redis: {
    readonly container: StartedRedisContainer;
    readonly url: string;
  };
  readonly minio: {
    readonly container: StartedMinioContainer;
    readonly endpoint: string;
    readonly accessKey: string;
    readonly secretKey: string;
  };
  stop(): Promise<void>;
}

export interface StartTestStackOptions {
  /** which services to start (default: all three) */
  readonly services?: ReadonlyArray<'postgres' | 'redis' | 'minio'>;
  readonly postgresDatabase?: string;
}

const IMAGES = {
  postgres: 'postgres:17',
  redis: 'redis:7',
  minio: 'minio/minio:RELEASE.2025-04-08T15-41-24Z',
} as const;

export async function startTestStack(options: StartTestStackOptions = {}): Promise<TestStack> {
  const want = new Set(options.services ?? (['postgres', 'redis', 'minio'] as const));

  const [pg, redis, minio] = await Promise.all([
    want.has('postgres')
      ? new PostgreSqlContainer(IMAGES.postgres)
          .withDatabase(options.postgresDatabase ?? 'flower_test')
          .withUsername('flower')
          .withPassword('flower_test')
          .start()
      : Promise.resolve(undefined),
    want.has('redis') ? new RedisContainer(IMAGES.redis).start() : Promise.resolve(undefined),
    want.has('minio') ? new MinioContainer(IMAGES.minio).start() : Promise.resolve(undefined),
  ]);

  const stopped: Array<() => Promise<unknown>> = [];
  if (pg) stopped.push(() => pg.stop());
  if (redis) stopped.push(() => redis.stop());
  if (minio) stopped.push(() => minio.stop());

  return {
    // non-null assertions: presence is guaranteed by `want` — callers request
    // only the services they use.
    postgres: pg
      ? {
          container: pg,
          url: pg.getConnectionUri(),
          host: pg.getHost(),
          port: pg.getPort(),
        }
      : (undefined as never),
    redis: redis ? { container: redis, url: redis.getConnectionUrl() } : (undefined as never),
    minio: minio
      ? {
          container: minio,
          endpoint: `http://${minio.getHost()}:${minio.getMappedPort(9000)}`,
          accessKey: minio.getUsername(),
          secretKey: minio.getPassword(),
        }
      : (undefined as never),
    async stop() {
      await Promise.allSettled(stopped.map((fn) => fn()));
    },
  };
}
